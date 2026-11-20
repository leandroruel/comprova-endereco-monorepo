import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Clock, FileText, Send, Trash2, Upload } from 'lucide-react'
import {
  deleteHolderDocument,
  getHolderAccess,
  getHolderProcessing,
  HolderApiError,
  registerHolderConsent,
  saveHolderItem,
  submitHolderRequest,
  uploadHolderDocument,
  type HolderAccessItem,
  type HolderAccessView,
} from '../api/holder-access'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Spinner,
} from '../components/ui'
import { cn } from '../lib/utils'

type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'info' | 'outline'

function Badge({
  className,
  variant = 'default',
  ...props
}: React.ComponentPropsWithRef<'span'> & { variant?: BadgeVariant }) {
  const variants: Record<BadgeVariant, string> = {
    default: 'bg-primary text-primary-foreground',
    secondary: 'bg-secondary text-secondary-foreground',
    success: 'bg-emerald-100 text-emerald-800',
    warning: 'bg-amber-100 text-amber-800',
    destructive: 'bg-red-100 text-red-800',
    info: 'bg-blue-100 text-blue-800',
    outline: 'border border-border text-foreground',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
        variants[variant],
        className,
      )}
      {...props}
    />
  )
}

const STATUS: Record<string, { label: string; variant: BadgeVariant; description: string }> = {
  aguardando_consentimento: {
    label: 'Aguardando seu consentimento',
    variant: 'warning',
    description: 'Leia e aceite os termos para enviar documentos.',
  },
  aguardando_documentos: {
    label: 'Aguardando envio do documento',
    variant: 'info',
    description: 'Consentimento registrado. Envie os documentos solicitados.',
  },
  documento_recebido: {
    label: 'Documento recebido',
    variant: 'info',
    description: 'Documento recebido. Revise os itens e envie a solicitação.',
  },
  processando: {
    label: 'Analisando documento',
    variant: 'warning',
    description: 'A solicitação foi enviada e está sendo processada.',
  },
  concluída: {
    label: 'Processamento concluído',
    variant: 'success',
    description: 'Você concluiu o envio. O Verifier fará a análise.',
  },
  expirada: {
    label: 'Solicitação expirada',
    variant: 'outline',
    description: 'O prazo desta solicitação venceu. Solicite um novo link ao Verifier.',
  },
  encerrada: {
    label: 'Solicitação encerrada',
    variant: 'outline',
    description: 'Esta solicitação foi cancelada pelo Verifier.',
  },
}

const errorMessage = (error: unknown): string => {
  if (error instanceof HolderApiError) {
    switch (error.code) {
      case 'HOLDER_ACCESS_UNAUTHORIZED':
        return 'Este link é inválido, expirou ou foi revogado. Solicite um novo link ao Verifier.'
      case 'HOLDER_INFORMATION_REQUEST_EXPIRED':
        return 'Esta solicitação expirou. Solicite um novo link ao Verifier.'
      case 'HOLDER_INFORMATION_REQUEST_CANCELLED':
        return 'Esta solicitação foi cancelada pelo Verifier.'
      case 'HOLDER_CONSENT_REQUIRED':
        return 'Aceite os termos antes de enviar documentos.'
      case 'HOLDER_TERMS_NOT_APPROVED':
        return 'O conteúdo dos termos ainda não está disponível para aceite. Tente novamente mais tarde.'
      case 'HOLDER_TERMS_VERSION_MISMATCH':
        return 'A versão dos termos mudou. Recarregue a página para ver a versão vigente.'
      case 'EVIDENCE_TOO_LARGE':
        return 'O arquivo excede o limite de tamanho permitido.'
      case 'UNSUPPORTED_EVIDENCE_TYPE':
        return 'Tipo de arquivo não suportado. Envie PDF, JPEG ou PNG.'
      case 'EVIDENCE_CONTENT_MISMATCH':
        return 'O conteúdo do arquivo não corresponde ao tipo informado.'
      case 'HOLDER_REQUIRED_ITEMS_MISSING':
        return 'Preencha todos os itens obrigatórios antes de enviar.'
      default:
        return error.message
    }
  }
  return 'Não foi possível concluir a operação. Verifique sua conexão e tente novamente.'
}

const formatDate = (value: string | null): string => {
  if (value === null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const isMutable = (view: HolderAccessView): boolean =>
  view.state === 'pending' || view.state === 'in_progress'

const isTerminal = (view: HolderAccessView): boolean =>
  view.state === 'completed' || view.state === 'cancelled' || view.state === 'expired'

const termsAvailable = (view: HolderAccessView): boolean =>
  view.terms.version !== null && view.terms.approved && view.terms.documentHash !== null

const missingRequiredItems = (view: HolderAccessView): readonly string[] =>
  view.items
    .filter((item) => {
      if (!item.required) return false
      if (item.documentType !== undefined && item.documentType.trim() !== '') {
        return item.documents.length === 0
      }
      return item.value === null || item.value.trim() === ''
    })
    .map((item) => item.description)

interface HolderAccessPageProps {
  readonly token?: string | null
}

export function HolderAccessPage({ token = null }: HolderAccessPageProps) {
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [files, setFiles] = useState<Record<string, File | undefined>>({})
  const [valueDrafts, setValueDrafts] = useState<Record<string, string>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const viewQuery = useQuery({
    queryKey: ['holder-access', token],
    queryFn: () => getHolderAccess(token!),
    enabled: token !== null,
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === 'processando' ? 5_000 : false),
  })

  const view = viewQuery.data

  const processingQuery = useQuery({
    queryKey: ['holder-access-processing', token, view?.requestId],
    queryFn: () => getHolderProcessing(token!, view!.requestId),
    enabled: token !== null && view !== undefined && view.state === 'completed',
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === 'awaiting' || query.state.data?.state === 'processing' ? 5_000 : false,
  })

  const consentMutation = useMutation({
    mutationFn: async () => {
      if (view === undefined || view.terms.version === null) {
        throw new Error('terms unavailable')
      }
      return registerHolderConsent(token!, view.terms.version)
    },
    onSuccess: async () => {
      setActionError(null)
      setNotice('Consentimento registrado. Você já pode enviar os documentos.')
      setAcceptedTerms(false)
      await viewQuery.refetch()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const uploadMutation = useMutation({
    mutationFn: ({ itemId, file }: { itemId: string; file: File }) =>
      uploadHolderDocument(token!, itemId, file),
    onSuccess: async (_result, variables) => {
      setActionError(null)
      setNotice('Documento enviado com sucesso.')
      setFiles((current) => ({ ...current, [variables.itemId]: undefined }))
      await viewQuery.refetch()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const saveValueMutation = useMutation({
    mutationFn: ({ itemId, value }: { itemId: string; value: string }) =>
      saveHolderItem(token!, itemId, value),
    onSuccess: async () => {
      setActionError(null)
      setNotice('Resposta salva.')
      await viewQuery.refetch()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const deleteMutation = useMutation({
    mutationFn: ({ itemId, documentId }: { itemId: string; documentId: string }) =>
      deleteHolderDocument(token!, itemId, documentId),
    onSuccess: async () => {
      setActionError(null)
      setNotice('Documento removido.')
      await viewQuery.refetch()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const submitMutation = useMutation({
    mutationFn: () => submitHolderRequest(token!),
    onSuccess: async () => {
      setActionError(null)
      setNotice('Solicitação enviada. Acompanhe o processamento abaixo.')
      await viewQuery.refetch()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const missing = useMemo(() => (view === undefined ? [] : missingRequiredItems(view)), [view])

  if (token === null) {
    return (
      <PublicShell>
        <StatusCard
          title="Link inválido"
          variant="destructive"
          message="O link de acesso não contém um token válido. Solicite um novo link ao Verifier."
        />
      </PublicShell>
    )
  }

  if (viewQuery.isLoading) {
    return (
      <PublicShell>
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Spinner />
          Carregando solicitação…
        </div>
      </PublicShell>
    )
  }

  if (viewQuery.isError || view === undefined) {
    return (
      <PublicShell>
        <StatusCard
          title="Não foi possível abrir a solicitação"
          variant="destructive"
          message={errorMessage(viewQuery.error)}
        />
      </PublicShell>
    )
  }

  const status = STATUS[view.status] ?? {
    label: view.status,
    variant: 'secondary' as BadgeVariant,
    description: '',
  }
  const terminal = isTerminal(view)
  const mutable = isMutable(view)
  const consentGranted = view.consent.granted
  const canConsent = mutable && !consentGranted && termsAvailable(view)

  return (
    <PublicShell>
      <Card className="w-full max-w-3xl border-border shadow-lg">
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-xl">Solicitação de comprovação de endereço</CardTitle>
              <CardDescription>{view.purpose}</CardDescription>
            </div>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            <span>Tipo: {view.type}</span>
            <span>Prazo: {formatDate(view.expiresAt)}</span>
            {view.completedAt !== null ? <span>Enviada em: {formatDate(view.completedAt)}</span> : null}
          </div>
          {status.description.length > 0 ? (
            <p className="text-sm text-muted-foreground">{status.description}</p>
          ) : null}
        </CardHeader>

        <CardContent className="space-y-6">
          {actionError !== null ? (
            <Notice variant="destructive" message={actionError} />
          ) : notice !== null ? (
            <Notice variant="success" message={notice} />
          ) : null}

          {view.state === 'expired' ? (
            <Notice
              variant="warning"
              message={`Esta solicitação expirou em ${formatDate(view.expiresAt)} e não aceita mais envios.`}
            />
          ) : null}
          {view.state === 'cancelled' ? (
            <Notice variant="warning" message="Esta solicitação foi cancelada pelo Verifier." />
          ) : null}

          {!consentGranted && mutable ? (
            <section className="space-y-3 rounded-lg border border-border p-4">
              <h2 className="text-sm font-semibold">Consentimento</h2>
              {termsAvailable(view) ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Para enviar documentos, aceite explicitamente os termos apresentados pelo Verifier. O
                    aceite é registrado com a versão vigente e a data/hora do servidor.
                  </p>
                  <dl className="grid gap-1 text-xs text-muted-foreground">
                    <div className="flex gap-2">
                      <dt className="font-medium text-foreground">Versão dos termos:</dt>
                      <dd>{view.terms.version}</dd>
                    </div>
                    <div className="flex gap-2 break-all">
                      <dt className="font-medium text-foreground">Identificador do documento:</dt>
                      <dd className="font-mono">{view.terms.documentHash}</dd>
                    </div>
                  </dl>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={acceptedTerms}
                      onChange={(event) => setAcceptedTerms(event.target.checked)}
                      disabled={consentMutation.isPending}
                    />
                    <span>
                      Li e aceito a versão {view.terms.version} dos termos aplicáveis a esta solicitação.
                    </span>
                  </label>
                  <Button
                    type="button"
                    disabled={!acceptedTerms || !canConsent || consentMutation.isPending}
                    onClick={() => consentMutation.mutate()}
                  >
                    {consentMutation.isPending ? 'Registrando…' : 'Aceitar e continuar'}
                  </Button>
                </>
              ) : (
                <Notice
                  variant="warning"
                  message="O conteúdo jurídico dos termos ainda não foi aprovado. O aceite está temporariamente indisponível e nenhum consentimento será registrado."
                />
              )}
            </section>
          ) : null}

          {consentGranted ? (
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                Consentimento registrado
                {view.consent.termsVersion !== null ? ` (versão ${view.consent.termsVersion})` : ''}
                {view.consent.acceptedAt !== null ? ` em ${formatDate(view.consent.acceptedAt)}` : ''}.
              </div>
            </section>
          ) : null}

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Itens solicitados</h2>
            <div className="space-y-3">
              {view.items.map((item) => (
                <ItemCard
                  key={item.itemId}
                  item={item}
                  disabled={!mutable || !consentGranted}
                  file={files[item.itemId]}
                  valueDraft={valueDrafts[item.itemId] ?? item.value ?? ''}
                  onFileChange={(file) => setFiles((current) => ({ ...current, [item.itemId]: file }))}
                  onValueChange={(value) =>
                    setValueDrafts((current) => ({ ...current, [item.itemId]: value }))
                  }
                  onUpload={() => {
                    const file = files[item.itemId]
                    if (file !== undefined) uploadMutation.mutate({ itemId: item.itemId, file })
                  }}
                  onSaveValue={() =>
                    saveValueMutation.mutate({
                      itemId: item.itemId,
                      value: valueDrafts[item.itemId] ?? item.value ?? '',
                    })
                  }
                  onDelete={(documentId) => deleteMutation.mutate({ itemId: item.itemId, documentId })}
                  busy={uploadMutation.isPending || saveValueMutation.isPending || deleteMutation.isPending}
                />
              ))}
            </div>
          </section>

          {mutable ? (
            <section className="space-y-2 border-t border-border pt-4">
              {missing.length > 0 ? (
                <p className="text-xs text-muted-foreground">Pendente(s): {missing.join(', ')}.</p>
              ) : null}
              <Button
                type="button"
                className="w-full"
                disabled={
                  !consentGranted ||
                  missing.length > 0 ||
                  submitMutation.isPending ||
                  uploadMutation.isPending ||
                  saveValueMutation.isPending
                }
                onClick={() => submitMutation.mutate()}
              >
                <Send className="h-4 w-4" />
                {submitMutation.isPending ? 'Enviando…' : 'Enviar solicitação'}
              </Button>
            </section>
          ) : null}

          {terminal ? (
            <section className="space-y-2 rounded-lg border border-border p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Clock className="h-4 w-4" /> Acompanhamento
              </h2>
              {view.state === 'completed' ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    O envio foi concluído. O processamento dos documentos é uma etapa separada e não
                    representa aprovação do endereço.
                  </p>
                  <ProcessingStatus
                    processing={processingQuery.data ?? null}
                    loading={processingQuery.isLoading}
                  />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {view.state === 'expired'
                    ? 'Solicitação expirada: não é possível enviar ou alterar documentos.'
                    : 'Solicitação encerrada: não é possível enviar ou alterar documentos.'}
                </p>
              )}
            </section>
          ) : null}

          <p className="text-xs text-muted-foreground">
            O envio de documentos não comprova automaticamente o endereço. A análise é feita pelo Verifier com
            base nas evidências e nas regras aplicáveis.
          </p>
        </CardContent>
      </Card>
    </PublicShell>
  )
}

function PublicShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-start justify-center bg-background p-4 sm:items-center">
      <div className="w-full max-w-3xl">
        <div className="mb-6 text-center">
          <span className="text-2xl font-bold tracking-tight">comprova</span>
          <span className="ml-1 text-sm text-muted-foreground">.endereco</span>
        </div>
        <div className="flex justify-center">{children}</div>
      </div>
    </div>
  )
}

function StatusCard({
  title,
  message,
  variant,
}: {
  readonly title: string
  readonly message: string
  readonly variant: BadgeVariant
}) {
  return (
    <Card className="w-full max-w-lg border-border shadow-lg">
      <CardContent className="space-y-3 p-8 text-center">
        <Badge variant={variant}>{title}</Badge>
        <p className="text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  )
}

function Notice({
  variant,
  message,
}: {
  readonly variant: 'success' | 'warning' | 'destructive'
  message: string
}) {
  const Icon = variant === 'success' ? CheckCircle2 : AlertTriangle
  return (
    <div
      role="status"
      className={
        variant === 'destructive'
          ? 'flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800'
          : variant === 'warning'
            ? 'flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800'
            : 'flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800'
      }
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

function ItemCard({
  item,
  disabled,
  file,
  valueDraft,
  busy,
  onFileChange,
  onValueChange,
  onUpload,
  onSaveValue,
  onDelete,
}: {
  readonly item: HolderAccessItem
  readonly disabled: boolean
  readonly file: File | undefined
  readonly valueDraft: string
  readonly busy: boolean
  readonly onFileChange: (file: File | undefined) => void
  readonly onValueChange: (value: string) => void
  readonly onUpload: () => void
  readonly onSaveValue: () => void
  readonly onDelete: (documentId: string) => void
}) {
  const isDocument = item.documentType !== undefined && item.documentType.trim() !== ''
  const inputId = `holder-item-${item.itemId}`

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{item.description}</p>
          <p className="text-xs text-muted-foreground">
            {isDocument ? `Documento (${item.documentType})` : 'Resposta em texto'}
            {item.required ? ' · obrigatório' : ' · opcional'}
          </p>
        </div>
        {item.documents.length > 0 || (!isDocument && item.value !== null) ? (
          <Badge variant="success">Preenchido</Badge>
        ) : (
          <Badge variant="secondary">Pendente</Badge>
        )}
      </div>

      {isDocument ? (
        <>
          {item.documents.length > 0 ? (
            <ul className="space-y-2">
              {item.documents.map((document) => (
                <li
                  key={document.documentId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs"
                >
                  <span className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5" />
                    {document.originalFilename} · {formatBytes(document.sizeBytes)} ·{' '}
                    {formatDate(document.createdAt)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled || busy}
                    onClick={() => onDelete(document.documentId)}
                    aria-label={`Remover ${document.originalFilename}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Nenhum documento enviado.</p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="sr-only" htmlFor={inputId}>
              Selecionar arquivo para {item.description}
            </label>
            <Input
              id={inputId}
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              disabled={disabled || busy}
              onChange={(event) => onFileChange(event.target.files?.[0])}
              className="file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1 file:text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy || file === undefined}
              onClick={onUpload}
            >
              <Upload className="h-3.5 w-3.5" /> Enviar
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor={inputId}>
            Resposta para {item.description}
          </label>
          <Input
            id={inputId}
            value={valueDraft}
            disabled={disabled || busy}
            maxLength={5000}
            onChange={(event) => onValueChange(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || busy || valueDraft.trim().length === 0}
            onClick={onSaveValue}
          >
            Salvar
          </Button>
        </div>
      )}
    </div>
  )
}

function ProcessingStatus({
  processing,
  loading,
}: {
  readonly processing: {
    readonly state: 'awaiting' | 'processing' | 'processed' | 'partial' | 'failed'
  } | null
  readonly loading: boolean
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Consultando processamento…
      </p>
    )
  }
  if (processing === null) {
    return <p className="text-sm text-muted-foreground">Aguardando início do processamento.</p>
  }
  const labels: Record<typeof processing.state, { label: string; variant: BadgeVariant }> = {
    awaiting: { label: 'Aguardando processamento', variant: 'secondary' },
    processing: { label: 'Em processamento', variant: 'warning' },
    processed: { label: 'Processado', variant: 'success' },
    partial: { label: 'Processamento parcial', variant: 'warning' },
    failed: { label: 'Falha no processamento', variant: 'destructive' },
  }
  const current = labels[processing.state]
  return (
    <p className="flex items-center gap-2 text-sm">
      <Badge variant={current.variant}>{current.label}</Badge>
      <span className="text-xs text-muted-foreground">
        O processamento não altera automaticamente o resultado da validação.
      </span>
    </p>
  )
}
