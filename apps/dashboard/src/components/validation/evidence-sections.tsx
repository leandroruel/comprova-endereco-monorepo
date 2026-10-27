import type { EvidenceVerificationDto, FiscalVerificationDto } from '@/api/client'
import { Card, CardContent } from '@/components/ui'
import { cn } from '@/lib/utils'
import { AlertTriangle, CheckCircle2, CircleHelp, FileText, Landmark, XCircle } from 'lucide-react'

/**
 * Evidências que não vêm de `signal` — verificação do comprovante enviado
 * (F1.3) e consulta fiscal (F2) — lidas de `claim_evidence` pelo GET. A
 * taxonomia do backend é preservada: `unavailable`/`inconclusive`/`unsupported`
 * significam "a consulta não pôde ser concluída", nunca "endereço falso".
 */

const MATCH_LABELS: Readonly<Record<string, string>> = {
  matches: 'compatível com o endereço da validação',
  differs: 'diverge do endereço da validação',
  not_extracted: 'não extraído do documento',
}

const DOCUMENT_LABELS: Readonly<Record<string, string>> = {
  authentic: 'autenticado pela fonte',
  not_found: 'não localizado na fonte',
  invalid: 'inválido',
  inconclusive: 'inconclusivo',
  unavailable: 'fonte indisponível',
  unsupported: 'não suportado',
}

const FISCAL_STATUS: Readonly<Record<string, { label: string; tone: 'ok' | 'warn' | 'muted' }>> = {
  completed: { label: 'consulta concluída', tone: 'ok' },
  not_found: { label: 'documento não localizado no autorizador', tone: 'warn' },
  invalid: { label: 'documento inválido segundo o autorizador', tone: 'warn' },
  inconclusive: { label: 'consulta inconclusiva — sem efeito no resultado', tone: 'muted' },
  unsupported: { label: 'referência fora da cobertura atual (autorizador/UF)', tone: 'muted' },
  unavailable: {
    label: 'a consulta fiscal não pôde ser concluída — autorizador indisponível',
    tone: 'muted',
  },
}

const humanizeCode = (code: string): string => code.replaceAll('_', ' ').toLowerCase()

const TONE_STYLES = {
  ok: 'border-emerald-200 bg-emerald-50/60',
  warn: 'border-amber-200 bg-amber-50/60',
  muted: 'border-border bg-muted/40',
} as const

const TONE_ICON = { ok: CheckCircle2, warn: AlertTriangle, muted: CircleHelp } as const

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium leading-snug">{value}</dd>
    </div>
  )
}

function Limitations({ codes }: { codes: readonly string[] }) {
  if (codes.length === 0) return null
  return (
    <p className="mt-2 border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted-foreground">
      Limitações: {codes.map(humanizeCode).join(', ')}
    </p>
  )
}

export function DocumentEvidenceSection({ verification }: { verification: EvidenceVerificationDto }) {
  const addressTone = verification.address === 'differs' ? 'warn' : 'ok'
  return (
    <Card className="border-dashed">
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h5 className="text-[13px] font-semibold">Comprovante enviado</h5>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-black/5',
              TONE_STYLES[
                addressTone === 'warn' ? 'warn' : verification.status === 'completed' ? 'ok' : 'muted'
              ],
            )}
          >
            {verification.status === 'completed'
              ? 'verificação concluída'
              : verification.status === 'invalid'
                ? 'documento inválido'
                : verification.status === 'unavailable'
                  ? 'análise indisponível'
                  : 'verificação inconclusiva'}
          </span>
        </div>
        <dl className="space-y-1.5 text-xs">
          <Row label="Documento" value={DOCUMENT_LABELS[verification.document] ?? verification.document} />
          <Row label="Endereço" value={MATCH_LABELS[verification.address] ?? verification.address} />
          <Row label="Titular" value={MATCH_LABELS[verification.holder] ?? verification.holder} />
        </dl>
        <Limitations codes={[...verification.limitations, ...verification.error_codes]} />
      </CardContent>
    </Card>
  )
}

export function FiscalEvidenceSection({ verification }: { verification: FiscalVerificationDto }) {
  const status = FISCAL_STATUS[verification.status] ?? {
    label: verification.status,
    tone: 'muted' as const,
  }
  const Icon = TONE_ICON[status.tone]
  return (
    <Card className="border-dashed">
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center gap-2">
          <Landmark className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h5 className="text-[13px] font-semibold">Consulta fiscal NF3e</h5>
          <span
            className={cn(
              'flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-black/5',
              TONE_STYLES[status.tone],
            )}
          >
            <Icon className="h-3 w-3" aria-hidden />
            {status.label}
          </span>
        </div>
        <dl className="space-y-1.5 text-xs">
          <Row
            label="Autorizador"
            value={`${verification.source.authority ?? verification.source.id} · ${verification.source.environment}`}
          />
          <Row
            label="Autenticidade"
            value={DOCUMENT_LABELS[verification.document] ?? verification.document}
          />
          <Row label="Endereço" value={MATCH_LABELS[verification.address] ?? verification.address} />
          <Row label="Titular" value={MATCH_LABELS[verification.holder] ?? verification.holder} />
        </dl>
        <Limitations codes={[...verification.limitations, ...verification.error_codes]} />
        {verification.address === 'differs' && (
          <p className="flex items-start gap-1.5 text-[11px] text-red-800">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" aria-hidden />O endereço do
            documento fiscal diverge do endereço validado.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/** Seção combinada: só existe quando há comprovante ou consulta fiscal. */
export function EvidenceSections({
  evidenceVerification,
  fiscalVerification,
}: {
  evidenceVerification?: EvidenceVerificationDto | null
  fiscalVerification?: FiscalVerificationDto | null
}) {
  if (evidenceVerification == null && fiscalVerification == null) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {evidenceVerification != null && <DocumentEvidenceSection verification={evidenceVerification} />}
      {fiscalVerification != null && <FiscalEvidenceSection verification={fiscalVerification} />}
    </div>
  )
}
