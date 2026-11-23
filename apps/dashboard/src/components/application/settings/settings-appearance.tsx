'use client'

import { useTemplateCopy } from '@/components/foundations/template-copy/template-copy'

import { useState } from 'react'
import { Switch } from '@/components/base/switch/switch'
import { applyTheme, currentTheme } from '@/components/application/theme/theme-toggle'
import { SettingsCard, SettingsRow } from './settings-rows'

/**
 * Figma source: Board UI → "Settings/Appearance" (light variant).
 *
 * Single toggle to switch between light and dark theme. The theme is
 * persisted in localStorage and applied to `<html>` via `applyTheme`.
 */
export function SettingsAppearance() {
  const localize = useTemplateCopy()
  const [isDark, setIsDark] = useState(currentTheme() === 'dark')

  const handleChange = (next: boolean) => {
    setIsDark(next)
    applyTheme(next ? 'dark' : 'light')
  }

  return localize(
    <div className="flex w-full flex-col gap-3">
      <SettingsCard className="p-6">
        <SettingsRow label="Tema">
          <Switch aria-label="Alternar tema" isSelected={isDark} onChange={handleChange} />
        </SettingsRow>
      </SettingsCard>
      <p className="px-3 text-body-2-regular text-text-secondary">
        O tema é lembrado no seu navegador e aplicado em toda a aplicação.
      </p>
    </div>,
  )
}
