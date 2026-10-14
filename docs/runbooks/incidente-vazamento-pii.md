# Runbook: incidente de vazamento de PII

**Cenário suspeito**: CPF/endereço de PF em log, erro, trace ou repositório.

## Contenção (primeiros 30 min)

1. **Confirmar o vazamento**: rodar o gate local de PII
   (`pnpm vitest run packages/observability`) e inspecionar as linhas suspeitas.
2. **Cortar a saída**: se for log — girar o sink (stdout → arquivo com redator); se for
   resposta de API — rever `include_evidence`/DTO; se for commit — ver "Git" abaixo.
3. **Rotacionar credenciais**: `API_KEY_PEPPER` (invalida HMACs — aceitar re-submissão de
   subjects, que recriam chaves); chaves de webhook dos tenants; pepper deriva
   `doc_hmac_key` e `webhook-secret` (ADR-0005/0011).

## Git

O repositório tem `.env` no `.gitignore` — se um segredo for commitado:

```bash
git revert <sha>                      # remove do histórico novo
# histórico antigo precisa de rewrite (git filter-repo) + force-push coordenado
```

## Notificação (LGPD)

- Avaliar risco aos titulares (art. 48): dados vazados, volume, possibilidade de identificação.
- Documentar no `audit_log` da operadora: descrição, dados envolvidos, mitigação.
- Canais: ANPD (se risco relevante) + tenants afetados.

## Prevenção (já implementada — verificar cobertura)

- Redator central de logs com gate no CI (`f5.int.test.ts` — zero-PII).
- Documentos só como HMAC; RLS entre tenants; audit append-only.
- Endpoint de erasure (`DELETE /v1/subjects/{id}`) para eliminação sob demanda.
- Revisar: nenhum `console.log` direto (eslint não proíbe — considerar regra `no-console`
  exceto server/cli no CI futuro).

## Post-mortem

Registrar em `docs/incidents/` (data, causa, contorno, ações preventivas com dono e prazo).
