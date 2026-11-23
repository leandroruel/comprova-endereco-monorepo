'use client'

import { useTemplateCopy } from '@/components/foundations/template-copy/template-copy'

import { useRef, useState, type ComponentProps } from 'react'
import { RiExternalLinkLine, RiLogoutCircleLine, RiMailLine } from '@remixicon/react'
import { Button } from '@/components/base/buttons/button'
import { Input } from '@/components/base/input/input'
import { Switch } from '@/components/base/switch/switch'
import { cx } from '@/utils/cx'
import { SettingsCard, SettingsRow, SettingsValueField } from './settings-rows'

/**
 * Figma source: Board UI → "Settings/Profile" (node 4081:13943), the right
 * pane of the settings modal.
 *
 * Two cards, 24px apart:
 *   1. identity   Email / First name / Last name as editable design-system
 *                 Inputs (small, 202px — mail icon on Email)
 *   2. account    BoardUI account → "Manage", Public profile toggle (on),
 *                 Device ID (muted, truncated), Log out from all devices.
 */

/**
 * Design-system Input that commits on Enter / blur: Enter just blurs the
 * field, and blur fires `onSaved` only when the value actually changed since
 * the last commit — so clicking in and out without typing stays silent.
 */
function SavableInput({
  initialValue,
  onSaved,
  ...inputProps
}: { initialValue: string; onSaved?: () => void } & Omit<
  ComponentProps<typeof Input>,
  'value' | 'onChange' | 'defaultValue'
>) {
  const localize = useTemplateCopy()
  const [value, setValue] = useState(initialValue)
  const committed = useRef(initialValue)

  return localize(
    <Input
      size="small"
      {...inputProps}
      value={value}
      onChange={setValue}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLElement).blur()
      }}
      onBlur={() => {
        if (value !== committed.current) {
          committed.current = value
          onSaved?.()
        }
      }}
      className={cx('w-[202px] shrink-0', inputProps.className)}
    />,
  )
}

export function SettingsProfile({ onSaved }: { onSaved?: () => void } = {}) {
  const localize = useTemplateCopy()
  const [publicProfile, setPublicProfile] = useState(true)

  return localize(
    <div className="flex w-full flex-col gap-6">
      <SettingsCard>
        <SettingsRow label="Email">
          <SavableInput
            aria-label="Email"
            type="email"
            leadingIcon={RiMailLine}
            initialValue="leandro.ruel@gmail.com"
            onSaved={onSaved}
          />
        </SettingsRow>
        <SettingsRow label="First name">
          <SavableInput aria-label="First name" initialValue="Leandro" onSaved={onSaved} />
        </SettingsRow>
        <SettingsRow label="Last name">
          <SavableInput aria-label="Last name" initialValue="Ruel" onSaved={onSaved} />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard>
        <SettingsRow label="BoardUI account">
          <Button variant="secondary" size="small" leadingIcon={RiExternalLinkLine}>
            Manage
          </Button>
        </SettingsRow>
        <SettingsRow
          label="Public profile"
          description="When enabled your profile page will be visible to anyone"
        >
          <Switch aria-label="Public profile" isSelected={publicProfile} onChange={setPublicProfile} />
        </SettingsRow>
        <SettingsRow label="Device ID">
          <SettingsValueField muted>593e2611-b9e3-44e2-1289-ab3f9d21</SettingsValueField>
        </SettingsRow>
        <SettingsRow label="Log out from all devices">
          <Button variant="secondary" size="small" leadingIcon={RiLogoutCircleLine}>
            Logout
          </Button>
        </SettingsRow>
      </SettingsCard>
    </div>,
  )
}
