'use client'

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useTemplateCopy } from '@/components/foundations/template-copy/template-copy'

import { RiLogoutBoxRLine, RiPaletteLine, RiSettings4Line, RiUserSmileLine } from '@remixicon/react'
import { Avatar } from '@/components/base/avatar/avatar'
import { ChevronDownSmall } from '@/components/foundations/icons/chevrons'
import { ThemeToggle } from '@/components/application/theme/theme-toggle'
import { cn } from '@/lib/utils'

/**
 * Figma source: Board UI → sidebar profile menu (node 3823:3699).
 *
 * Card at the bottom of the sidebar with the signed-in user (avatar + name +
 * email). Opens the account menu: profile, settings and sign out.
 */

export interface SidebarUser {
  name?: string | null
  email?: string | null
  role?: string | null
}

const displayNameOf = (user: SidebarUser): string => {
  const name = user.name?.trim()
  if (name !== undefined && name.length > 0) return name
  const email = user.email?.trim()
  if (email !== undefined && email.length > 0) {
    const local = email.split('@')[0]?.trim()
    if (local !== undefined && local.length > 0) return local
  }
  return 'Conta'
}

const initialsOf = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''
  return (first + last).toUpperCase() || '?'
}

const menuItemClass = cn(
  'flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none transition-colors',
  'focus:bg-accent focus:text-accent-foreground motion-reduce:transition-none',
)

export function DashboardTeamMenu({
  collapsed = false,
  className,
  user = {},
  onNavigate,
  onSignOut,
}: {
  collapsed?: boolean
  className?: string
  user?: SidebarUser
  onNavigate?: (page: string) => void
  onSignOut?: () => void
}) {
  const localize = useTemplateCopy()
  const displayName = displayNameOf(user)
  const initials = initialsOf(displayName)
  const showEmail = user.email !== undefined && user.email !== null && user.email.includes('@')

  return localize(
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Menu do usuário"
          className={cn(
            'flex cursor-pointer items-center overflow-hidden',
            'border-2 border-transparent hover:border-border-button-hover',
            'transition-[width,background-color,border-color,padding] duration-300 ease-in-out',
            collapsed
              ? 'size-9 justify-start rounded-full bg-transparent p-0'
              : 'w-full justify-between rounded-xl bg-background-tertiary-default py-2 pe-4 ps-2.5',
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Avatar size="md" color="blue" initials={initials} />
            <span
              className={cn(
                'flex min-w-0 flex-col items-start justify-center overflow-hidden transition-[max-width,opacity,filter] duration-300 ease-in-out',
                collapsed ? 'max-w-0 opacity-0 blur-[3px]' : 'max-w-40 opacity-100 blur-0',
              )}
            >
              <span className="text-body-medium whitespace-nowrap text-text-primary">{displayName}</span>
              {showEmail && (
                <span className="text-body-regular whitespace-nowrap text-text-secondary">{user.email}</span>
              )}
            </span>
          </span>
          <span
            className={cn(
              'flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[3px] bg-background-tertiary-hover transition-[max-width,opacity] duration-300 ease-in-out',
              collapsed ? 'max-w-0 opacity-0' : 'max-w-4 opacity-100',
            )}
          >
            <ChevronDownSmall className="size-4 text-text-secondary" />
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="start"
          sideOffset={8}
          className={cn(
            'w-[265px] rounded-2xl border border-border-button-default bg-background-primary-default p-2.5 shadow-dropdown',
            className,
          )}
        >
          {/* Account header */}
          <div className="flex w-full items-center gap-2 px-2 pt-1">
            <Avatar size="md" color="blue" initials={initials} />
            <div className="flex min-w-0 flex-col items-start justify-center">
              <span className="text-body-medium whitespace-nowrap text-text-primary">{displayName}</span>
              {showEmail && (
                <span className="text-body-regular whitespace-nowrap text-text-secondary">{user.email}</span>
              )}
            </div>
          </div>

          <div className="-mx-2.5 my-2.5 h-px shrink-0 bg-border-button-default" />

          <DropdownMenu.Item
            className={menuItemClass}
            onSelect={() => {
              onNavigate?.('profile')
            }}
          >
            <RiUserSmileLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <span className="truncate text-body-medium text-text-primary">Perfil</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={menuItemClass}
            onSelect={() => {
              onNavigate?.('settings')
            }}
          >
            <RiSettings4Line className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <span className="truncate text-body-medium text-text-primary">Configurações</span>
          </DropdownMenu.Item>
          {onSignOut && (
            <DropdownMenu.Item
              className={cn(menuItemClass, 'text-destructive focus:bg-destructive/10 focus:text-destructive')}
              onSelect={onSignOut}
            >
              <RiLogoutBoxRLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
              <span className="truncate text-body-medium text-text-primary">Sair</span>
            </DropdownMenu.Item>
          )}

          {/* Aparência */}
          <div className="-mx-2.5 my-2.5 h-px shrink-0 bg-border-button-default" />
          <DropdownMenu.Item className={menuItemClass}>
            <div className="flex items-center justify-between gap-2.5 rounded-2lg px-2 py-1">
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <RiPaletteLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
                <span className="truncate text-body-medium text-text-primary">Aparência</span>
              </span>
              <ThemeToggle appearance="segmented" size="small" className="shrink-0" />
            </div>
          </DropdownMenu.Item>

          {/* Footer */}
          <div className="flex w-full items-center justify-between px-2 pb-2 pt-1">
            <span className="text-body-2-medium whitespace-nowrap text-text-tertiary">comprova</span>
            <span className="inline-flex items-center justify-center rounded-sm bg-background-tertiary-default px-1 py-px text-body-2-medium whitespace-nowrap text-text-tertiary">
              v2026.13.1
            </span>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>,
  )
}
