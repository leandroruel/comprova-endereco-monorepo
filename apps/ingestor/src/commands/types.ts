import type { IngestorContext } from '../context.js'

/** Um comando do CLI: recebe o contexto de composição e os argumentos após o nome. */
export type CommandHandler = (context: IngestorContext, args: readonly string[]) => Promise<void>
