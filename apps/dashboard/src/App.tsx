import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Dashboard from '@/pages/Dashboard'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  )
}
