import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
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
import { statusLabel, validationUiBadge } from '@/pages/validations-state'

const PAGE_SIZE = 20

interface ValidationsPageProps {
  activeOrgId: string | null
  onSelectValidation: (validationId: string) => void
}

/**
 * Listagem paginada de validações da organização ativa (PR #74).
 *
 * O `tenantId` é contexto de consulta: a autorização é da sessão validada por
 * membership no backend (`requireSessionOrM2MVerify`), nunca do browser.
 */
export function ValidationsPage({ activeOrgId, onSelectValidation }: ValidationsPageProps) {
  const [offset, setOffset] = useState(0)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['validations', activeOrgId, offset],
    queryFn: () => listValidations(activeOrgId!, { limit: PAGE_SIZE, offset }),
    enabled: !!activeOrgId,
    // A listagem é paginada no servidor: nunca carrega tudo.
    staleTime: 15_000,
  })

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

  const validations = data?.validations ?? []
  const total = data?.total ?? 0
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

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
                  <TableHead>Documento</TableHead>
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
                  return (
                    <TableRow key={validation.validation_id}>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {new Date(validation.created_at).toLocaleString('pt-BR')}
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
                        <Badge variant={validation.has_customer_document ? 'info' : 'secondary'}>
                          {validation.has_customer_document ? 'Recebido' : 'Aguardando'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {statusLabel(validation.status as never)}
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

          {pageCount > 1 && (
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
          )}
        </CardContent>
      </Card>
    </div>
  )
}
