import { useState } from 'react'
import {
  LogOut,
  LayoutDashboard,
  Users,
  ShieldCheck,
  FileKey,
  Mail,
  ChevronRight,
  Menu,
  X,
  CircleUser,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { Badge } from '@/components/ui'

interface LayoutProps {
  user: { id: string; email: string; name: string; role: string }
  onLogout: () => void
  currentRoute: Route
  setRoute: (route: Route) => void
  children: React.ReactNode
}

type Route = 'login' | 'onboarding' | 'dashboard' | 'members' | 'integrations'

const navItems: Array<{ label: string; route: Route; icon: React.ElementType }> = [
  { label: 'Visão geral', route: 'dashboard', icon: LayoutDashboard },
  { label: 'Membros', route: 'members', icon: Users },
  { label: 'Integrações', route: 'integrations', icon: ShieldCheck },
]

export function Layout({ user, onLogout, currentRoute, setRoute, children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="min-h-screen bg-background">
      <nav className="fixed left-0 top-0 h-full w-64 bg-card border-r border-border z-20 transform translate-x-0 transition-transform duration-200 md:translate-x-0 lg:static lg:inset-0">
        <div className="flex items-center justify-between h-14 px-6 border-b border-background">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold tracking-tight">comprova</span>
            <span className="ml-1 text-sm text-muted-foreground">.endereco</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex h-full flex-col py-6 overflow-y-auto">
          <div className="px-4 space-y-2">
            <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Organização
            </p>
            {navItems.map((item) => (
              <button
                key={item.route}
                onClick={() => {
                  setRoute(item.route)
                  setSidebarOpen(false)
                }}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  currentRoute === item.route
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </button>
            ))}
          </div>
          <div className="mt-auto px-4 pb-6 space-y-2">
            <Separator />
            <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Conta
            </p>
            <button
              onClick={onLogout}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-red-50"
            >
              <LogOut className="h-4 w-4 shrink-0 text-destructive" />
              Sair
            </button>
          </div>
        </div>
      </nav>

      {/* Overlay para mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-10 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Conteúdo principal */}
      <div className={`md:pl-64 lg:pl-0 min-h-screen ${sidebarOpen ? 'translate-x-[256px]' : ''} transition-transform duration-200`}>
        {/* Header mobile */}
        <div className="lg:hidden flex items-center justify-between h-14 px-4 border-b border-background">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 text-muted-foreground hover:text-foreground"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium overflow-hidden">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="hidden md:flex flex-col items-end">
              <span className="text-sm font-medium">{user.name}</span>
              <span className="text-xs text-muted-foreground">{user.email}</span>
            </div>
          </div>
        </div>

        <main className="p-6 lg:p-8">{children}</main>
      </div>
    </div>
  )
}

function Separator({ className, ...props }: React.ComponentPropsWithoutRef<'hr'>) {
  return <hr className="my-4 h-px bg-border" {...props} />
}
