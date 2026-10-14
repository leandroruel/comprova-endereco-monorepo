# LICENSE_NOTES — provedores externos

## OSM Nominatim (geocode) e Overpass API (places)

- **Licença dos dados**: ODbL (Open Database License). Requer **atribuição** ("© OpenStreetMap
  contributors") em produtos que redistribuam os dados.
- **O que podemos armazenar**: coordenadas derivadas e metadados de resultado são dados
  factuais/geográficos; guardamos só o ponto + precisão no `address_signal_cache` e em
  `canonical_address`. **Não** copiamos/display_name completo (com licença ODbL, derivações
  públicáveis precisam de atribuição — mantemos a atribuição aqui e na resposta da API quando
  `include_evidence`).
- **Rate limit**: Nominatim público = **1 req/s** por User-Agent; bulk/geocoding em massa é
  proibido. Por isso o checker T1 é disparado só em validações ambíguas (auto/deep) e os
  resultados são cacheados por endereço (`address_signal_cache`, TTL longo). Para produção,
  self-host do Nominatim/Photon com extrato BR (plano da Fase 6).
- **Overpass**: uso leve, timeout curto, cache negativo. Sem chave de API; API pública de
  cortesia — manter volume mínimo.
- **Google Maps (fallback futuro)**: ToS restringe cache de resultados (~30 dias) e armazenamento
  de conteúdo; ao habilitar, cachear apenas coordenadas por ≤30 dias e nunca persistir imagens
  fora dos termos do Street View Static API. Ativado só com chave + orçamento do mantenedor.

## Registro.br / WHOIS (digital_footprint)

- Não implementado nesta fase (sem acesso legítimo programático simples). O checker usa apenas
  dados locais (domínio de e-mail da Receita + DDD vs UF). Quando integrado: WHOIS público tem
  limites de uso; dados de contato **não** podem ser persistidos.

## CloudServer (object storage local) — infra, não provedor de dados

- Apache 2.0; usado apenas como S3-compatible local. Em produção: R2 (Cloudflare) ou S3.
