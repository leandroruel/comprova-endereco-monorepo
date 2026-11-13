import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getOrganization, listMembers, listApiKeys, listOrganizations } from '@/api/client'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Badge,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Button,
  Spinner,
} from '@/components/ui'
import { Users, FileKey, RefreshCw } from 'lucide-react'

interface DashboardPageProps {
  user: { id: string; email: string; name: string; role: string }
  setRoute: (route: string) => void
  activeOrgId?: string | null
}

export function DashboardPage({ user, setRoute, activeOrgId }: DashboardPageProps) {
  const queryClient = useQueryClient()

  const {
    data: orgs,
    isLoading: orgsLoading,
    isError: orgsError,
  } = useQuery({
    queryKey: ['organizations'],
    queryFn: listOrganizations,
    enabled: !!user,
  })

  // Organização ativa selecionada explicitamente. Sem fallback para a primeira
  // da lista: se nenhuma organização estiver selecionada, não há contexto
  // para operar.
  const activeOrg = orgs?.find((o: { tenantId: string }) => o.tenantId === activeOrgId)
  const tenantId = activeOrg?.tenantId ?? null

  const { data: organization, isLoading: orgLoading } = useQuery({
    queryKey: ['organization', tenantId],
    queryFn: () => getOrganization(tenantId!),
    enabled: !!tenantId,
  })

  const { data: membersData, isLoading: membersLoading } = useQuery({
    queryKey: ['members', tenantId],
    queryFn: () => listMembers(tenantId!),
    enabled: !!tenantId,
  })

  const {
    data: apiKeysData,
    isLoading: keysLoading,
    refetch: refetchKeys,
  } = useQuery({
    queryKey: ['api-keys', tenantId],
    queryFn: () => listApiKeys(tenantId!),
    enabled: !!tenantId,
  })

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    refetchKeys()
  }, [queryClient, refetchKeys])

  if (orgsLoading || orgLoading || membersLoading || keysLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="mr-2" />
        <span>Carregando…</span>
      </div>
    )
  }

  if (orgsError) {
    return (
      <div className="max-w-md mx-auto">
        <Card>
          <CardContent className="text-center p-10">
            <p className="text-sm text-destructive">
              {(orgsError as unknown as Error | undefined)?.message ?? 'Erro ao carregar organizações'}
            </p>
            <Button onClick={() => window.location.reload()}>Tentar novamente</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!activeOrg) {
    return (
      <div className="max-w-md mx-auto">
        <Card>
          <CardContent className="text-center p-10">
            <p className="text-sm text-muted-foreground">
              Selecione uma organização no menu lateral para visualizar seus dados.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const m2mKeys = (apiKeysData?.apiKeys ?? []).filter((key) => key.keyType === 'm2m')

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Visão geral da organização</h1>
          <p className="text-sm text-muted-foreground">
            Gerencie a organização {organization?.name ?? activeOrg.name}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleRefresh}>
            <RefreshCw className="mr-2 h-4 w-4" /> Atualizar
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Status do onboarding</CardTitle>
            <CardDescription>Estado atual do cadastro da organização</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Status</span>
              <Badge
                variant={
                  activeOrg.onboardingStatus === 'completed'
                    ? 'success'
                    : activeOrg.onboardingStatus === 'pending'
                      ? 'warning'
                      : 'destructive'
                }
              >
                {activeOrg.onboardingStatus === 'completed'
                  ? 'Concluído'
                  : activeOrg.onboardingStatus === 'pending'
                    ? 'Pendente'
                    : 'Suspenso'}
              </Badge>
            </div>
            {organization?.termsVersion && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Versão dos termos</span>
                <span className="text-sm text-foreground">{organization.termsVersion}</span>
              </div>
            )}
            {organization?.termsAcceptedAt && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Aceito em</span>
                <span className="text-sm text-foreground">
                  {new Date(organization.termsAcceptedAt).toLocaleDateString('pt-BR')}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Membros</CardTitle>
            <CardDescription>Usuários da organização</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total</span>
              <span className="text-lg font-medium">{membersData?.length ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Seu papel</span>
              <Badge variant="secondary">{membersData?.find((m) => m.userId === user.id)?.role ?? '—'}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Credenciais API</CardTitle>
            <CardDescription>Chaves de integração M2M ativas</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Ativas</span>
              <span className="text-lg font-medium">{m2mKeys.length}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4" /> Membros da organização
            </CardTitle>
            <CardDescription>Gerencie quem tem acesso à sua organização</CardDescription>
          </CardHeader>
          <CardContent>
            {membersData?.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">Nenhum membro cadastrado</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Usuário</TableHead>
                    <TableHead>Papel</TableHead>
                    <TableHead>Desde</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(membersData ?? []).map((m) => (
                    <TableRow key={m.organizationMemberId}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium overflow-hidden">
                            {m.userName.charAt(0).toUpperCase()}
                          </div>
                          <span className="text-sm text-foreground">{m.userName}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={m.role === 'owner' ? 'default' : 'secondary'}>{m.role}</Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {new Date(m.joinedAt).toLocaleDateString('pt-BR')}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="mt-4">
              <Button variant="outline" size="sm" onClick={() => setRoute('members')}>
                <Users className="mr-2 h-4 w-4" />
                Gerenciar membros
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileKey className="h-4 w-4" /> Credenciais de API (M2M)
            </CardTitle>
            <CardDescription>Chaves para integração máquina-a-máquina com a API Comprova</CardDescription>
          </CardHeader>
          <CardContent>
            {m2mKeys.length === 0 ? (
              <div className="space-y-3 text-center py-6">
                <p className="text-sm text-muted-foreground">Nenhuma credencial de API criada</p>
                <Button variant="outline" size="sm" onClick={() => setRoute('integrations')}>
                  <FileKey className="mr-2 h-4 w-4" />
                  Criar primeira credencial
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {m2mKeys.map((key) => (
                  <div
                    key={key.apiKeyId}
                    className="flex items-center justify-between p-3 rounded-lg border border-border bg-card"
                  >
                    <div>
                      <span className="text-sm text-foreground font-medium truncate max-w-xs">
                        {key.keyPrefix}…
                      </span>
                      <p className="text-xs text-muted-foreground">
                        {key.keyType} &middot; {new Date(key.createdAt).toLocaleDateString('pt-BR')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px] px-2 py-1">
                        {key.scopes.join(', ')}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
