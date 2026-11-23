import { type ReactNode, useMemo, useState } from 'react'
import { DashboardSidebar } from '@/components/application/dashboard/dashboard-sidebar'
import type { DashboardNavItem } from '@/components/application/dashboard/dashboard-sidebar'
import { RiBuildingLine, RiChatAiLine, RiFileSearchLine, RiHomeLine, RiQrCodeLine } from '@remixicon/react'

/** Itens de navegação da SPA: usam `onSelect` (render <button>) em vez de `href` (render <a>). */
const baseNavItems: readonly DashboardNavItem[] = [
  { key: 'home', label: 'Principal', icon: RiHomeLine, onSelect: () => {} },
  { key: 'validations', label: 'Validações', icon: RiFileSearchLine, onSelect: () => {} },
  { key: 'bulk', label: 'Busca em lote', icon: RiChatAiLine, onSelect: () => {} },
  { key: 'organizations', label: 'Organizações', icon: RiBuildingLine, onSelect: () => {} },
]

const adminNavItems: readonly DashboardNavItem[] = [
  { key: 'debug-nf3e-qrcode', label: 'QRCode NF3e debugger', icon: RiQrCodeLine, onSelect: () => {} },
]

export function DashboardLayout({
  children,
  onLogout,
  userName,
  userEmail,
  userRole,
  onNavigate,
  activePage,
}: {
  children: ReactNode
  onLogout?: () => void
  userName?: string
  userEmail?: string
  userRole?: string
  onNavigate?: (page: string) => void
  activePage?: string
}) {
  const [active, setActive] = useState(activePage ?? 'home')

  const navigate = (page: string) => {
    setActive(page)
    onNavigate?.(page)
  }

  const navItems = useMemo<readonly DashboardNavItem[]>(() => {
    const items = userRole === 'admin' ? [...baseNavItems, ...adminNavItems] : baseNavItems
    return items.map((item) => ({
      ...item,
      onSelect: () => navigate(item.key),
    }))
  }, [userRole, navigate])

  const workspace = {
    name: 'comprova',
    email: 'painel administrativo',
    initials: 'C',
  }

  const user = useMemo(
    () => ({
      name: userName,
      email: userEmail,
      role: userRole,
    }),
    [userName, userEmail, userRole],
  )

  return (
    <div className="flex min-h-screen w-full bg-background-full">
      <DashboardSidebar
        className="sticky top-3 m-3 hidden h-[calc(100vh-24px)] shrink-0 lg:flex"
        selected={active}
        items={navItems}
        user={user}
        workspace={workspace}
        onNavigate={navigate}
        onSignOut={onLogout}
      />

      <div className="min-w-0 flex-1">
        <div className="flex w-full pt-10 pb-14 px-6 sm:px-10">
          <main className="w-full min-w-0 flex-col gap-3">{children}</main>
        </div>
      </div>
    </div>
  )
}
