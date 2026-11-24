import { type ReactNode, useMemo } from 'react'
import { Outlet, useNavigate } from '@tanstack/react-router'
import { DashboardSidebar } from '@/components/application/dashboard/dashboard-sidebar'
import type { DashboardNavItem } from '@/components/application/dashboard/dashboard-sidebar'
import { Alerts } from '@/components/base/alert/alert'
import { RiBuildingLine, RiChatAiLine, RiFileSearchLine, RiHomeLine, RiQrCodeLine } from '@remixicon/react'

/** Itens de navegação da SPA. */
const baseNavItems: readonly DashboardNavItem[] = [
  { key: 'home', label: 'Principal', icon: RiHomeLine },
  { key: 'validations', label: 'Validações', icon: RiFileSearchLine },
  { key: 'bulk', label: 'Busca em lote', icon: RiChatAiLine },
  { key: 'organizations', label: 'Organizações', icon: RiBuildingLine },
]

const adminNavItems: readonly DashboardNavItem[] = [
  { key: 'debug-nf3e-qrcode', label: 'QRCode NF3e debugger', icon: RiQrCodeLine },
]

export function DashboardLayout({
  onLogout,
  userName,
  userEmail,
  userRole,
}: {
  onLogout?: () => void
  userName?: string
  userEmail?: string
  userRole?: string
}) {
  const navigateFn = useNavigate()

  const navItems = useMemo<readonly DashboardNavItem[]>(() => {
    const items =
      userRole === 'admin' || userRole === 'superadmin' ? [...baseNavItems, ...adminNavItems] : baseNavItems
    return items.map((item) => ({
      ...item,
      onSelect: () => {
        navigateFn({ to: `/${item.key}` })
      },
    }))
  }, [navigateFn, userRole])

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
        items={navItems}
        user={user}
        workspace={workspace}
        onSignOut={onLogout}
      />

      <div className="min-w-0 flex-1">
        <div className="flex w-full pt-10 pb-14 px-6 sm:px-10">
          <main className="w-full min-w-0 flex-col gap-3">
            <Alerts className="mb-3" />
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}
