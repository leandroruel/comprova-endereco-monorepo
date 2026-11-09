import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { authClient, type SessionUser } from '@/api/auth'
import { Spinner } from '@/components/ui'
import { DashboardLayout } from '@/components/layout'
import Dashboard from '@/pages/Dashboard'
import HomePage from '@/pages/Home'
import { BulkSearchPage } from '@/pages/BulkSearch'
import { DebugNf3eQrCodePage } from '@/pages/DebugNf3eQrCode'
import OrganizationsPage from '@/pages/Organizations'
import { LoginPage } from '@/pages/Login'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
})

export default function App() {
  const [page, setPage] = useState('home')
  const { data: session, isPending } = authClient.useSession()
  const user: SessionUser | undefined = session?.user

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
    <QueryClientProvider client={queryClient}>
      <DashboardLayout
        activePage={page}
        onNavigate={setPage}
        userName={user?.name ?? undefined}
        userEmail={user?.email ?? undefined}
        userRole={user?.role ?? undefined}
        onLogout={() => {
          void authClient.signOut().then(() => window.location.reload()).catch(() => window.location.reload())
        }}
      >
        {page === 'home' ? (
          <HomePage user={user} onNavigate={setPage} />
        ) : page === 'bulk' ? (
          <BulkSearchPage onNavigate={setPage} user={user} />
        ) : page === 'debug-nf3e-qrcode' ? (
          <DebugNf3eQrCodePage onNavigate={setPage} user={user} />
        ) : page === 'organizations' ? (
          <OrganizationsPage onNavigate={setPage} user={user} />
        ) : (
          <Dashboard onNavigate={setPage} user={user} />
        )}
      </DashboardLayout>
    </QueryClientProvider>
  )
}
