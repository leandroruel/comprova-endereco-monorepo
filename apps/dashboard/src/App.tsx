import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { authClient, type SessionUser } from '@/api/auth'
import Dashboard from '@/pages/Dashboard'
import { BulkSearchPage } from '@/pages/BulkSearch'
import { DebugNf3eQrCodePage } from '@/pages/DebugNf3eQrCode'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
})

export default function App() {
  const [page, setPage] = useState('validations')
  // Lido aqui (e não em cada página) porque o App fica montado entre as
  // navegações: o sidemenu das outras páginas recebe a identidade já resolvida,
  // sem um novo `/get-session` a cada troca de tela.
  const { data: session } = authClient.useSession()
  const user: SessionUser | undefined = session?.user

  return (
    <QueryClientProvider client={queryClient}>
      {page === 'bulk' ? (
        <BulkSearchPage onNavigate={setPage} user={user} />
      ) : page === 'debug-nf3e-qrcode' ? (
        <DebugNf3eQrCodePage onNavigate={setPage} user={user} />
      ) : (
        <Dashboard onNavigate={setPage} />
      )}
    </QueryClientProvider>
  )
}
