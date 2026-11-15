import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { getValidation } from '@/api/client'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import {
  dimensionBadge,
  isProcessing,
  statusLabel,
  validationUiBadge,
  type DimensionOutcome,
} from '@/pages/validations-state'

const POLL_INTERVAL_MS = 3_000

const STAGE_LABELS: Record<string, string> = {
  reading_document: 'Lendo documento',
  reading_qr: 'Lendo QR Code',
  consulting_provider: 'Consultando fonte fiscal',
  verifying_authenticity: 'Verificando autenticidade',
  comparing_evidence: 'Comparando evidências',
}

const STEP_LABELS: Record<string, string> = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  completed: 'Concluído',
  failed: 'Falhou',
  skipped: 'Não se aplica',
}

const STANCE_LABELS: Record<string, string> = {
  supports: 'Apoia',
  contradicts: 'Contradiz',
  neutral: 'Neutro',
  unknown: 'Sem avaliação',
}

interface ValidationDetailPageProps {
  activeOrgId: string | null
  validationId: string
  onBack: () => void
}

/**
 * Detalhe e resultado da validação (PR #74).
 *
 * Reutiliza `GET /v1/validations/:id` e a taxonomia pública existente. O
 * resultado é exclusivamente o assessment do backend: o documento recebido
 * não é aprovação e estados neutros (`inconclusive`, `unavailable`,
 * `unsupported`, `not_extracted`) nunca são apresentados como reprovação.
 * Enquanto houver processamento ou reavaliação pendente, o resultado não é
 * apresentado como definitivo e a página continua atualizando (polling).
 */
export function ValidationDetailPage({ activeOrgId, validationId, onBack }: ValidationDetailPageProps) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['validation', activeOrgId, validationId],
    queryFn: () => getValidation(activeOrgId!, validationId),
    enabled: !!activeOrgId && !!validationId,
    // Reutiliza o mecanismo de atualização existente (react-query): polling
    // apenas enquanto há processamento/reavaliação pendente.
    refetchInterval: (query) =>
      isProcessing({
        status: query.state.data?.status as never,
        progressStatus: (query.state.data?.progress?.status ?? null) as never,
        fiscalReassessment: query.state.data?.fiscal_reassessment ?? null,
      })
        ? POLL_INTERVAL_MS
        : false,
  })

  if (!activeOrgId || !validationId) {
    return (
      <div className="max-w-md mx-auto">
        <Card>
          <CardContent className="text-center p-10">
            <p className="text-sm text-muted-foreground">Selecione uma validação a partir da listagem.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner className="mr-2" />
        <span className="text-sm text-muted-foreground">Carregando validação…</span>
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="max-w-md mx-auto">
        <Card>
          <CardContent className="text-center p-10">
            <p className="text-sm text-destructive">
              {(error as Error | undefined)?.message ?? 'Erro ao carregar a validação'}
            </p>
            <Button className="mt-4" onClick={onBack}>
              Voltar
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const badge = validationUiBadge({
    status: data.status as never,
    verdict: (data.verdict ?? null) as never,
    hasCustomerDocument: data.evidence_summary !== null,
    progressStatus: (data.progress?.status ?? null) as never,
  })
  const processing = isProcessing({
    status: data.status as never,
    progressStatus: (data.progress?.status ?? null) as never,
    fiscalReassessment: data.fiscal_reassessment ?? null,
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack} className="mb-2 -ml-2">
            <ArrowLeft className="mr-2 h-4 w-4" /> Voltar
          </Button>
          <h1 className="text-xl font-semibold font-mono">{data.validation_id}</h1>
          <p className="text-sm text-muted-foreground">
            Solicitada em {new Date(data.created_at).toLocaleString('pt-BR')} · Status:{' '}
            {statusLabel(data.status as never)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {processing && <Spinner className="h-4 w-4" />}
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
      </div>

      {processing && (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            Processamento em andamento — o resultado abaixo ainda não é definitivo.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Resultado</CardTitle>
            <CardDescription>Assessment produzido pelo Comprova</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Veredito</span>
              {data.verdict === null ? (
                <span className="text-sm text-muted-foreground">—</span>
              ) : (
                <Badge variant={badge.variant}>{badge.label}</Badge>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Score</span>
              <span className="text-sm text-foreground">
                {data.score === null ? '—' : data.score.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Confiança</span>
              <span className="text-sm text-foreground">
                {data.confidence === null ? '—' : `${Math.round(data.confidence * 100)}%`}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Policy</span>
              <span className="text-sm text-foreground">{data.policy_version ?? '—'}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Explicação</CardTitle>
            <CardDescription>Motivo do resultado</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-foreground">{data.explanation ?? '—'}</p>
            {data.explanation_detail !== null && (
              <>
                <Separator />
                <div className="text-xs text-muted-foreground">
                  Evidências que apoiam: {data.explanation_detail.supporting_evidence.length}
                </div>
                <div className="text-xs text-muted-foreground">
                  Evidências que contradizem: {data.explanation_detail.contradicting_evidence.length}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Evidências consideradas</CardTitle>
            <CardDescription>Observações do assessment</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.evidence_summary === null ? (
              <p className="text-sm text-muted-foreground">Nenhuma evidência registrada.</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Apoiam</span>
                  <span className="text-sm text-foreground">{data.evidence_summary.supporting}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Contradizem</span>
                  <span className="text-sm text-foreground">{data.evidence_summary.contradicting}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Sem avaliação</span>
                  <span className="text-sm text-foreground">{data.evidence_summary.unknown}</span>
                </div>
              </>
            )}
            <Separator />
            <div className="text-xs text-muted-foreground">Origem da evidência</div>
            {data.signals.length === 0 ? (
              <p className="text-xs text-muted-foreground">Sem signals.</p>
            ) : (
              <div className="space-y-1">
                {data.signals.map((signal, index) => (
                  <div
                    key={`${signal.checker}-${index}`}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-foreground">{signal.checker}</span>
                    <span className="text-muted-foreground">
                      {signal.source} · {STANCE_LABELS[signal.stance] ?? signal.stance}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dimensões de verificação</CardTitle>
          <CardDescription>
            Documento, endereço e titular conforme a verificação mais recente (F1.3) e a consulta fiscal (F2)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.evidence_verification === null && data.fiscal_verification === null ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma verificação materializada ainda — acompanhe o progresso abaixo.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dimensão</TableHead>
                  <TableHead>Resultado</TableHead>
                  <TableHead>Origem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.evidence_verification !== null && (
                  <>
                    <TableRow>
                      <TableCell>Documento</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            dimensionBadge(data.evidence_verification.document as DimensionOutcome).variant
                          }
                        >
                          {dimensionBadge(data.evidence_verification.document as DimensionOutcome).label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {data.evidence_verification.source.kind} ·{' '}
                          {data.evidence_verification.source.authority ?? '—'} ·{' '}
                          {data.evidence_verification.analyzer.id}
                        </span>
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Endereço</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            dimensionBadge(data.evidence_verification.address as DimensionOutcome).variant
                          }
                        >
                          {dimensionBadge(data.evidence_verification.address as DimensionOutcome).label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {data.evidence_verification.method}
                        </span>
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Titular</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            dimensionBadge(data.evidence_verification.holder as DimensionOutcome).variant
                          }
                        >
                          {dimensionBadge(data.evidence_verification.holder as DimensionOutcome).label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {data.evidence_verification.method}
                        </span>
                      </TableCell>
                    </TableRow>
                  </>
                )}
                {data.fiscal_verification !== null && (
                  <>
                    <TableRow>
                      <TableCell>Documento (fonte fiscal)</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            dimensionBadge(data.fiscal_verification.document as DimensionOutcome).variant
                          }
                        >
                          {dimensionBadge(data.fiscal_verification.document as DimensionOutcome).label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {data.fiscal_verification.method}
                        </span>
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Endereço (fonte fiscal)</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            dimensionBadge(data.fiscal_verification.address as DimensionOutcome).variant
                          }
                        >
                          {dimensionBadge(data.fiscal_verification.address as DimensionOutcome).label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {data.fiscal_verification.method}
                        </span>
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Titular (fonte fiscal)</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            dimensionBadge(data.fiscal_verification.holder as DimensionOutcome).variant
                          }
                        >
                          {dimensionBadge(data.fiscal_verification.holder as DimensionOutcome).label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {data.fiscal_verification.method}
                        </span>
                      </TableCell>
                    </TableRow>
                  </>
                )}
              </TableBody>
            </Table>
          )}
          <div className="mt-4 flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>Consulta fiscal: {data.fiscal_reference ?? 'sem referência'}</span>
            <span>Reavaliação: {data.fiscal_reassessment ?? 'não aplicável'}</span>
          </div>
        </CardContent>
      </Card>

      {data.progress !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Progresso</CardTitle>
            <CardDescription>Etapas do processamento do comprovante</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.progress.steps.map((step) => (
              <div key={step.stage} className="flex items-center justify-between">
                <span className="text-sm text-foreground">{STAGE_LABELS[step.stage] ?? step.stage}</span>
                <Badge
                  variant={
                    step.status === 'completed'
                      ? 'success'
                      : step.status === 'failed'
                        ? 'destructive'
                        : step.status === 'in_progress'
                          ? 'warning'
                          : 'secondary'
                  }
                >
                  {STEP_LABELS[step.status] ?? step.status}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
