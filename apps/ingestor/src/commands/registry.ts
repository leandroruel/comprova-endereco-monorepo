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

const HELP_LINES = [
  'comandos: fixtures | receita:estabelecimentos <csv> --snapshot YYYY-MM [--limit N] | policy:simulate <versao> [--report]',
  'gate adiada (Fase 1): ingestao completa do dump real + medicao de tempo',
]

export const printHelp = (context: IngestorContext): void => {
  HELP_LINES.forEach((line) => context.logger.info(line))
}

export const dispatchCommand = async (context: IngestorContext, argv: readonly string[]): Promise<void> => {
  const [command = 'help', ...args] = argv
  const handler = commandRegistry[command]
  if (handler === undefined) {
    printHelp(context)
    return
  }
  await handler(context, args)
}
