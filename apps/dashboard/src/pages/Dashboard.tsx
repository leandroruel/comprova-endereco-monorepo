import { type SessionUser } from '@/api/auth'
import HomePage from '@/pages/Home'
import { BulkSearchPage } from '@/pages/BulkSearch'
import { DebugNf3eQrCodePage } from '@/pages/DebugNf3eQrCode'
import OrganizationsPage from '@/pages/Organizations'
import Validations from '@/pages/Validations'

type PageKey = 'home' | 'validations' | 'bulk' | 'organizations' | 'debug-nf3e-qrcode'

interface DashboardProps {
  page: PageKey
  user?: SessionUser
  onNavigate?: (page: string) => void
}

export default function Dashboard({ page, user, onNavigate }: DashboardProps) {
  switch (page) {
    case 'home':
      return <HomePage user={user} onNavigate={onNavigate} />
    case 'validations':
      return <Validations user={user} onNavigate={onNavigate} />
    case 'bulk':
      return <BulkSearchPage onNavigate={onNavigate} user={user} />
    case 'organizations':
      return <OrganizationsPage onNavigate={onNavigate} user={user} />
    case 'debug-nf3e-qrcode':
      return <DebugNf3eQrCodePage onNavigate={onNavigate} user={user} />
    default:
      return <HomePage user={user} onNavigate={onNavigate} />
  }
}
