/**
 * Adaptadores de leitura do Postgres para as portas de `@comprova/core`.
 *
 * Um arquivo por domínio de leitura; o barrel é o único ponto que o resto do
 * pacote importa. Nenhum adaptador guarda estado: todos recebem `Db` e
 * devolvem funções puras de leitura.
 */
export * from './cep.js'
export * from './cnae.js'
export * from './cnefe.js'
export * from './known-shared.js'
export * from './partner-graph.js'
export * from './profile.js'
export * from './registry.js'
export * from './signal-cache.js'
