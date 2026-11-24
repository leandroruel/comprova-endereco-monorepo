import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { authClient, type SessionUser } from '@/api/auth'
import { AlertProvider } from '@/components/base/alert/alert-context'
import { ConsoleProvider } from '@/components/console/console-context'
import { Spinner } from '@/components/ui'
import { LoginPage } from '@/pages/Login'
import { router } from '@/router'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
})

export default function App() {
  return <AuthedApp />
}

function AuthedApp() {
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

  if (!user) {
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
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ConsoleProvider>
    </AlertProvider>
  )
}
