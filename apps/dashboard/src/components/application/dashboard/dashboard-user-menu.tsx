"use client";

import { useTemplateCopy } from "@/components/foundations/template-copy/template-copy";

import { RiBuilding2Line, RiHomeLine, RiSettings4Line } from "@remixicon/react";
import type { ReactNode } from "react";
import { Avatar } from "@/components/base/avatar/avatar";
import {
  Dropdown,
  DropdownDivider,
  DropdownGroup,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { ChevronUpDownSmall } from "@/components/foundations/icons/chevrons";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → sidebar account menu (node 3828:3895).
 *
 * Workspace switcher at the top of the sidebar. Shows the signed-in tenant
 * (avatar/logo + name) and opens the workspace panel with the areas the
 * account can reach.
 */

export interface SidebarWorkspace {
  name: string;
  email?: string;
  initials?: string;
}

const DEFAULT_WORKSPACE: SidebarWorkspace = {
  name: "comprova",
  email: "painel administrativo",
  initials: "C",
};

/** Label slot on the trigger: blurs + fades away as the rail collapses. */
function Collapsible({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  const localize = useTemplateCopy();
  return localize((
    <span
      className={cx(
        "flex min-w-0 items-center overflow-hidden transition-[max-width,opacity,filter] duration-300 ease-in-out",
        collapsed ? "max-w-0 opacity-0 blur-[3px]" : "max-w-40 opacity-100 blur-0",
      )}
    >
      {children}
    </span>
  ));
}

export function DashboardUserMenu({
  collapsed = false,
  suppressHover = false,
  onHoverSuppressionEnd,
  avatarClassName,
  workspace = DEFAULT_WORKSPACE,
  onNavigate,
  onOpenSettings,
}: {
  collapsed?: boolean;
  /** Prevents expansion from creating a hover state under a stationary pointer. */
  suppressHover?: boolean;
  /** Re-arms hover after the pointer fully leaves the trigger. */
  onHoverSuppressionEnd?: () => void;
  avatarClassName?: string;
  workspace?: SidebarWorkspace;
  onNavigate?: (page: string) => void;
  onOpenSettings?: () => void;
}) {
  const localize = useTemplateCopy();

  return localize((
    <Dropdown>
      <DropdownTrigger
        aria-label="Menu do workspace"
        onPointerLeave={() => {
          if (suppressHover) onHoverSuppressionEnd?.();
        }}
        className={cx(
          "relative flex min-w-0 cursor-pointer items-center gap-2 rounded-full",
          // Hover pill (Figma node 3829:4063): a fully-rounded 2px
          // border/button/hover outline drawn via a pseudo-element so it never
          // shifts the layout.
          "before:pointer-events-none before:absolute before:-inset-x-1.5 before:-inset-y-[5px] before:rounded-full before:border-2 before:border-transparent before:transition-colors before:duration-150",
          !suppressHover && "hover:before:border-border-sidebar-profile-hover",
          // Collapsed, the trigger takes the rail's own 36px column and centres
          // the 32px avatar in it, instead of sizing to the avatar plus a gap
          // held open for a label that's shrunk to nothing.
          collapsed && "w-9 justify-center gap-0 before:-inset-x-[3px]",
        )}
      >
        <Avatar size="md" color="neutral" initials={workspace.initials ?? "C"} className={avatarClassName} />
        <Collapsible collapsed={collapsed}>
          <span className="flex items-center gap-0.5">
            <span className="text-body-medium whitespace-nowrap text-text-primary">{workspace.name}</span>
            <ChevronUpDownSmall className="size-4 shrink-0 text-foreground-icon-tertiary" />
          </span>
        </Collapsible>
      </DropdownTrigger>

      <DropdownPopover
        aria-label="Menu do workspace"
        placement="right top"
        offset={8}
        className="w-[265px]"
        dialogClassName="gap-1.5"
      >
        {/* Workspace header */}
        <div className="flex w-full items-center gap-2 px-2 pt-1">
          <Avatar size="md" color="neutral" initials={workspace.initials ?? "C"} />
          <div className="flex min-w-0 flex-col items-start justify-center">
            <span className="text-body-medium whitespace-nowrap text-text-primary">{workspace.name}</span>
            {workspace.email && (
              <span className="text-body-regular whitespace-nowrap text-text-secondary">{workspace.email}</span>
            )}
          </div>
        </div>

        <DropdownDivider />

        <DropdownGroup label="Navegação">
          <DropdownItem onSelect={() => onNavigate?.("home")}>
            <RiHomeLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <span className="truncate text-body-medium text-text-primary">Principal</span>
          </DropdownItem>
          <DropdownItem onSelect={() => onNavigate?.("organizations")}>
            <RiBuilding2Line className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <span className="truncate text-body-medium text-text-primary">Organizações</span>
          </DropdownItem>
          <DropdownItem onSelect={onOpenSettings}>
            <RiSettings4Line className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <span className="truncate text-body-medium text-text-primary">Configurações</span>
          </DropdownItem>
        </DropdownGroup>
      </DropdownPopover>
    </Dropdown>
  ));
}
