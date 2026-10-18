import { z } from 'zod'

/**
 * Proveniência das bases de referência: qual versão de cada base está carregada.
 * Não expõe linhas nem conteúdo, apenas a marca temporal/versão de cada ingestão.
 */
export const MetaResponse = z.object({
  datasets: z.object({
    ref_receita_estabelecimento: z.object({ snapshot_month: z.string().nullable() }),
    ref_receita_empresa: z.object({ snapshot_month: z.string().nullable() }),
    ref_receita_socio: z.object({ snapshot_month: z.string().nullable() }),
    ref_cnefe_address: z.object({ census_year: z.number().int().nullable() }),
    ref_cep: z.object({ updated_at: z.string().nullable(), sources: z.array(z.string()) }),
    ref_known_shared_address: z.object({
      created_at: z.string().nullable(),
      sources: z.array(z.string()),
    }),
    address_profile: z.object({ computed_from_snapshot: z.string().nullable() }),
  }),
})

export type MetaPayload = z.infer<typeof MetaResponse>
