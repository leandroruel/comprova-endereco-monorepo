/**
 * Valor que segue `flag` em `args`, ou `undefined` quando a flag não aparece.
 * Uma flag presente sem operando é erro — nunca tratada como ausente.
 */
export const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${flag} exige um valor`)
  return value
}

/**
 * `flag` numérica; `undefined` quando ausente. Uma flag presente sem operando,
 * com valor não numérico, não positivo ou que seja outra flag (`--limit --report`)
 * é rejeitada — o serviço nunca recebe `NaN`/negativo.
 */
export const flagNumber = (args: readonly string[], flag: string): number | undefined => {
  const raw = flagValue(args, flag)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} inválido: "${raw}" (esperado número positivo)`)
  }
  return value
}

export const hasFlag = (args: readonly string[], flag: string): boolean => args.includes(flag)

const SNAPSHOT_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * Valida `--snapshot YYYY-MM` e devolve o valor da coluna `snapshot_month`
 * (`YYYY-MM-01`). Não há default: `snapshot_month` é a proveniência do lote
 * ingerido e um valor inventado mente sobre a origem dos dados.
 */
export const parseSnapshotMonth = (value: string | undefined): string => {
  const trimmed = value?.trim() ?? ''
  if (trimmed.length === 0) {
    throw new Error('--snapshot YYYY-MM é obrigatório (proveniência do lote; não há default)')
  }
  if (!SNAPSHOT_MONTH_PATTERN.test(trimmed)) {
    throw new Error(`--snapshot inválido: "${value}" (esperado YYYY-MM, ex.: 2026-09)`)
  }
  return `${trimmed}-01`
}
