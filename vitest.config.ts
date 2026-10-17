import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Alias do app de dashboard (`@/...`), usado apenas pelos testes de
    // componente. Não colide com pacotes com escopo (`@comprova/...`).
    alias: {
      '@': fileURLToPath(new URL('./apps/dashboard/src', import.meta.url)),
    },
  },
  test: {
    include: ['apps/**/src/**/*.test.{ts,tsx}', 'packages/**/src/**/*.test.{ts,tsx}'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['default'],
  },
})
