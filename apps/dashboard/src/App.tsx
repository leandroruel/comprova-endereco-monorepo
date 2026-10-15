import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Dashboard from '@/pages/Dashboard'
import { BulkSearchPage } from '@/pages/BulkSearch'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
})

export default function App() {
  const [page, setPage] = useState<'dashboard' | 'bulk' | string>('dashboard')

  return (
    <QueryClientProvider client={queryClient}>
      {page === 'bulk' ? <BulkSearchPage /> : <Dashboard onNavigate={setPage} />}
    </QueryClientProvider>
  )
}
