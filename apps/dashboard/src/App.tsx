import { useState, useEffect, useCallback } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { authClient, type SessionUser } from '@/api/auth'
import { AlertProvider } from '@/components/base/alert/alert-context'
import { ConsoleProvider } from '@/components/console/console-context'
import { Spinner } from '@/components/ui'
import { DashboardLayout } from '@/components/layout'
import Dashboard from '@/pages/Dashboard'
import { LoginPage } from '@/pages/Login'

type PageKey = 'home' | 'validations' | 'bulk' | 'organizations' | 'debug-nf3e-qrcode'

const PAGE_PATHS: Record<PageKey, string> = {
  home: '/',
  validations: '/validations',
  bulk: '/bulk',
  organizations: '/organizations',
  'debug-nf3e-qrcode': '/debug-nf3e-qrcode',
}

const PATH_TO_PAGE: Record<string, PageKey> = {
  '/': 'home',
  '/home': 'home',
  '/validations': 'validations',
  '/bulk': 'bulk',
  '/organizations': 'organizations',
  '/debug-nf3e-qrcode': 'debug-nf3e-qrcode',
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
})

export default function App() {
  return <AuthedApp />
}

function AuthedApp() {
  const [page, setPageState] = useState<PageKey>('home')
  const { data: session, isPending } = authClient.useSession()
  const user: SessionUser | undefined = session?.user

  // Sincroniza a página com a URL ao montar e ao navegar pelo histórico do navegador.
  useEffect(() => {
    const onPopState = () => {
      const pageFromPath = PATH_TO_PAGE[window.location.pathname]
      if (pageFromPath) {
        setPageState(pageFromPath)
      }
    }

    const initialPage = PATH_TO_PAGE[window.location.pathname] ?? 'home'
    setPageState(initialPage)

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Atualiza a URL quando a página muda internamente.
  const setPage = useCallback((nextPage: string) => {
    const pageKey = nextPage as PageKey
    if (!(pageKey in PAGE_PATHS)) return
    setPageState(pageKey)
    window.history.pushState(null, '', PAGE_PATHS[pageKey])
  }, [])

  if (isPending) {
    return (
      <QueryClientProvider client={queryClient}>
        <div className="flex min-h-screen items-center justify-center bg-background">
          <Spinner />
        </div>
      </QueryClientProvider>
    )
  }

  if (!session?.user) {
    return (
      <QueryClientProvider client={queryClient}>
        <LoginPage onSuccess={() => void authClient.getSession()} />
      </QueryClientProvider>
    )
  }

  return (
    <AlertProvider>
      <ConsoleProvider>
        <QueryClientProvider client={queryClient}>
          <DashboardLayout
            activePage={page}
            onNavigate={setPage}
            userName={user?.name ?? undefined}
            userEmail={user?.email ?? undefined}
            userRole={user?.role ?? undefined}
            onLogout={() => {
              void authClient
                .signOut()
                .then(() => window.location.reload())
                .catch(() => window.location.reload())
            }}
          >
            <Dashboard page={page} user={user} onNavigate={setPage} />
          </DashboardLayout>
        </QueryClientProvider>
      </ConsoleProvider>
    </AlertProvider>
  )
}
