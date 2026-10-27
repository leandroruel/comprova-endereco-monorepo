import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type {
  ValidationProgressDto,
  ValidationProgressStage,
  ValidationProgressStepStatus,
} from '@/api/client'
import { ValidationProgress } from './validation-progress'

const STAGES: readonly ValidationProgressStage[] = [
  'reading_document',
  'reading_qr',
  'consulting_provider',
  'verifying_authenticity',
  'comparing_evidence',
]

const progress = (
  status: ValidationProgressDto['status'],
  statuses: Partial<Record<ValidationProgressStage, ValidationProgressStepStatus>> = {},
): ValidationProgressDto => ({
  status,
  steps: STAGES.map((stage) => ({ stage, status: statuses[stage] ?? 'pending' })),
})

const progressAt = (index: number): ValidationProgressDto => ({
  status: 'in_progress',
  steps: STAGES.map((stage, position) => ({
    stage,
    status: position < index ? 'completed' : position === index ? 'in_progress' : 'pending',
  })),
})

describe('ValidationProgress', () => {
  it('mostra o estado inicial com a primeira etapa em andamento', async () => {
    render(<ValidationProgress progress={progressAt(0)} />)

    await expect.element(page.getByText('Validação em andamento')).toBeVisible()
    await expect
      .element(page.getByTestId('progress-step-reading_document'))
      .toHaveAttribute('data-status', 'in_progress')
    await expect
      .element(page.getByTestId('progress-step-reading_qr'))
      .toHaveAttribute('data-status', 'pending')
    await expect.element(page.getByText('Lendo documento')).toBeVisible()
    await expect.element(page.getByText('em andamento')).toBeVisible()
  })

  it.each(STAGES.map((stage, index) => [stage, index] as const))(
    'renderiza a etapa %s em andamento',
    async (stage, index) => {
      render(<ValidationProgress progress={progressAt(index)} />)

      await expect
        .element(page.getByTestId(`progress-step-${stage}`))
        .toHaveAttribute('data-status', 'in_progress')
      await expect.element(page.getByText('Validação em andamento')).toBeVisible()
    },
  )

  it('mostra todas as etapas concluídas', async () => {
    render(
      <ValidationProgress
        progress={progress('completed', {
          reading_document: 'completed',
          reading_qr: 'completed',
          consulting_provider: 'completed',
          verifying_authenticity: 'completed',
          comparing_evidence: 'completed',
        })}
      />,
    )

    await expect.element(page.getByText('Validação concluída')).toBeVisible()
    for (const stage of STAGES) {
      await expect
        .element(page.getByTestId(`progress-step-${stage}`))
        .toHaveAttribute('data-status', 'completed')
    }
    await expect.element(page.getByText('concluído').first()).toBeVisible()
  })

  it('mostra a etapa que falhou e esconde as etapas seguintes', async () => {
    render(
      <ValidationProgress
        progress={progress('failed', {
          reading_document: 'completed',
          reading_qr: 'completed',
          consulting_provider: 'failed',
          verifying_authenticity: 'skipped',
          comparing_evidence: 'skipped',
        })}
      />,
    )

    await expect.element(page.getByText('Uma etapa não pôde ser concluída')).toBeVisible()
    await expect
      .element(page.getByTestId('progress-step-consulting_provider'))
      .toHaveAttribute('data-status', 'failed')
    await expect.element(page.getByText('Não foi possível consultar o provedor fiscal.')).toBeVisible()
    await expect.element(page.getByText('Comprovando autenticidade')).not.toBeInTheDocument()
    await expect.element(page.getByText('Comparando evidências')).not.toBeInTheDocument()
  })

  it('sem QR conclui as etapas aplicáveis e explica a ausência da referência', async () => {
    render(
      <ValidationProgress
        progress={progress('completed', {
          reading_document: 'completed',
          reading_qr: 'completed',
          consulting_provider: 'skipped',
          verifying_authenticity: 'skipped',
          comparing_evidence: 'skipped',
        })}
      />,
    )

    await expect.element(page.getByText('Validação concluída')).toBeVisible()
    await expect.element(page.getByText('Referência fiscal não encontrada no comprovante.')).toBeVisible()
    await expect.element(page.getByText('Consultando provedor fiscal')).not.toBeInTheDocument()
  })

  it('documento inválido falha em Lendo documento', async () => {
    render(
      <ValidationProgress
        progress={progress('failed', {
          reading_document: 'failed',
          reading_qr: 'skipped',
          consulting_provider: 'skipped',
          verifying_authenticity: 'skipped',
          comparing_evidence: 'skipped',
        })}
      />,
    )

    await expect
      .element(page.getByTestId('progress-step-reading_document'))
      .toHaveAttribute('data-status', 'failed')
    await expect.element(page.getByText('Documento não pôde ser analisado.')).toBeVisible()
    await expect.element(page.getByText('Lendo QR Code')).not.toBeInTheDocument()
  })
})
