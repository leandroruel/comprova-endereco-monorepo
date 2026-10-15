import { type ReactNode, useState } from 'react'
import { cn } from '@/lib/utils'
import { Activity, Building2, ChevronRight, FileSearch, Globe, Home, Settings } from 'lucide-react'
import { LogOut } from 'lucide-react'

interface NavItem {
  readonly id: string
  readonly label: string
  readonly icon: ReactNode
}

const navItems: readonly NavItem[] = [
  { id: 'validations', label: 'Validações', icon: <FileSearch className="h-4 w-4" /> },
  { id: 'bulk', label: 'Busca em lote', icon: <Activity className="h-4 w-4" /> },
]

export function DashboardLayout({
  children,
  onLogout,
  userEmail,
  onNavigate,
  activePage,
}: {
  children: ReactNode
  onLogout?: () => void
  userEmail?: string
  onNavigate?: (page: string) => void
  activePage?: string
}) {
  const [active, setActive] = useState(activePage ?? 'validations')

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
          {userEmail && (
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate font-medium text-foreground">{userEmail.split('@')[0]}</span>
            </div>
          )}
          {onLogout && (
            <button
              onClick={onLogout}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            >
              <LogOut className="h-3 w-3" />
              Sair
            </button>
          )}
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
