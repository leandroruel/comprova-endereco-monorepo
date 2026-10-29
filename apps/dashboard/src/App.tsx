import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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

  return (
    <QueryClientProvider client={queryClient}>
      {page === 'bulk' ? (
        <BulkSearchPage onNavigate={setPage} />
      ) : page === 'debug-nf3e-qrcode' ? (
        <DebugNf3eQrCodePage onNavigate={setPage} />
      ) : (
        <Dashboard onNavigate={setPage} />
      )}
    </QueryClientProvider>
  )
}
