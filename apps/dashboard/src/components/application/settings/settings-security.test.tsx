import { page } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

const { changePasswordMock } = vi.hoisted(() => ({ changePasswordMock: vi.fn() }))

vi.mock('@/api/auth', () => ({
  authClient: { changePassword: changePasswordMock },
}))

import { SettingsSecurity } from './settings-security'
import { describeAuthError } from '@/lib/auth-errors'

const fillForm = async ({
  current = 'SenhaAtual123!',
  next = 'NovaSenhaForte456#',
  confirm = next,
}: {
  current?: string
  next?: string
  confirm?: string
} = {}) => {
  await page.getByLabelText('Senha atual').fill(current)
  await page.getByLabelText('Nova senha').fill(next)
  await page.getByLabelText('Confirmar nova senha').fill(confirm)
}

// Increase test timeout for browser initialization (flaky in CI)
vi.setConfig({ testTimeout: 120_000 })

describe('SettingsSecurity', () => {
  it('renderiza o formulário com os três campos', async () => {
    await render(<SettingsSecurity />)

    await expect.element(page.getByLabelText('Senha atual')).toBeVisible()
    await expect.element(page.getByLabelText('Nova senha')).toBeVisible()
    await expect.element(page.getByLabelText('Confirmar nova senha')).toBeVisible()
    await expect.element(page.getByRole('button', { name: /Alterar senha/ })).toBeDisabled()
  })

  it('mostra erro inline quando a confirmação não coincide', async () => {
    await render(<SettingsSecurity />)

    await fillForm({ confirm: 'Diferente789$' })

    await expect.element(page.getByText('As senhas não coincidem.')).toBeVisible()
    await expect.element(page.getByRole('button', { name: /Alterar senha/ })).toBeDisabled()
    expect(changePasswordMock).not.toHaveBeenCalled()
  })

  it('altera a senha com revokeOtherSessions e exibe confirmação', async () => {
    changePasswordMock.mockResolvedValue({ data: { token: 'novo-token', user: { id: '1' } }, error: null })
    await render(<SettingsSecurity />)

    await fillForm()
    await page.getByRole('button', { name: /Alterar senha/ }).click()

    expect(changePasswordMock).toHaveBeenCalledWith({
      currentPassword: 'SenhaAtual123!',
      newPassword: 'NovaSenhaForte456#',
      revokeOtherSessions: true,
    })
    await expect.element(page.getByText('Senha alterada.', { exact: false })).toBeVisible()
  })

  it('mapeia INVALID_PASSWORD para mensagem amigável', async () => {
    changePasswordMock.mockResolvedValue({
      data: null,
      error: { code: 'INVALID_PASSWORD', message: 'Invalid password', status: 400 },
    })
    await render(<SettingsSecurity />)

    await fillForm()
    await page.getByRole('button', { name: /Alterar senha/ }).click()

    await expect.element(page.getByText('Senha atual incorreta.')).toBeVisible()
    await expect.element(page.getByText('Senha alterada.', { exact: false })).not.toBeInTheDocument()
  })

  it('mapeia códigos do Better Auth sem depender da mensagem em inglês', () => {
    expect(describeAuthError('INVALID_PASSWORD')).toBe('Senha atual incorreta.')
    expect(describeAuthError('PASSWORD_TOO_SHORT')).toContain('mínimo 8')
    expect(describeAuthError('PASSWORD_TOO_LONG')).toContain('longa demais')
    expect(describeAuthError('CREDENTIAL_ACCOUNT_NOT_FOUND')).toContain('administrador')
    expect(describeAuthError(undefined)).toContain('Tente novamente')
    expect(describeAuthError('OUTRO_CODIGO', 'Fallback da API')).toBe('Fallback da API')
  })
})
