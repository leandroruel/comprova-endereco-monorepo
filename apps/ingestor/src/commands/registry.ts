import type { IngestorContext } from '../context.js'
import { cacheFlush } from './cache.js'
import { cepsBackfill } from './cep.js'
import { cnefeUf } from './cnefe.js'
import { fixtures } from './fixtures.js'
import { keysRebuild } from './keys.js'
import { policySimulate } from './policy.js'
import { profilesRecompute } from './profiles.js'
import { receitaEstabelecimentos, receitaIbgeDerive, receitaMunicipios } from './receita.js'
import { loadTenant } from './tenant.js'
import type { CommandHandler } from './types.js'

/** Comandos do ingestor por nome. Adicionar um comando é adicionar uma entrada aqui. */
export const commandRegistry: Readonly<Record<string, CommandHandler>> = {
  fixtures,
  'policy:simulate': policySimulate,
  'cache:flush': cacheFlush,
  'load-tenant': loadTenant,
  'receita:estabelecimentos': receitaEstabelecimentos,
  'receita:municipios': receitaMunicipios,
  'receita:ibge-derive': receitaIbgeDerive,
  'profiles:recompute': profilesRecompute,
  'ceps:backfill': cepsBackfill,
  'cnefe:uf': cnefeUf,
  'keys:rebuild': keysRebuild,
}

/** Argumentos esperados por comando, exibidos no help. Sem entrada = sem argumentos. */
const USAGE: Readonly<Record<string, string>> = {
  'receita:estabelecimentos': '<csv> --snapshot YYYY-MM [--limit N]',
  'receita:municipios': '<csv>',
  'cnefe:uf': '<csv> [--limit N]',
  'ceps:backfill': '[--limit N]',
  'policy:simulate': '<versao> [--report]',
}

/** O help é derivado do registro, então a lista nunca fica desatualizada. */
const HELP_LINES = [
  'comandos:',
  ...Object.keys(commandRegistry).map((name) => {
    const usage = USAGE[name]
    return usage === undefined ? `  ${name}` : `  ${name} ${usage}`
  }),
  'gate adiada (Fase 1): ingestao completa do dump real + medicao de tempo',
]

export const printHelp = (context: IngestorContext): void => {
  HELP_LINES.forEach((line) => context.logger.info(line))
}

export const dispatchCommand = async (context: IngestorContext, argv: readonly string[]): Promise<void> => {
  const [command = 'help', ...args] = argv
  // `Object.hasOwn` evita casar com membros herdados (`constructor`, `__proto__`).
  const handler = Object.hasOwn(commandRegistry, command) ? commandRegistry[command] : undefined
  if (handler === undefined) {
    printHelp(context)
    return
  }
  await handler(context, args)
}
