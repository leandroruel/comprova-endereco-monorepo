# syntax=docker/dockerfile:1
# Build da API Comprova (Fastify/Node.js) para Fly.io
FROM node:24-alpine AS base

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    WORKER_LOOPS=false \
    COREPACK_ENABLE_STRICT=0

WORKDIR /app

# Instala pnpm via corepack
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate

# Copia todo o monorepo (node_modules excluído via .dockerignore)
COPY . .

# Instala dependências (inclui devDeps para o tsx rodar o TypeScript direto)
RUN pnpm install

# Usuário não-root
RUN addgroup -S appuser && adduser -S appuser -G appuser
USER appuser

EXPOSE 3000

# Health check: /healthz (sempre OK) e /readyz (PostgreSQL + Redis)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/healthz || exit 1

# Roda a API diretamente com tsx (executável, não via node). Variáveis de ambiente via Fly.io secrets.
CMD ["/app/node_modules/.bin/tsx", "/app/apps/api/src/server.ts"]
