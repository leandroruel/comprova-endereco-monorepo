# ADR-0008: Canonicalização de endereço BR e chaves determinísticas (building_key/unit_key)

## Status

Aceito (2026-10-10)

## Contexto

O produto precisa comparar endereços vindos de fontes distintas (Receita, CNEFE, CEP, request
de CPF). Sem canonicalização estável, o mesmo imóvel aparece como entidades diferentes. A spec
sugeria libpostal via sidecar; o perfil zero-custo e o requisito de determinismo/testabilidade
pesaram contra subir outro serviço agora.

## Decisão

- **Normalizador puro em TypeScript** (`packages/core/src/address.ts`), zero dependências:
  - `normalizeText`: NFKD-soft (strip de diacritics via combining marks) + caixa alta + colapso
    de espaços. Idempotente (property test com fast-check, 1000 runs).
  - `normalizeLogradouro`: expande abreviações BR no primeiro token (R.→RUA, AV.→AVENIDA,
    TV.→TRAVESSA, JD.→JARDIM, PCA→PRACA, EST→ESTRADA, AL.→ALAMEDA, ROD., FZ., SIT., CH., VL.,
    LGO. etc.).
  - `normalizeNumero`: `S/N`/`SN`/`Sem número`→`S/N`; limpa `Nº`/`#`; extrai e ordena
    canonicamente componentes `KM <n>`, `QD/QUADRA <n>`, `LT/LOTE <n>` (pares preservados —
    `QUADRA 5 LOTE 3` ≡ `LOTE 3, QUADRA 5` → `QD 5 LT 3`), resto em ordem original. Limpeza
    por ponto-fixo recursivo para garantir idempotência.
- **Chaves determinísticas** (`key_version=1` embutida no hash): `sha256` sobre
  `v1|countryCode|uf|municipioIbge(ou nome-norm)|logradouroNorm|numeroNorm` →
  `building_key` (32 bytes). `unit_key` = sha256 sobre building_key + complemento normalizado.
  CEP e bairro ficam **fora** da chave (mesmo imóvel pode ter CEP divergente entre fontes).
- Property tests: idempotência de cada normalizador com entradas arbitrárias; estabilidade da
  chave sob variações de caixa/acentos/espaços/abreviação; complemento muda `unit_key` mas não
  `building_key`; número/município diferentes geram chaves diferentes.
- **Limitações conhecidas** (registradas): normalização é heurística; nomes de logradouro não
  abreviados ou com erros de grafia não convergem (fuzzy/trgm fica para o checker `cnefe_match`
  e para uma futura integração libpostal como porta, sem mudar o contrato das chaves).

## Alternativas rejeitadas

- **libpostal sidecar:** +1 serviço para operar/buildar localmente; a camada de regras BR
  precisaria existir de qualquer forma; adiado como porta futura se o dataset real mostrar
  taxa de não-convergência inaceitável.
- **Chave com CEP:** CEP muda entre fontes para o mesmo imóvel; incluir fragmentaria o
  perfil de co-tenancy.

## Consequências

- Ingestão da Receita calcula `building_key`/`unit_key` na carga (apps/ingestor), o fast path
  recalcula para o endereço do request — mesma entrada → mesma chave, garantindo o cruzamento
  entre bases.
- Mudanças na normalização exigem `key_version` novo + recomputo (documentado no ADR-0004).
