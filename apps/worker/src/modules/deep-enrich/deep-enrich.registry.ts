import type { EstabelecimentoRecord } from '@comprova/core'

const hexToBuffer = (hex: unknown): Buffer | null =>
  typeof hex === 'string' ? Buffer.from(hex, 'hex') : null

/**
 * Reconstrói o `EstabelecimentoRecord` a partir do `deep_context` (jsonb) gravado
 * pelo fast path. Mapeamento puro — sem acesso a banco.
 */
export const registryRecordFromDeepContext = (
  deepContext: Record<string, unknown> | null,
): { readonly record: EstabelecimentoRecord; readonly docDigitsValid: boolean } | null => {
  if (deepContext === null) return null
  const raw = deepContext['record']
  const docDigitsValid = deepContext['docDigitsValid'] === true
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return {
    docDigitsValid,
    record: {
      cnpjBasico: String(r['cnpjBasico'] ?? ''),
      cnpjOrdem: String(r['cnpjOrdem'] ?? ''),
      cnpjDv: String(r['cnpjDv'] ?? ''),
      matrizFilial: Number(r['matrizFilial'] ?? 1),
      nomeFantasia: (r['nomeFantasia'] as string | null) ?? null,
      situacaoCadastral: Number(r['situacaoCadastral'] ?? 0),
      dataSituacao: (r['dataSituacao'] as string | null) ?? null,
      motivoSituacao: (r['motivoSituacao'] as number | null) ?? null,
      dataAbertura: (r['dataAbertura'] as string | null) ?? null,
      cnaePrincipal: (r['cnaePrincipal'] as string | null) ?? null,
      cnaesSecundarios: (r['cnaesSecundarios'] as readonly string[] | null) ?? null,
      tipoLogradouro: (r['tipoLogradouro'] as string | null) ?? null,
      logradouro: (r['logradouro'] as string | null) ?? null,
      numero: (r['numero'] as string | null) ?? null,
      complemento: (r['complemento'] as string | null) ?? null,
      bairro: (r['bairro'] as string | null) ?? null,
      cep: (r['cep'] as string | null) ?? null,
      uf: (r['uf'] as string | null) ?? null,
      municipioReceita: (r['municipioReceita'] as number | null) ?? null,
      municipioIbge: (r['municipioIbge'] as number | null) ?? null,
      paisCodigo: (r['paisCodigo'] as number | null) ?? null,
      cidadeExterior: (r['cidadeExterior'] as string | null) ?? null,
      buildingKey: hexToBuffer(r['buildingKey']),
      unitKey: hexToBuffer(r['unitKey']),
      telefone: (r['telefone'] as string | null) ?? null,
      emailDomain: (r['emailDomain'] as string | null) ?? null,
    },
  }
}
