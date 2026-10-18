import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const dashboardSrc = fileURLToPath(new URL('./apps/dashboard/src', import.meta.url))

export default defineConfig({
  resolve: {
    // Alias do app de dashboard (`@/...`), usado apenas pelos testes do
    // dashboard (componentes no projeto `dashboard`, tipos nos de nó).
    alias: {
      '@': dashboardSrc,
    },
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['default'],
    // Dois projetos: `node` (banco/API/pacotes) e `dashboard` (DOM real no
    // Chromium via Playwright). O projeto é escolhido por convenção de arquivo:
    // `*.test.tsx` = componente renderizado no browser.
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['apps/**/src/**/*.test.{ts,tsx}', 'packages/**/src/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, 'apps/dashboard/src/**/*.test.tsx'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dashboard',
          include: ['apps/dashboard/src/**/*.test.tsx'],
          // As asserções de locator (`expect.element`) tentam de novo até o
          // timeout do teste: um seletor quebrado aqui precisa falhar rápido,
          // sem herdar os 2 min que os testes de banco/API exigem.
          testTimeout: 30_000,
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
