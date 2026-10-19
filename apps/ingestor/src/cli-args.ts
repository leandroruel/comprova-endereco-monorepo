/** Valor que segue `flag` em `args`, ou `undefined` quando a flag não aparece. */
export const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/** `flag` numérica; `undefined` quando ausente. Não valida o conteúdo (preserva o `Number` cru). */
export const flagNumber = (args: readonly string[], flag: string): number | undefined => {
  const raw = flagValue(args, flag)
  return raw === undefined ? undefined : Number(raw)
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
