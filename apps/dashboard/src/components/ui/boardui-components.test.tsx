import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Button as BUIButton } from '@/components/base/buttons/button'
import { Badge as BUIBadge } from '@/components/base/badges/badge'
import { Input as BUIInput } from '@/components/base/input/input'

describe('Board UI components', () => {
  it('renderiza o Button com label', async () => {
    await render(
      <BUIButton variant="primary" size="medium">
        Salvar
      </BUIButton>,
    )

    await expect.element(page.getByRole('button', { name: 'Salvar' })).toBeVisible()
  })

  it('renderiza o Badge com cor e texto', async () => {
    await render(
      <BUIBadge color="neutral" className="bg-emerald-100 text-emerald-800">
        Ativo
      </BUIBadge>,
    )

    await expect.element(page.getByText('Ativo')).toBeVisible()
  })

  it('renderiza o Input com label e placeholder', async () => {
    await render(<BUIInput label="Nome da organização" placeholder="Digite o nome" defaultValue="Acme" />)

    await expect.element(page.getByLabelText('Nome da organização')).toBeVisible()
  })
})
