import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { BoardUIThemeProvider } from '@/components/ui/boardui-theme-provider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BoardUIThemeProvider defaultDark>
      <App />
    </BoardUIThemeProvider>
  </StrictMode>,
)
