# Infra como código — **alvo de produção documentado** (não provisionado)

> ADR-0001: perfil zero-custo — nada aqui foi aplicado (`terraform plan/apply` exige conta
> AWS). Os módulos abaixo descrevem a arquitetura-alvo da seção 11 da spec para quando houver
> infra real. Terraform CLI não está instalado localmente; validar com `terraform init && terraform validate`
> quando aplicável.

## Estrutura

```
infra/terraform/
  main.tf              # wiring dos módulos (referência)
  modules/network.tf    # VPC multi-AZ, subnets, endpoints
  modules/eks.tf        # EKS + Karpenter (spot p/ workers T2)
  modules/aurora.tf     # Aurora PostgreSQL 16 multi-AZ + réplica leitura
  modules/redis.tf      # ElastiCache/Valkey
  modules/s3-kms.tf     # S3 evidências (SSE-KMS, lifecycle) + chaves
infra/k8s/              # manifests-alvo (api, worker, hpa)
```

## Promover para produção (checklist futuro)

1. Conta AWS + `terraform init` nos módulos; revisar naming/tags.
2. `pnpm db:migrate` contra o Aurora (job de inicialização).
3. Ingestão do dump real + `address_profile` batch.
4. k6 de um runner separado (não no mesmo host da API) — meta: 3k rps com p95 < 120ms.
5. DR: habilitar cross-region snapshots + teste de restore trimestral (runbook).
6. Ativar chaves externas (OpenAI/Street View) e revisar LIA (docs/lgpd) antes do primeiro tráfego.
