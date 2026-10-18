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
