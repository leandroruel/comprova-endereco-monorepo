# syntax=docker/dockerfile:1
# Build e serve do Verifier Dashboard (React/Vite) para Fly.io
FROM node:24-alpine AS builder

ENV NODE_ENV=production \
    COREPACK_ENABLE_STRICT=0

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.14.0 --activate

# Copia arquivos de workspace para cache de dependências
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/verifier-dashboard/package.json ./apps/verifier-dashboard/package.json
COPY packages/*/package.json ./packages/*/

RUN pnpm install

# Copia código fonte
COPY apps/verifier-dashboard/ ./apps/verifier-dashboard/
COPY packages/ ./packages/

# Build do dashboard (Vite)
RUN pnpm --filter verifier-dashboard build

# Servidor estático leve (serve)
FROM node:24-alpine AS runner

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    COREPACK_ENABLE_STRICT=0

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.14.0 --activate \
    && pnpm add -g serve

# Copia os arquivos buildados
COPY --from=builder /app/apps/verifier-dashboard/dist ./dist

EXPOSE 3000

# Sirve os arquivos estáticos
CMD ["serve", "-s", "dist", "-l", "3000"]
