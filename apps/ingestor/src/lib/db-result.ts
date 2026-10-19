/**
 * O driver `postgres-js` devolve ora um array de linhas, ora um resultado com
 * `rowCount`, dependendo do comando. Este helper normaliza os dois casos para
 * o número de linhas afetadas — antes duplicado em `cep-backfill` e
 * `address-profile`.
 */
export const rowCountOf = (result: unknown): number =>
  Array.isArray(result) ? result.length : Number((result as { rowCount?: number } | null)?.rowCount ?? 0)
