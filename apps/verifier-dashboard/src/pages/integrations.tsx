import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createApiKey, listApiKeys, revokeApiKey } from '@/api/client'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Input,
  Badge,
  Spinner,
} from '@/components/ui'
import { FileKey, AlertCircle, CheckCircle2, Trash2, Copy, Clock, Link } from 'lucide-react'

interface IntegrationsPageProps {
  tenantId: string
}

export function IntegrationsPage({ tenantId }: IntegrationsPageProps) {
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState(['validate:read', 'validate:write', 'verify:m2m'])
  const [showSecret, setShowSecret] = useState<{ apiKeyId: string; secret: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const {
    data: keysData,
    isLoading: keysLoading,
    isError: keysError,
    error: keysErr,
  } = useQuery({
    queryKey: ['api-keys', tenantId],
    queryFn: () => listApiKeys(tenantId),
    enabled: tenantId.length > 0,
  })

  const createKeyMutation = useMutation({
    mutationFn: createApiKey,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['api-keys', tenantId] })
      setName('')
      setScopes(['validate:read', 'validate:write', 'verify:m2m'])
      setShowSecret({ apiKeyId: result.apiKey.apiKeyId, secret: result.secret })
      setError(null)
      setSuccess('Credencial criada. Copie o segredo agora — ele não será exibido novamente.')
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Erro ao criar credencial')
      setSuccess(null)
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (apiKeyId: string) => revokeApiKey(tenantId, apiKeyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys', tenantId] })
      setSuccess('Credencial revogada com sucesso')
      setError(null)
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Erro ao revogar credencial')
      setSuccess(null)
    },
  })

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    if (!name.trim()) return
    void createKeyMutation.mutateAsync({
      tenantId,
      name,
      scopes,
      keyType: 'm2m',
    })
  }

  const handleRevoke = (apiKeyId: string) => {
    if (!window.confirm('Tem certeza que deseja revogar esta credencial? Essa ação não pode ser desfeita.'))
      return
    setError(null)
    setSuccess(null)
    void revokeMutation.mutateAsync(apiKeyId)
  }

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setError(null)
      setSuccess('Copiado para a área de transferência')
    } catch {
      setSuccess(null)
      setError('Não foi possível copiar. Copie o segredo manualmente.')
    }
  }

  if (keysLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="mr-2" /> Carregando credenciais…
      </div>
    )
  }

  if (keysError) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {keysErr instanceof Error ? keysErr.message : 'Erro ao carregar credenciais'}
      </div>
    )
  }

  if (tenantId.length === 0) {
    return (
      <div className="max-w-md mx-auto">
        <Card>
          <CardContent className="text-center p-10">
            <p className="text-sm text-muted-foreground">
              Nenhuma organização selecionada. Selecione uma organização para gerenciar credenciais M2M.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const keys = keysData?.apiKeys ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Integrações M2M</h1>
          <p className="text-sm text-muted-foreground">
            Gerencie credenciais de API para integração máquina-a-máquina com o Comprova. O segredo é exibido
            apenas no momento da criação.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileKey className="h-4 w-4" /> Credenciais de API
            </CardTitle>
            <CardDescription>Chaves ativas para acesso M2M à API Comprova</CardDescription>
          </CardHeader>
          <CardContent>
            {keys.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-sm text-muted-foreground">Nenhuma credencial criada ainda</p>
              </div>
            ) : (
              <div className="space-y-2">
                {keys.map((key) => (
                  <div
                    key={key.apiKeyId}
                    className="flex items-center justify-between p-3 rounded-lg border border-border bg-card"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-foreground font-medium truncate max-w-xs">
                          {key.keyPrefix}…
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleCopy(key.keyPrefix)}
                          title="Copiar prefixo"
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Tipo: {key.keyType} &middot; Criado em:{' '}
                        {new Date(key.createdAt).toLocaleDateString('pt-BR')}
                      </p>
                      {key.lastUsedAt && (
                        <p className="text-xs text-muted-foreground">
                          Última utilização: {new Date(key.lastUsedAt).toLocaleDateString('pt-BR')}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px] px-2 py-1">
                        {key.scopes.join(', ')}
                      </Badge>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleRevoke(key.apiKeyId)}
                        disabled={revokeMutation.isPending}
                      >
                        {revokeMutation.isPending ? (
                          <Spinner className="mr-1 h-3 w-3" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link className="h-4 w-4" /> Criar credencial
            </CardTitle>
            <CardDescription>Gere uma nova chave de API M2M</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={handleCreate}>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="key-name">
                    Nome da credencial
                  </label>
                  <Input
                    id="key-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ex: ERP produção"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Escopos</label>
                  <div className="flex items-center gap-2">
                    <input
                      id="scope-read"
                      type="checkbox"
                      checked={scopes.includes('validate:read')}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setScopes([...scopes, 'validate:read'])
                        } else {
                          setScopes(scopes.filter((s) => s !== 'validate:read'))
                        }
                      }}
                      className="w-4 h-4 rounded border border-input bg-card text-primary focus:ring-0"
                    />
                    <label htmlFor="scope-read" className="text-xs text-muted-foreground cursor-pointer">
                      validate:read
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id="scope-write"
                      type="checkbox"
                      checked={scopes.includes('validate:write')}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setScopes([...scopes, 'validate:write'])
                        } else {
                          setScopes(scopes.filter((s) => s !== 'validate:write'))
                        }
                      }}
                      className="w-4 h-4 rounded border border-input bg-card text-primary focus:ring-0"
                    />
                    <label htmlFor="scope-write" className="text-xs text-muted-foreground cursor-pointer">
                      validate:write
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id="scope-m2m"
                      type="checkbox"
                      checked={scopes.includes('verify:m2m')}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setScopes([...scopes, 'verify:m2m'])
                        } else {
                          setScopes(scopes.filter((s) => s !== 'verify:m2m'))
                        }
                      }}
                      className="w-4 h-4 rounded border border-input bg-card text-primary focus:ring-0"
                    />
                    <label htmlFor="scope-m2m" className="text-xs text-muted-foreground cursor-pointer">
                      verify:m2m
                    </label>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    O escopo <span className="font-medium">verify:m2m</span> é necessário para operações M2M
                    sem sessão de usuário.
                  </p>
                </div>
              </div>

              <Button type="submit" disabled={createKeyMutation.isPending || !name.trim()} className="w-full">
                {createKeyMutation.isPending ? (
                  <Spinner className="mr-2" />
                ) : (
                  <FileKey className="mr-2 h-4 w-4" />
                )}
                Criar credencial
              </Button>
            </form>

            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
                <AlertCircle className="h-4 w-4" /> {error}
              </div>
            )}
            {success && (
              <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 flex items-center gap-2 mb-2">
                <CheckCircle2 className="h-4 w-4" /> {success}
              </div>
            )}

            {showSecret && (
              <Card className="border border-accent bg-accent/50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-accent-foreground" /> Segredo da credencial
                  </CardTitle>
                  <CardDescription>
                    Copie agora. Este é o único momento em que o segredo é exibido.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="bg-muted rounded-lg p-3 font-mono text-xs text-foreground break-all">
                    {showSecret.secret}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => void handleCopy(showSecret.secret)}>
                      <Copy className="h-3 w-3 mr-1" />
                      Copiar segredo
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setShowSecret(null)}>
                      Fechar
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
