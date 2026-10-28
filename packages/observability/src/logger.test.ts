import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createLogger } from './logger.js'

function capture() {
  const lines: string[] = []
  return { lines, stream: { write: (line: string) => void lines.push(line) } }
}

describe('logger', () => {
  it('redige CPF e nomes antes de serializar', () => {
    const { lines, stream } = capture()
    const logger = createLogger({ level: 'info', stream })
    logger.info({ document_value: '529.982.247-25', nome: 'Fulano de Tal' }, 'request')
    const out = lines.join('\n')
    expect(out).not.toContain('529.982.247-25')
    expect(out).not.toContain('Fulano')
    expect(out).toContain('***REDACTED***')
    expect(out).toContain('request')
  })

  it('redige CNPJ dentro de string de mensagem', () => {
    const { lines, stream } = capture()
    const logger = createLogger({ level: 'info', stream })
    logger.info('processando 11.222.333/0001-81')
    const out = lines.join('\n')
    expect(out).not.toContain('11.222.333/0001-81')
    expect(out).toContain('***REDACTED***')
  })

  it('duplica eventos estruturados para o arquivo configurado', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'comprova-logger-'))
    const file = path.join(directory, 'nested', 'app.log')

    try {
      const logger = createLogger({ level: 'info', file })
      logger.info({ reason: 'FISCAL_VERIFICATION_TICK_DONE' }, 'fiscal verification materialized')

      const output = readFileSync(file, 'utf8')
      expect(output).toContain('FISCAL_VERIFICATION_TICK_DONE')
      expect(output).toContain('fiscal verification materialized')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
