import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  createValidation,
  getValidation,
  uploadEvidence,
  type AddressInput,
  type ValidationDto,
  type ValidationProgressDto,
} from '@/api/client'
import { Button, Card, CardContent, Input, Spinner } from '@/components/ui'
import { ValidationCard } from '@/components/validation-card'
import { ValidationProgress } from '@/components/validation/validation-progress'
import { FileUp, Search } from 'lucide-react'

/**
 * Vertical slice: executar UMA validação real de ponta a ponta pelo dashboard.
 *
 *   CNPJ/CPF + comprovante (PDF/imagem com QR NF3e)
 *     → POST /validations (mode 'fast' — 'auto'/'deep' exigem VLM_ENABLED,
 *       e a reavaliação do tick fiscal roda o deep enrichment de qualquer forma)
 *     → POST /validations/:id/evidence (upload do artefato)
 *     → polling GET /validations/:id até o resultado estabilizar
 *
 * A referência NF3e não é digitada: ela é extraída do QR do próprio comprovante
 * pelo backend (F1.2) e consultada pelo worker (F2.2b) — o browser nunca envia
 * dados fiscais como se fossem confiáveis.
 *
 * O polling não para no primeiro `completed`: o fast path conclui antes de o
 * worker processar o comprovante. Ele para quando as evidências chegaram E o
 * resultado parou de mudar entre duas leituras E não há reavaliação fiscal
 * pendente — `fiscal_reference = found` exige `fiscal_reassessment = completed`
 * (estado durável: o tick fiscal materializa a consulta ANTES de reavaliar, e
 * só `completed` garante que o veredito já reflete a evidência fiscal) — ou no
 * teto de tempo. Comprovante sem QR (`fiscal_reference` ≠ found) conclui
 * normalmente, sem esperar uma consulta que não vai acontecer.
 */

/** Teto de acompanhamento: uma validação `partial` pode não estabilizar nunca. */
const MAX_WATCH_MS = 120_000
const POLL_INTERVAL_MS = 2_000

/**
 * Estado inicial real do fluxo: o upload acabou de ser aceito e o worker ainda
 * não devolveu a primeira leitura. Não é uma animação — assim que o GET traz
 * `progress`, esta representação é substituída pelo estado durável.
 */
const INITIAL_PROGRESS: ValidationProgressDto = {
  status: 'in_progress',
  steps: [
    { stage: 'reading_document', status: 'in_progress' },
    { stage: 'reading_qr', status: 'pending' },
    { stage: 'consulting_provider', status: 'pending' },
    { stage: 'verifying_authenticity', status: 'pending' },
    { stage: 'comparing_evidence', status: 'pending' },
  ],
}

const evidenceArrived = (v: ValidationDto): boolean =>
  v.evidence_verification != null || v.fiscal_verification != null

/** Reavaliação fiscal esperada e ainda não concluída (estado durável do GET). */
const fiscalPending = (v: ValidationDto): boolean =>
  v.fiscal_reference === 'found' && v.fiscal_reassessment !== 'completed'

const hardTerminal = (v: ValidationDto): boolean => v.status === 'failed' || v.status === 'expired'

const snapshotOf = (v: ValidationDto): string =>
  JSON.stringify([
    v.status,
    v.verdict,
    v.score,
    v.confidence,
    v.evidence_summary,
    v.evidence_verification != null,
    v.fiscal_verification != null,
  ])

/**
 * Campos do endereço capturados no dashboard quando o documento é um CPF.
 * `bairro` é opcional; os demais são exigidos pelo fluxo do CNEFE
 * (`logradouro`, `numero`, `municipio`, `uf` e `cep`).
 */
interface AddressForm {
  readonly logradouro: string
  readonly numero: string
  readonly bairro: string
  readonly municipio: string
  readonly uf: string
  readonly cep: string
}

const emptyAddress: AddressForm = {
  logradouro: '',
  numero: '',
  bairro: '',
  municipio: '',
  uf: '',
  cep: '',
}

const isCpfDocument = (document: string): boolean => document.replace(/\D+/g, '').length === 11

export interface E2eRunnerDeps {
  readonly create?: (document: string, address?: AddressInput | null) => Promise<ValidationDto>
  readonly upload?: (validationId: string, file: File) => Promise<unknown>
  readonly poll?: (validationId: string) => Promise<ValidationDto>
  /** Intervalo de polling; testes usam valores curtos. */
  readonly pollIntervalMs?: number
}

export function E2eRunner({ deps }: { deps?: E2eRunnerDeps }) {
  const create =
    deps?.create ??
    ((document: string, address?: AddressInput | null) => createValidation(document, 'fast', address))
  const upload = deps?.upload ?? uploadEvidence
  const poll = deps?.poll ?? getValidation
  const pollIntervalMs = deps?.pollIntervalMs ?? POLL_INTERVAL_MS

  const [document, setDocument] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [address, setAddress] = useState<AddressForm>(emptyAddress)
  const [activeId, setActiveId] = useState<string | null>(null)
  /** Acompanhamento encerrado. Definido SÓ pela regra de parada do polling/timeout. */
  const [stopped, setStopped] = useState(false)

  const startedAtRef = useRef(0)
  const snapshotRef = useRef<string | null>(null)

  const isCpf = isCpfDocument(document)
  const addressReady =
    address.logradouro.trim() !== '' &&
    address.numero.trim() !== '' &&
    address.municipio.trim() !== '' &&
    address.uf.trim() !== '' &&
    address.cep.trim() !== ''

  /**
   * Só envia `address` quando o documento é um CPF e o usuário preencheu os
   * campos que o CNEFE consegue consumir. Sem isso, a API continuaria devolvendo
   * `ADDRESS_REQUIRED_FOR_CPF` (regra preservada no backend).
   */
  const addressPayload: AddressInput | null =
    isCpf && addressReady
      ? {
          logradouro: address.logradouro.trim(),
          numero: address.numero.trim(),
          ...(address.bairro.trim() !== '' ? { bairro: address.bairro.trim() } : {}),
          municipio: address.municipio.trim(),
          uf: address.uf.trim(),
          cep: address.cep.trim(),
        }
      : null

  const setAddressField = (field: keyof AddressForm, value: string): void =>
    setAddress((prev) => ({ ...prev, [field]: value }))

  const mutation = useMutation({
    mutationFn: async () => {
      const created = await create(document.trim(), addressPayload)
      if (file !== null) await upload(created.validation_id, file)
      return created
    },
    onSuccess: (created) => {
      setActiveId(created.validation_id)
      startedAtRef.current = Date.now()
      snapshotRef.current = null
      setStopped(false)
      setDocument('')
      setFile(null)
      setAddress(emptyAddress)
    },
  })

  const validation = useQuery({
    queryKey: ['e2e-validation', activeId],
    enabled: activeId !== null,
    initialData: mutation.data ?? undefined,
    refetchInterval: (query) => {
      const data = query.state.data as ValidationDto | undefined
      if (data === undefined) return pollIntervalMs
      // Única regra de parada (fonte da verdade, também para o estado `stopped`):
      // terminal duro, teto de tempo, ou evidências chegaram + leitura inalterada
      // + reavaliação fiscal (quando esperada) já concluída. Enquanto
      // `fiscal_reference = found` sem `fiscal_reassessment = completed`, não
      // encerra: a consulta e o assessment novo ainda estão no ar — o GET expõe
      // a evidência fiscal antes de o deepEnrich commitar, com o veredito antigo.
      const stop =
        hardTerminal(data) ||
        Date.now() - startedAtRef.current > MAX_WATCH_MS ||
        (evidenceArrived(data) && !fiscalPending(data) && snapshotRef.current === snapshotOf(data))
      snapshotRef.current = snapshotOf(data)
      if (stop) {
        setStopped(true)
        return false
      }
      return pollIntervalMs
    },
    queryFn: () => (activeId === null ? Promise.reject(new Error('no active validation')) : poll(activeId)),
    retry: false,
  })

  useEffect(() => {
    if (activeId === null) return
    const timer = setTimeout(() => setStopped(true), MAX_WATCH_MS)
    return () => clearTimeout(timer)
  }, [activeId])

  const running = mutation.isPending
  const active = validation.data as ValidationDto | undefined

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div>
          <h3 className="text-sm font-semibold">Validação completa — comprovante + NF3e</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Envia o comprovante (PDF/imagem). A referência NF3e é lida do QR do próprio documento e consultada
            pelo worker; o resultado aparece abaixo sozinho.
          </p>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (document.trim() && file !== null) mutation.mutate()
          }}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="CPF ou CNPJ do endereço a validar"
                value={document}
                onChange={(e) => setDocument(e.target.value)}
                className="pl-9 font-mono text-sm"
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-input px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent">
              <FileUp className="h-4 w-4" aria-hidden />
              <span>{file === null ? 'Escolher comprovante' : file.name}</span>
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>
          {isCpf && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Input
                className="col-span-2"
                placeholder="Logradouro"
                aria-label="Logradouro"
                value={address.logradouro}
                onChange={(e) => setAddressField('logradouro', e.target.value)}
              />
              <Input
                placeholder="Número"
                aria-label="Número"
                value={address.numero}
                onChange={(e) => setAddressField('numero', e.target.value)}
              />
              <Input
                placeholder="Bairro (opcional)"
                aria-label="Bairro"
                value={address.bairro}
                onChange={(e) => setAddressField('bairro', e.target.value)}
              />
              <Input
                placeholder="Município"
                aria-label="Município"
                value={address.municipio}
                onChange={(e) => setAddressField('municipio', e.target.value)}
              />
              <Input
                placeholder="UF"
                aria-label="UF"
                value={address.uf}
                onChange={(e) => setAddressField('uf', e.target.value)}
              />
              <Input
                placeholder="CEP"
                aria-label="CEP"
                value={address.cep}
                onChange={(e) => setAddressField('cep', e.target.value)}
              />
            </div>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={running || !document.trim() || file === null} className="px-5">
              {running ? <Spinner /> : 'Iniciar validação'}
            </Button>
          </div>
        </form>

        {mutation.isError && (
          <p className="text-sm text-destructive" role="alert">
            {mutation.error instanceof Error ? mutation.error.message : 'Erro desconhecido'}
          </p>
        )}

        {!stopped && active !== undefined && (
          <ValidationProgress progress={active.progress ?? INITIAL_PROGRESS} validation={active} />
        )}

        {stopped && active !== undefined && (
          <div className="space-y-3">
            {active.progress != null && active.progress.status !== 'completed' && (
              <ValidationProgress progress={active.progress} validation={active} compact />
            )}
            {active.status !== 'completed' && (
              <p className="text-xs text-muted-foreground">
                {hardTerminal(active)
                  ? `Validação terminou com status "${active.status}".`
                  : 'Acompanhamento encerrado; o resultado abaixo é a leitura mais recente (a validação pode continuar evoluindo no worker).'}
              </p>
            )}
            <ValidationCard validation={active} defaultExpanded={false} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
