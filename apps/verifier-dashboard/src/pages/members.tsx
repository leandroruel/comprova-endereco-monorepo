import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { addMember, listMembers } from '@/api/client'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Input,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Badge,
  Spinner,
} from '@/components/ui'
import { Users, Plus, AlertCircle, Mail } from 'lucide-react'

interface MembersPageProps {
  user: { id: string; email: string; name: string; role: string }
  activeOrgId?: string | null
}

export function MembersPage({ user, activeOrgId }: MembersPageProps) {
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState<'owner' | 'admin' | 'member'>('member')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: orgs, isLoading: orgsLoading } = useQuery({
    queryKey: ['organizations'],
    queryFn: async () => {
      const res = await fetch('http://localhost:3000/v1/organizations', {
        credentials: 'include',
      })
      if (!res.ok) return []
      return res.json()
    },
    enabled: !!user,
  })

  // Organização ativa selecionada explicitamente. Sem fallback para a
  // primeira da lista: se nenhuma organização estiver selecionada, não há
  // contexto para operar.
  const activeOrg = orgs?.find((o: { tenantId: string }) => o.tenantId === activeOrgId)
  const tenantId: string | null = activeOrg?.tenantId ?? null

  const { data: members, isLoading: membersLoading } = useQuery({
    queryKey: ['members', tenantId],
    queryFn: () => listMembers(tenantId!),
    enabled: !!tenantId,
  })

  const addMemberMutation = useMutation({
    mutationFn: ({ tid, email, role }: { tid: string; email: string; role: string }) =>
      addMember(tid, { email, role: role as 'owner' | 'admin' | 'member' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members', tenantId] })
      setNewEmail('')
      setNewRole('member')
      setSuccess('Membro adicionado com sucesso')
      setError(null)
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Erro ao adicionar membro')
      setSuccess(null)
    },
  })

  if (orgsLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="mr-2" /> Carregando…
      </div>
    )
  }

  if (!activeOrg) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Nenhuma organização encontrada.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Membros da organização</h1>
          <p className="text-sm text-muted-foreground">
            Gerencie usuários que têm acesso à organização {activeOrg.name}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4" /> Lista de membros
            </CardTitle>
            <CardDescription>Usuários cadastrados nesta organização</CardDescription>
          </CardHeader>
          <CardContent>
            {membersLoading ? (
              <div className="flex items-center justify-center py-4">
                <Spinner /> Carregando membros…
              </div>
            ) : members?.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">Nenhum membro cadastrado</p>
            ) : (
              <div className="overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Usuário</TableHead>
                      <TableHead>E-mail</TableHead>
                      <TableHead>Papel</TableHead>
                      <TableHead>Desde</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(members ?? []).map((m) => (
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
                          <span className="text-sm text-muted-foreground break-all">{m.userEmail}</span>
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
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="h-4 w-4" /> Adicionar membro
            </CardTitle>
            <CardDescription>Convide um novo usuário para a organização</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              onSubmit={(e) => {
                e.preventDefault()
                setError(null)
                setSuccess(null)
                if (tenantId && newEmail.trim()) {
                  void addMemberMutation.mutateAsync({
                    tid: tenantId,
                    email: newEmail,
                    role: newRole,
                  })
                }
              }}
            >
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="member-email">
                    E-mail do membro
                  </label>
                  <Input
                    id="member-email"
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="membro@exemplo.com"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="member-role">
                    Papel
                  </label>
                  <select
                    id="member-role"
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as 'owner' | 'admin' | 'member')}
                    className="flex h-10 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="member">Membro</option>
                    <option value="admin">Administrador</option>
                  </select>
                </div>

                <p className="text-[10px] text-muted-foreground">
                  O usuário precisa já ter uma conta no Comprova. O papel de{' '}
                  <span className="font-medium">Administrador</span> permite gerenciar membros e credenciais
                  da organização. O papel de Proprietário é definido apenas na criação da organização e não
                  pode ser transferido nesta fase.
                </p>

                <Button
                  type="submit"
                  disabled={addMemberMutation.isPending || !newEmail.trim()}
                  className="w-full"
                >
                  {addMemberMutation.isPending ? (
                    <Spinner className="mr-2" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  Adicionar
                </Button>
              </div>
            </form>

            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
                <AlertCircle className="h-4 w-4" /> {error}
              </div>
            )}
            {success && (
              <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 flex items-center gap-2">
                <Mail className="h-4 w-4" /> {success}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
