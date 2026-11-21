# syntax=docker/dockerfile:1
# Build do Worker Comprova (Node.js loops) para Fly.io
FROM node:24-alpine AS base

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    WORKER_LOOPS=true \
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

# O worker não expõe porta HTTP; health check via ping ao container
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD pgrep -f "tsx.*apps/worker/src/index.ts" > /dev/null 2>&1 || exit 1

# Roda o worker diretamente com tsx (executável). Variáveis de ambiente via Fly.io secrets.
CMD ["/app/node_modules/.bin/tsx", "/app/apps/worker/src/index.ts"]
