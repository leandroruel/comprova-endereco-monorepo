import { type ReactNode, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { cn } from '@/lib/utils'
import {
  Activity,
  ChevronRight,
  ChevronsUpDown,
  FileSearch,
  Globe,
  LogOut,
  Settings,
  User,
} from 'lucide-react'

interface NavItem {
  readonly id: string
  readonly label: string
  readonly icon: ReactNode
}

const baseNavItems: readonly NavItem[] = [
  { id: 'validations', label: 'Validações', icon: <FileSearch className="h-4 w-4" /> },
  { id: 'bulk', label: 'Busca em lote', icon: <Activity className="h-4 w-4" /> },
]

const adminNavItems: readonly NavItem[] = [
  { id: 'debug-nf3e-qrcode', label: 'QRCode NF3e debugger', icon: <Activity className="h-4 w-4" /> },
]

const initialsOf = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''
  return (first + last).toUpperCase() || '?'
}

const menuItemClass =
  'flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 motion-reduce:transition-none'

function UserMenu({
  userEmail,
  onNavigate,
  onLogout,
}: {
  readonly userEmail?: string
  readonly onNavigate?: (page: string) => void
  readonly onLogout?: () => void
}) {
  const hasIdentity = userEmail !== undefined && userEmail.length > 0
  const displayName = hasIdentity ? (userEmail.split('@')[0] ?? userEmail) : 'Conta'
  const showEmail = hasIdentity && userEmail.includes('@')

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Menu do usuário"
          className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-[10px] font-semibold text-foreground">
            {initialsOf(displayName)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">{displayName}</span>
            {showEmail && (
              <span className="block truncate text-[11px] text-muted-foreground">{userEmail}</span>
            )}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-sidebar-muted" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="animate-fade-in z-50 min-w-[11rem] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md motion-reduce:animate-none"
        >
          <DropdownMenu.Item className={menuItemClass} onSelect={() => onNavigate?.('profile')}>
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            Perfil
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemClass} onSelect={() => onNavigate?.('settings')}>
            <Settings className="h-3.5 w-3.5 text-muted-foreground" />
            Configurações
          </DropdownMenu.Item>
          {onLogout && (
            <>
              <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />
              <DropdownMenu.Item
                className={cn(
                  menuItemClass,
                  'text-destructive focus:bg-destructive/10 focus:text-destructive',
                )}
                onSelect={onLogout}
              >
                <LogOut className="h-3.5 w-3.5" />
                Sair
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function DashboardLayout({
  children,
  onLogout,
  userEmail,
  userRole,
  onNavigate,
  activePage,
}: {
  children: ReactNode
  onLogout?: () => void
  userEmail?: string
  userRole?: string
  onNavigate?: (page: string) => void
  activePage?: string
}) {
  const [active, setActive] = useState(activePage ?? 'validations')
  const navItems = userRole === 'admin' ? [...baseNavItems, ...adminNavItems] : baseNavItems

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-5">
          <Globe className="h-5 w-5 text-emerald-600" />
          <span className="text-sm font-bold tracking-tight">comprova</span>
          <span className="text-[10px] font-medium uppercase tracking-widest text-sidebar-muted">
            .endereco
          </span>
        </div>

        <nav className="flex-1 space-y-0.5 px-2 py-3">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setActive(item.id)
                onNavigate?.(item.id)
              }}
              className={cn(
                'group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
                active === item.id
                  ? 'bg-sidebar-accent text-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
              )}
            >
              <span
                className={cn(
                  'shrink-0 transition-colors',
                  active === item.id
                    ? 'text-foreground'
                    : 'text-muted-foreground group-hover:text-foreground',
                )}
              >
                {item.icon}
              </span>
              {item.label}
              {active === item.id && <ChevronRight className="ml-auto h-3 w-3 text-muted-foreground" />}
            </button>
          ))}
        </nav>

        <div className="border-t border-sidebar-border p-4">
          <UserMenu userEmail={userEmail} onNavigate={onNavigate} onLogout={onLogout} />
        </div>
      </aside>

      <div className="flex-1 lg:pl-56">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Validações</span>
            <ChevronRight className="h-3 w-3" />
            <span>Fast path</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="text-muted-foreground">API online</span>
            </div>
            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
              v2026.13.1
            </span>
          </div>
        </header>

        <main className="p-6">{children}</main>
      </div>
    </div>
  )
}
