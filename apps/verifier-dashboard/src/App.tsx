import { useState, useEffect, useCallback, useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { authClient } from '@/api/auth'
import { getMe, listOrganizations } from '@/api/client'
import { Layout } from '@/components/layout'
import { Button, Card, CardContent } from '@/components/ui'
import { LoginPage } from '@/pages/login'
import { OnboardingPage } from '@/pages/onboarding'
import { DashboardPage } from '@/pages/dashboard'
import { MembersPage } from '@/pages/members'
import { IntegrationsPage } from '@/pages/integrations'

type Route = 'login' | 'onboarding' | 'dashboard' | 'members' | 'integrations'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

export default function App() {
  const [route, setRoute] = useState<Route>('login')
  const [user, setUser] = useState<{
    id: string
    email: string
    name: string
    role: string
  } | null>(null)
  const [organizations, setOrganizations] = useState<
    Array<{
      tenantId: string
      name: string
      onboardingStatus: string
      termsVersion: string | null
      role: string | null
    }>
  >([])
  const [organizationsError, setOrganizationsError] = useState<Error | null>(null)
  /** Organização ativa explicitamente selecionada pelo usuário (não apenas a primeira da lista). */
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null)
  const activeOrgIdRef = useRef(activeOrgId)
  activeOrgIdRef.current = activeOrgId
  const [loading, setLoading] = useState(true)

  const resolveRoute = useCallback(async () => {
    setLoading(true)
    try {
      const me = await getMe()
      if (me) {
        setUser(me)
        const orgs = await listOrganizations()
        const list: Array<{
          tenantId: string
          name: string
          onboardingStatus: string
          termsVersion: string | null
          role: string | null
        }> = Array.isArray(orgs) ? orgs : []
        setOrganizations(list)
        setOrganizationsError(null)

        // O estado de onboarding é determinado pela organização ativa
        // selecionada, e não pelo primeiro item da lista. Se nenhuma
        // organização estiver selecionada, o usuário deve escolher uma no
        // seletor do Layout antes de prosseguir.
        const activeOrg = list.find((o) => o.tenantId === activeOrgIdRef.current)
        const hasOrg = list.length > 0
        const completed = activeOrg?.onboardingStatus === 'completed'

        if (!hasOrg) {
          setRoute('onboarding')
        } else if (!activeOrgIdRef.current) {
          // Tem organizações mas nenhuma selecionada: o usuário deve escolher
          // uma no seletor do Layout.
          setRoute('dashboard')
        } else if (!completed) {
          setRoute('onboarding')
        } else {
          setRoute('dashboard')
        }
      } else {
        setOrganizationsError(null)
        setRoute('login')
      }
    } catch (err) {
      setOrganizationsError(err instanceof Error ? err : new Error(String(err)))
      setRoute(route) // preserve current route on failure
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    resolveRoute()
  }, [resolveRoute])

  const handleAuthSuccess = useCallback(() => {
    resolveRoute()
  }, [resolveRoute])

  /** Adiciona uma organização recém-criada ao estado local e a define como ativa. */
  const handleOrganizationCreated = useCallback(
    (newOrg: {
      tenantId: string
      name: string
      onboardingStatus: string
      termsVersion: string | null
      role: string | null
    }) => {
      setOrganizations((prev) => {
        const exists = prev.some((o) => o.tenantId === newOrg.tenantId)
        if (exists) return prev
        return [...prev, newOrg]
      })
      setActiveOrgId(newOrg.tenantId)
    },
    [setActiveOrgId],
  )

  const handleLogout = useCallback(async () => {
    await authClient.signOut()
    // Limpa o cache de consultas compartilhado para que uma sessão subsequente
    // não renderize dados em cache do usuário anterior.
    queryClient.clear()
    setUser(null)
    setOrganizations([])
    setActiveOrgId(null)
    setRoute('login' as Route)
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      {loading ? (
        <div className="flex min-h-screen items-center justify-center bg-background">
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            <span className="text-sm text-muted-foreground">Carregando sessão…</span>
          </div>
        </div>
      ) : organizationsError ? (
        <div className="max-w-md mx-auto">
          <Card>
            <CardContent className="text-center p-10">
              <p className="text-sm text-destructive">
                {organizationsError instanceof Error
                  ? organizationsError.message
                  : 'Erro ao carregar organizações'}
              </p>
              <Button onClick={() => void resolveRoute()}>Tentar novamente</Button>
            </CardContent>
          </Card>
        </div>
      ) : route === 'login' ? (
        <LoginPage onSuccess={handleAuthSuccess} />
      ) : !user ? (
        <LoginPage onSuccess={handleAuthSuccess} />
      ) : (
        <Layout
          user={user}
          onLogout={handleLogout}
          currentRoute={route}
          setRoute={setRoute}
          organizations={organizations}
          activeOrgId={activeOrgId}
          setActiveOrgId={setActiveOrgId}
        >
          {route === 'onboarding' ? (
            <OnboardingPage
              user={user}
              organizations={organizations}
              activeOrgId={activeOrgId}
              onOrganizationCreated={handleOrganizationCreated}
              onComplete={resolveRoute}
            />
          ) : route === 'members' ? (
            <MembersPage user={user} activeOrgId={activeOrgId} />
          ) : route === 'integrations' ? (
            <IntegrationsPage tenantId={activeOrgId ?? ''} />
          ) : (
            <DashboardPage
              user={user}
              activeOrgId={activeOrgId}
              setRoute={(r: string) => setRoute(r as Route)}
            />
          )}
        </Layout>
      )}
    </QueryClientProvider>
  )
}
