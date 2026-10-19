import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { hasFlag } from '../cli-args.js'
import type { CommandHandler } from './types.js'

export const policySimulate: CommandHandler = async (context, args) => {
  const target = args[0]
  if (target === undefined) throw new Error('usage: ingestor policy:simulate <versao-alvo> [--report]')

  const { simulatePolicy } = await import('../modules/policy-simulate/policy-simulate.service.js')
  const report = await context.withDb(2, (db) => simulatePolicy(db, target))

  context.logger.info(`politica alvo: ${report.targetPolicyVersion}`)
  context.logger.info(`validacoes: ${report.total} | divergentes: ${report.divergent}`)
  report.transitions.forEach((transition) =>
    context.logger.info(`  ${transition.from} -> ${transition.to}: ${transition.count}`),
  )
  report.samples.forEach((sample) =>
    context.logger.info(
      `  amostra ${sample.validationId}: ${sample.storedVerdict} (politica ${sample.storedPolicyVersion}) -> ${sample.simulatedVerdict}`,
    ),
  )

  if (hasFlag(args, '--report')) {
    const dir = 'docs/policy-reports'
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${target}.json`), JSON.stringify(report, null, 2))
    context.logger.info(`relatorio salvo em docs/policy-reports/${target}.json`)
  }
}
