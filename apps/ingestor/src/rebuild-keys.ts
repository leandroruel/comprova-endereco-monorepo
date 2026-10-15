import { addressKeys, canonicalizeAddress } from '@comprova/core'
import postgres from 'postgres'

const rawClient = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2 })
const BATCH = 20_000
let total = 0
let lastBasico = ''
const started = Date.now()

for (;;) {
  const rows = (await rawClient`
    SELECT cnpj_basico, cnpj_ordem, cnpj_dv, tipo_logradouro, logradouro,
           numero, complemento, bairro, cep, uf, pais_codigo
    FROM ref_receita_estabelecimento
    ${lastBasico !== '' ? rawClient`WHERE cnpj_basico > ${lastBasico}` : rawClient``}
    ORDER BY cnpj_basico
    LIMIT ${BATCH}
  `) as ReadonlyArray<{
    cnpj_basico: string
    cnpj_ordem: string
    cnpj_dv: string
    tipo_logradouro: string | null
    logradouro: string | null
    numero: string | null
    complemento: string | null
    bairro: string | null
    cep: string | null
    uf: string | null
    pais_codigo: number | null
  }>

  if (rows.length === 0) break

  const basico: string[] = []
  const ordem: string[] = []
  const dv: string[] = []
  const bkeys: string[] = []
  const ukeys: string[] = []

  for (const row of rows) {
    if (row.cep !== null && row.uf !== null && row.logradouro !== null && row.pais_codigo === null) {
      const keys = addressKeys(
        canonicalizeAddress({
          tipoLogradouro: row.tipo_logradouro,
          logradouro: row.logradouro,
          numero: row.numero,
          complemento: row.complemento,
          bairro: row.bairro,
          cep: row.cep,
          uf: row.uf,
          countryCode: 'BR',
        }),
      )
      bkeys.push(`\\x${keys.buildingKey.toString('hex')}`)
      ukeys.push(`\\x${keys.unitKey.toString('hex')}`)
    } else {
      bkeys.push('')
      ukeys.push('')
    }
    basico.push(row.cnpj_basico)
    ordem.push(row.cnpj_ordem)
    dv.push(row.cnpj_dv)
  }

  const validIdx = basico.map((_, i) => i).filter((i) => bkeys[i] !== '')
  if (validIdx.length > 0) {
    await rawClient`
      UPDATE ref_receita_estabelecimento e
      SET building_key = t.bkey, unit_key = t.ukey
      FROM unnest(
        ${rawClient.array(validIdx.map((i) => basico[i]!))}::text[],
        ${rawClient.array(validIdx.map((i) => ordem[i]!))}::text[],
        ${rawClient.array(validIdx.map((i) => dv[i]!))}::text[],
        ${rawClient.array(validIdx.map((i) => bkeys[i]!))}::bytea[],
        ${rawClient.array(validIdx.map((i) => ukeys[i]!))}::bytea[]
      ) AS t(basico, ordem, dv, bkey, ukey)
      WHERE e.cnpj_basico = t.basico AND e.cnpj_ordem = t.ordem AND e.cnpj_dv = t.dv
    `
  }

  total += rows.length
  lastBasico = rows[rows.length - 1]?.cnpj_basico ?? ''
  const elapsed = Date.now() - started
  const rate = elapsed > 0 ? Math.round((total / elapsed) * 1000) : 0
  console.log(`${total}/${30585232} (${rate}/s, ${Math.round((total / 30585232) * 100)}%)`)
}

console.log(`done: ${total} keys in ${Math.round((Date.now() - started) / 1000)}s`)
await rawClient.end()
process.exit(0)
