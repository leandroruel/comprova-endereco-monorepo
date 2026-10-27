import type {
  ValidationDto,
  ValidationProgressDto,
  ValidationProgressStage,
  ValidationProgressStepStatus,
} from '@/api/client'
import { cn } from '@/lib/utils'
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react'

/**
 * Progresso do fluxo de comprovante. Os textos são a tradução das etapas
 * internas; nenhum detalhe de worker, adapter ou tabela aparece aqui.
 */
const STAGE_LABELS: Readonly<Record<ValidationProgressStage, string>> = {
  reading_document: 'Lendo documento',
  reading_qr: 'Lendo QR Code',
  consulting_provider: 'Consultando provedor fiscal',
  verifying_authenticity: 'Comprovando autenticidade',
  comparing_evidence: 'Comparando evidências',
}

const FAILURE_MESSAGES: Readonly<Record<ValidationProgressStage, string>> = {
  reading_document: 'Documento não pôde ser analisado.',
  reading_qr: 'Não foi possível ler a referência fiscal.',
  consulting_provider: 'Não foi possível consultar o provedor fiscal.',
  verifying_authenticity: 'Não foi possível comprovar a autenticidade.',
  comparing_evidence: 'Não foi possível comparar as evidências.',
}

const STATUS_LABELS: Readonly<Record<ValidationProgressStepStatus, string>> = {
  pending: 'aguardando',
  in_progress: 'em andamento',
  completed: 'concluído',
  failed: 'falhou',
  skipped: 'não aplicável',
}

const TITLES: Readonly<Record<ValidationProgressDto['status'], string>> = {
  in_progress: 'Validação em andamento',
  completed: 'Validação concluída',
  failed: 'Uma etapa não pôde ser concluída',
}

function StepIcon({ status }: { status: ValidationProgressStepStatus }) {
  if (status === 'completed') {
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
  }
  if (status === 'in_progress') {
    return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-600" aria-hidden />
  }
  if (status === 'failed') {
    return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden />
  }
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden />
}

export function ValidationProgress({
  progress,
  validation,
  compact = false,
}: {
  progress: ValidationProgressDto
  validation?: ValidationDto
  compact?: boolean
}) {
  const visibleSteps = progress.steps.filter((step) => step.status !== 'skipped')
  const noReference =
    progress.steps.find((step) => step.stage === 'reading_document')?.status === 'completed' &&
    progress.steps.find((step) => step.stage === 'reading_qr')?.status === 'completed' &&
    progress.steps.find((step) => step.stage === 'consulting_provider')?.status === 'skipped'
  const validationFailed = validation?.status === 'failed' || validation?.status === 'expired'
  const title =
    progress.status === 'failed' && validationFailed ? 'Validação interrompida' : TITLES[progress.status]

  return (
    <div
      className={cn('rounded-lg border border-border bg-muted/20', compact ? 'px-4 py-3' : 'space-y-3 p-4')}
      role="status"
      aria-live="polite"
    >
      <p className={cn('font-semibold text-foreground', compact ? 'text-xs' : 'text-sm')}>{title}</p>
      <ol className={cn('space-y-2', compact && 'mt-2 space-y-1.5')}>
        {visibleSteps.map((step) => (
          <li
            key={step.stage}
            data-testid={`progress-step-${step.stage}`}
            data-status={step.status}
            className="flex items-start gap-2.5"
          >
            <StepIcon status={step.status} />
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-sm leading-snug',
                  step.status === 'pending' && 'text-muted-foreground',
                  step.status === 'in_progress' && 'font-medium text-foreground',
                  step.status === 'completed' && 'text-foreground',
                  step.status === 'failed' && 'font-medium text-red-800',
                )}
              >
                {STAGE_LABELS[step.stage]}
              </p>
              {step.stage === 'reading_qr' && noReference && (
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  Referência fiscal não encontrada no comprovante.
                </p>
              )}
              {step.status === 'failed' && (
                <p className="mt-0.5 text-xs leading-relaxed text-red-800">{FAILURE_MESSAGES[step.stage]}</p>
              )}
            </div>
            <span className="sr-only">{STATUS_LABELS[step.status]}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
