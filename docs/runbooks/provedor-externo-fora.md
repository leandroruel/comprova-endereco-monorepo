# Runbook: provedor externo fora do ar

**Sintomas**: sinais `geocode_consensus`/`places_match` com `reason: provider_unavailable`;
confiança caindo; vereditos deep ficando `partial` mesmo com T1.

**Impacto esperado**: nenhum veredito falso — checkers degradam para `unknown` por design
(ausência de evidência não é evidência de ausência). Fast path não usa provedores externos.

## Diagnóstico

```bash
curl -s "https://nominatim.openstreetmap.org/search?q=Av%20Paulista&format=jsonv2&limit=1" \
  -H 'User-Agent: comprova-endereco-dev/0.1' | head -c 200
docker compose logs temporal --tail 20
```

- Worker log: grep `provider_unavailable` / `vlm_unavailable`.
- Métricas: taxa de `unknown` por checker (`/metrics`).

## Ações

1. **Nominatim público fora**: verificar
   [status.openstreetmap.org](https://status.openstreetmap.org). Se for rate limit (429),
   reduzir volume (deep path só roda em ambíguos — conferir) e checar o User-Agent.
2. **Persistente**: apontar `NOMINATIM_URL` para self-host (compose futuro) ou desligar o
   checker `geocode_consensus` via política (peso 0 não é suportado ainda — remover do
   `makeT1Checkers` e reimplantar o worker).
3. **Overpass fora**: fallback natural é `places_match` → `unknown`; sem ação emergencial.
4. **VLM (OpenAI)** fora: `street_view_vlm` → `unknown vlm_unavailable`; validações ambíguas
   completam como `INSUFFICIENT_EVIDENCE` — comportamento correto.

## Comunicação

- Se >20% dos deep paths terminando `partial` por `provider_unavailable` por >15 min,
  avisar tenants via canal de status.
