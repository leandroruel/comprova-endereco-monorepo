import { createCLILogger } from '@comprova/observability'
import { dispatchCommand } from './commands/registry.js'
import { ingestorConfigFromProcess } from './config.js'
import { makeIngestorContext } from './context.js'

/**
 * Composition root do CLI: valida o ambiente, monta o logger e o contexto e
 * entrega o comando ao registro. Toda a lógica mora em `commands/` (fronteira
 * do CLI) e `modules/` (domínio), no mesmo padrão de `apps/api`.
 */
const config = ingestorConfigFromProcess()
const logger = createCLILogger('ingestor', config.logLevel)
const context = makeIngestorContext(config, logger)

await dispatchCommand(context, process.argv.slice(2))
