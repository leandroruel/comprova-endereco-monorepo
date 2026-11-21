import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useEffect } from 'react'
import { FileSearch } from 'lucide-react'
import { listValidations, type ValidationListItem } from '@/api/client'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import { holderProcessingLabel, holderRequestUiBadge, validationUiBadge } from '@/pages/validations-state'

const PAGE_SIZE = 20

const formatDate = (value: string | null): string => {
  if (value === null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

interface ValidationsPageProps {
  activeOrgId: string | null
  onSelectValidation: (validationId: string) => void
  offset: number
  setOffset: (offset: number) => void
}

/**
 * Listagem paginada de validações da organização ativa (PR #74).
 *
 * O `tenantId` é contexto de consulta: a autorização é da sessão validada por
 * membership no backend (`requireSessionOrM2MVerify`), nunca do browser.
 *
 * O `offset` é controlado pelo pai (`App`) para sobreviver à navegação de
 * detalhe → listagem (item 7.2 da revisão da PR #75).
 */
export function ValidationsPage({
  activeOrgId,
  onSelectValidation,
  offset,
  setOffset,
}: ValidationsPageProps) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['validations', activeOrgId, offset],
    queryFn: () => listValidations(activeOrgId!, { limit: PAGE_SIZE, offset }),
    enabled: !!activeOrgId,
    // placeholderData mantém a tabela visível enquanto outra página carrega,
    // evitando piscar de loading ao navegar entre páginas.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })

  const validations = data?.validations ?? []
  const total = data?.total ?? 0
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Item 7.3: se o offset ficou além do total após atualização/exclusão,
  // retrocede para a última página válida em vez de mostrar página vazia.
  // Quando total === 0, qualquer offset > 0 é inválido: volta ao início.
  // O efeito só roda quando os dados da consulta estão disponíveis
  // (data !== undefined), evitando correções prematuras antes do primeiro
  // carregamento.
  useEffect(() => {
    if (!activeOrgId || data === undefined) return
    if (total === 0 && offset > 0) {
      setOffset(0)
    } else if (offset > 0 && offset >= total && total > 0) {
      const lastPageOffset = Math.max(0, Math.ceil(total / PAGE_SIZE) * PAGE_SIZE - PAGE_SIZE)
      setOffset(lastPageOffset)
    }
  }, [activeOrgId, offset, total, data, setOffset, PAGE_SIZE])

  if (!activeOrgId) {
    return (
      <div className="max-w-md mx-auto">
        <Card>
          <CardContent className="text-center p-10">
            <p className="text-sm text-muted-foreground">
              Selecione uma organização no menu lateral para visualizar as validações.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner className="mr-2" />
        <span className="text-sm text-muted-foreground">Carregando validações…</span>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="max-w-md mx-auto">
        <Card>
          <CardContent className="text-center p-10">
            <p className="text-sm text-destructive">
              {(error as Error | undefined)?.message ?? 'Erro ao carregar validações'}
            </p>
            <Button
              className="mt-4"
              onClick={() => {
                refetch()
              }}
            >
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Validações</h1>
        <p className="text-sm text-muted-foreground">
          Acompanhe as comprovações de endereço da organização e seus resultados.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSearch className="h-4 w-4" /> Comprovações
          </CardTitle>
          <CardDescription>
            {total} validação(ões) · página {page} de {pageCount}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {validations.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              Nenhuma validação encontrada para esta organização.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Solicitada em</TableHead>
                  <TableHead>Validação</TableHead>
                  <TableHead>Holder</TableHead>
                  <TableHead>Solicitação</TableHead>
                  <TableHead>Consentimento</TableHead>
                  <TableHead>Documentos</TableHead>
                  <TableHead>Processamento</TableHead>
                  <TableHead>Resultado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {validations.map((validation: ValidationListItem) => {
                  const badge = validationUiBadge({
                    status: validation.status as never,
                    verdict: (validation.verdict ?? null) as never,
                    hasCustomerDocument: validation.has_customer_document,
                    // Indicador compacto do contrato: análise de intake em
                    // curso distingue "Documento recebido" de "Em
                    // processamento" na listagem.
                    progressStatus: validation.document_processing ? 'in_progress' : null,
                  })
                  // Solicitação real do Holder (`holder_information_request`):
                  // estados e datas vêm do banco, nunca inferidos no frontend.
                  const holderBadge = holderRequestUiBadge({
                    requestState: validation.holder_request_state,
                    consentGranted: validation.consent_granted,
                    documentsReceived: validation.holder_documents_received,
                    documentProcessingState: validation.holder_document_processing_state,
                  })
                  return (
                    <TableRow key={validation.validation_id}>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {formatDate(validation.created_at)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => onSelectValidation(validation.validation_id)}
                          className="font-mono text-xs text-foreground underline-offset-2 hover:underline cursor-pointer"
                        >
                          {validation.validation_id.slice(0, 8)}…
                        </button>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {validation.holder_external_reference ?? '—'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Badge variant={holderBadge.variant}>{holderBadge.label}</Badge>
                          <p className="text-[11px] text-muted-foreground">
                            Criada {formatDate(validation.holder_request_created_at)}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Expira {formatDate(validation.holder_request_expires_at)}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Badge variant={validation.consent_granted ? 'success' : 'secondary'}>
                            {validation.consent_granted ? 'Registrado' : 'Pendente'}
                          </Badge>
                          {validation.holder_consent_accepted_at !== null ? (
                            <p className="text-[11px] text-muted-foreground">
                              {formatDate(validation.holder_consent_accepted_at)}
                            </p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={validation.holder_documents_received ? 'info' : 'secondary'}>
                          {validation.holder_documents_received ? 'Recebido' : 'Aguardando'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {holderProcessingLabel(validation.holder_document_processing_state)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}

          {/* O paginador permanece visível quando há offset > 0, mesmo com
          pageCount = 1, para permitir voltar à página 1 após excluir todos os
          itens da página atual (item 7.3 da revisão da PR #75). */}
          {pageCount > 1 || offset > 0 ? (
            <div className="mt-4 flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Anterior
              </Button>
              <span className="text-xs text-muted-foreground">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} de {total}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Próxima
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
