// @vitest-environment jsdom
import '@/test/polyfills'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardLayout } from './layout'

afterEach(cleanup)

const userMenu = (): HTMLElement => screen.getByRole('button', { name: 'Menu do usuário' })

describe('DashboardLayout', () => {
  it('renderiza o conteúdo e a navegação lateral', () => {
    render(<DashboardLayout>conteúdo da página</DashboardLayout>)

    expect(screen.getByText('conteúdo da página')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Validações' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Busca em lote' })).toBeTruthy()
  })

  it('troca de aba e avisa a navegação ao clicar no menu lateral', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(<DashboardLayout onNavigate={onNavigate}>conteúdo</DashboardLayout>)

    await user.click(screen.getByRole('button', { name: 'Busca em lote' }))

    expect(onNavigate).toHaveBeenCalledWith('bulk')
  })

  it('identifica o usuário no gatilho do menu e alterna o estado acessível', async () => {
    const user = userEvent.setup()
    render(<DashboardLayout userEmail="ana.souza@empresa.com">conteúdo</DashboardLayout>)

    const trigger = userMenu()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(within(trigger).getByText('ana.souza')).toBeTruthy()
    expect(within(trigger).getByText('ana.souza@empresa.com')).toBeTruthy()
    expect(within(trigger).getByText('A')).toBeTruthy()

    await user.click(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('cai em "Conta" quando não há e-mail', () => {
    render(<DashboardLayout>conteúdo</DashboardLayout>)

    const trigger = userMenu()
    expect(within(trigger).getByText('Conta')).toBeTruthy()
    expect(within(trigger).getByText('C')).toBeTruthy()
  })

  it('abre o menu com Perfil e Configurações e encaminha a navegação', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(
      <DashboardLayout userEmail="ana@empresa.com" onNavigate={onNavigate}>
        conteúdo
      </DashboardLayout>,
    )

    await user.click(userMenu())
    await user.click(await screen.findByRole('menuitem', { name: /Perfil/ }))

    expect(onNavigate).toHaveBeenCalledWith('profile')

    await user.click(userMenu())
    await user.click(await screen.findByRole('menuitem', { name: /Configurações/ }))

    expect(onNavigate).toHaveBeenCalledWith('settings')
  })

  it('mostra a ação destrutiva de sair apenas quando há onLogout', async () => {
    const onLogout = vi.fn()
    const user = userEvent.setup()
    render(
      <DashboardLayout userEmail="ana@empresa.com" onLogout={onLogout}>
        conteúdo
      </DashboardLayout>,
    )

    await user.click(userMenu())
    // Perfil existe sempre; "Sair" só com logout conectado.
    expect(await screen.findByRole('menuitem', { name: /Perfil/ })).toBeTruthy()
    await user.click(screen.getByRole('menuitem', { name: /Sair/ }))

    expect(onLogout).toHaveBeenCalledTimes(1)
  })

  it('omite "Sair" quando o logout não está conectado', async () => {
    const user = userEvent.setup()
    render(<DashboardLayout userEmail="ana@empresa.com">conteúdo</DashboardLayout>)

    await user.click(userMenu())

    expect(await screen.findByRole('menuitem', { name: /Perfil/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /Sair/ })).toBeNull()
  })
})
