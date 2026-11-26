import { page } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import { render as renderRaw } from 'vitest-browser-react'
import { AppProviders } from '@/test-utils/app-providers'
import { DashboardLayout } from './layout'

const render = (ui: Parameters<typeof renderRaw>[0]) => renderRaw(<AppProviders>{ui}</AppProviders>)

const userMenu = () => page.getByRole('button', { name: 'Menu do usuário' })

describe('DashboardLayout', () => {
  it('renderiza a navegação lateral', async () => {
    await render(
      <DashboardLayout userRole="user">
        <div>conteúdo da página</div>
      </DashboardLayout>,
    )

    await expect.element(page.getByText('conteúdo da página', { exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Validações' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Busca em lote' })).toBeVisible()
  })

  it('omite o item QRCode NF3e debugger quando o usuário não é admin', async () => {
    await render(<DashboardLayout userRole="user">conteúdo</DashboardLayout>)

    await expect.element(page.getByRole('button', { name: 'Validações' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Busca em lote' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'QRCode NF3e debugger' })).not.toBeInTheDocument()
  })

  it('mostra o item QRCode NF3e debugger quando o usuário é admin', async () => {
    await render(<DashboardLayout userRole="admin">conteúdo</DashboardLayout>)

    await expect.element(page.getByRole('button', { name: 'QRCode NF3e debugger' })).toBeVisible()
  })

  it('identifica o usuário no gatilho do menu e alterna o estado acessível', async () => {
    await render(<DashboardLayout userEmail="ana.souza@empresa.com">conteúdo</DashboardLayout>)

    const trigger = userMenu()
    await expect.element(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect.element(trigger.getByText('ana.souza', { exact: true })).toBeVisible()
    await expect.element(trigger.getByText('ana.souza@empresa.com', { exact: true })).toBeVisible()
    await expect.element(trigger.getByText('A', { exact: true })).toBeVisible()

    const triggerEl = trigger.element()
    await trigger.click()

    await expect.poll(() => triggerEl.getAttribute('aria-expanded')).toBe('true')
  })

  it('cai em "Conta" quando não há e-mail', async () => {
    await render(<DashboardLayout>conteúdo</DashboardLayout>)

    const trigger = userMenu()
    await expect.element(trigger.getByText('Conta', { exact: true })).toBeVisible()
    await expect.element(trigger.getByText('C', { exact: true })).toBeVisible()
  })

  it('prefere o nome do usuário ao apelido derivado do e-mail', async () => {
    await render(
      <DashboardLayout userName="Leandro Rocha" userEmail="leandro@empresa.com">
        conteúdo
      </DashboardLayout>,
    )

    const trigger = userMenu()
    await expect.element(trigger.getByText('Leandro Rocha', { exact: true })).toBeVisible()
    await expect.element(trigger.getByText('leandro@empresa.com', { exact: true })).toBeVisible()
    await expect.element(trigger.getByText('LR', { exact: true })).toBeVisible()
    await expect(trigger.getByText('leandro', { exact: true })).not.toBeInTheDocument()
  })

  it('não usa "Conta" quando recebe nome mesmo sem e-mail', async () => {
    await render(<DashboardLayout userName="Leandro">conteúdo</DashboardLayout>)

    const trigger = userMenu()
    await expect.element(trigger.getByText('Leandro', { exact: true })).toBeVisible()
    await expect(trigger.getByText('Conta', { exact: true })).not.toBeInTheDocument()
  })

  it('abre o menu com Perfil e Configurações', async () => {
    await render(<DashboardLayout userEmail="ana@empresa.com">conteúdo</DashboardLayout>)

    await userMenu().click()
    await expect.element(page.getByRole('menuitem', { name: /Perfil/ })).toBeVisible()
    await expect.element(page.getByRole('menuitem', { name: /Configurações/ })).toBeVisible()
  })

  it('mostra a ação destrutiva de sair apenas quando há onLogout', async () => {
    const onLogout = vi.fn()
    await render(
      <DashboardLayout userEmail="ana@empresa.com" onLogout={onLogout}>
        conteúdo
      </DashboardLayout>,
    )

    await userMenu().click()
    await expect.element(page.getByRole('menuitem', { name: /Perfil/ })).toBeVisible()
    await page.getByRole('menuitem', { name: /Sair/ }).click()

    expect(onLogout).toHaveBeenCalledTimes(1)
  })

  it('omite "Sair" quando o logout não está conectado', async () => {
    await render(<DashboardLayout userEmail="ana@empresa.com">conteúdo</DashboardLayout>)

    await userMenu().click()
    await expect.element(page.getByRole('menuitem', { name: /Perfil/ })).toBeVisible()
    await expect.element(page.getByRole('menuitem', { name: /Sair/ })).not.toBeInTheDocument()
  })
})
