import { useState, useEffect, useCallback } from 'react'
import { authClient } from '@/api/auth'
import { getMe } from '@/api/client'
import { Layout } from '@/components/layout'
import { LoginPage } from '@/pages/login'
import { OnboardingPage } from '@/pages/onboarding'
import { DashboardPage } from '@/pages/dashboard'
import { MembersPage } from '@/pages/members'
import { IntegrationsPage } from '@/pages/integrations'

type Route = 'login' | 'onboarding' | 'dashboard' | 'members' | 'integrations'

export default function App() {
  const [route, setRoute] = useState<Route>('login')
  const [user, setUser] = useState<{
    id: string
    email: string
    name: string
    role: string
  } | null>(null)
  const [organizations, setOrganizations] = useState<Array<{ tenantId: string; onboardingStatus: string }>>([])
  const [loading, setLoading] = useState(true)

  const resolveRoute = useCallback(async () => {
    setLoading(true)
    try {
      const me = await getMe()
      if (me) {
        setUser(me)
        const orgs = await (() => {
          // lista organizações do usuário para decidir a rota inicial
          return fetch('http://localhost:3000/v1/organizations', {
            credentials: 'include',
          })
            .then((r) => (r.ok ? r.json() : []))
            .catch(() => [])
        })()
        setOrganizations(Array.isArray(orgs) ? orgs : [])

        const hasOrg = organizations.length > 0
        const completed = organizations.some((o) => o.onboardingStatus === 'completed')

        if (!hasOrg) {
          setRoute('onboarding')
        } else if (!completed) {
          setRoute('onboarding')
        } else {
          setRoute('dashboard')
        }
      } else {
        setRoute('login')
      }
    } catch {
      setRoute('login')
    } finally {
      setLoading(false)
    }
  }, [organizations])

  useEffect(() => {
    resolveRoute()
  }, [resolveRoute])

  const handleAuthSuccess = useCallback(() => {
    resolveRoute()
  }, [resolveRoute])

  const handleLogout = useCallback(async () => {
    await authClient.signOut()
    setUser(null)
    setOrganizations([])
    setRoute('login' as Route)
  }, [])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <span className="text-sm text-muted-foreground">Carregando sessão…</span>
        </div>
      </div>
    )
  }

  if (route === 'login') {
    return <LoginPage onSuccess={handleAuthSuccess} />
  }

  if (!user) {
    return <LoginPage onSuccess={handleAuthSuccess} />
  }

  return (
    <Layout user={user} onLogout={handleLogout} currentRoute={route} setRoute={setRoute}>
      {route === 'onboarding' ? (
        <OnboardingPage user={user} organizations={organizations} onComplete={resolveRoute} />
      ) : route === 'members' ? (
        <MembersPage user={user} />
      ) : route === 'integrations' ? (
        <IntegrationsPage user={user} />
      ) : (
        <DashboardPage user={user} />
      )}
    </Layout>
  )
}
