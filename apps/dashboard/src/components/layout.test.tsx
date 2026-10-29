import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { DashboardLayout } from './layout'

const userMenu = () => page.getByRole('button', { name: 'Menu do usuário' })

describe('DashboardLayout', () => {
  it('renderiza o conteúdo e a navegação lateral', async () => {
    await render(<DashboardLayout>conteúdo da página</DashboardLayout>)

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

  it('troca de aba e avisa a navegação ao clicar no menu lateral', async () => {
    const onNavigate = vi.fn()
    await render(<DashboardLayout onNavigate={onNavigate}>conteúdo</DashboardLayout>)

    await page.getByRole('button', { name: 'Busca em lote' }).click()

    expect(onNavigate).toHaveBeenCalledWith('bulk')
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

    // Enquanto o menu está aberto, o Radix marca o resto da página como
    // `aria-hidden` (o gatilho inclusive), então o locator deixa de resolver o
    // papel `button`. A referência capturada antes do clique continua válida.
    await expect.poll(() => triggerEl.getAttribute('aria-expanded')).toBe('true')
  })

  it('cai em "Conta" quando não há e-mail', async () => {
    await render(<DashboardLayout>conteúdo</DashboardLayout>)

    const trigger = userMenu()
    await expect.element(trigger.getByText('Conta', { exact: true })).toBeVisible()
    await expect.element(trigger.getByText('C', { exact: true })).toBeVisible()
  })

  it('abre o menu com Perfil e Configurações e encaminha a navegação', async () => {
    const onNavigate = vi.fn()
    await render(
      <DashboardLayout userEmail="ana@empresa.com" onNavigate={onNavigate}>
        conteúdo
      </DashboardLayout>,
    )

    await userMenu().click()
    await page.getByRole('menuitem', { name: /Perfil/ }).click()

    expect(onNavigate).toHaveBeenCalledWith('profile')

    await userMenu().click()
    await page.getByRole('menuitem', { name: /Configurações/ }).click()

    expect(onNavigate).toHaveBeenCalledWith('settings')
  })

  it('mostra a ação destrutiva de sair apenas quando há onLogout', async () => {
    const onLogout = vi.fn()
    await render(
      <DashboardLayout userEmail="ana@empresa.com" onLogout={onLogout}>
        conteúdo
      </DashboardLayout>,
    )

    await userMenu().click()
    // Perfil existe sempre; "Sair" só com logout conectado.
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

  // Teclado e foco reais (CDP) — a diferença prática do browser mode: no jsdom o
  // Radix não recebia eventos de teclado de verdade e o foco não era gerenciado.
  it('abre o menu pelo teclado, ativa o primeiro item e fecha com Escape', async () => {
    const onNavigate = vi.fn()
    await render(
      <DashboardLayout userEmail="ana@empresa.com" onNavigate={onNavigate}>
        conteúdo
      </DashboardLayout>,
    )

    const triggerEl = userMenu().element() as HTMLElement
    triggerEl.focus()
    await userEvent.keyboard('{Enter}')

    await expect.element(page.getByRole('menuitem', { name: /Perfil/ })).toBeVisible()
    // O Radix move o foco para o primeiro item ao abrir com teclado.
    await expect.element(page.getByRole('menuitem', { name: /Perfil/ })).toHaveFocus()

    await userEvent.keyboard('{Enter}')
    expect(onNavigate).toHaveBeenCalledWith('profile')

    await userMenu().click()
    await expect.element(page.getByRole('menuitem', { name: /Perfil/ })).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('menuitem', { name: /Perfil/ })).not.toBeInTheDocument()
  })
})
