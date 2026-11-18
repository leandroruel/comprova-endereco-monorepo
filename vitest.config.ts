import { fileURLToPath } from 'node:url'
import { playwright } from '@vitest/browser-playwright'
import { configDefaults, defineConfig } from 'vitest/config'

// Timeout para o teste de integração real com o Document Intelligence (Tesseract),
// alinhado ao timeout do cliente DI (360s) mais margem de inicialização.
const TEST_TIMEOUT_MS_REAL_TESSERACT = 400_000

const dashboardSrc = fileURLToPath(new URL('./apps/dashboard/src', import.meta.url))

export default defineConfig({
  resolve: {
    // Alias do app de dashboard (`@/...`), usado apenas pelos testes do
    // dashboard (componentes no projeto `dashboard`, tipos nos de nó).
    alias: {
      '@': dashboardSrc,
      '@comprova/observability': fileURLToPath(
        new URL('./packages/observability/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // `poolOptions.forks.singleFork` (v3) virou `maxWorkers: 1` no pool novo do
    // v4/v5. A isolação por arquivo continua ligada (default), que é o que os
    // testes de integração exigem: um container por arquivo.
    maxWorkers: 1,
    reporters: ['default'],
    // Dois projetos: `node` (banco/API/pacotes) e `dashboard` (DOM real no
    // Chromium via Playwright). O projeto é escolhido por convenção de arquivo:
    // `*.test.tsx` = componente renderizado no browser. `extends: true` (default
    // desde o v5) mantém o alias e os timeouts vindos da raiz.
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          // `apps/api` mantém os testes fora do `src`, em `apps/api/tests`
          // (espelhando a estrutura do `src`).
          include: [
            'apps/**/src/**/*.test.{ts,tsx}',
            'apps/**/tests/**/*.test.{ts,tsx}',
            'packages/**/src/**/*.test.{ts,tsx}',
          ],
          exclude: [
            ...configDefaults.exclude,
            'apps/dashboard/src/**/*.test.tsx',
            // O teste de integração real com o Document Intelligence depende de um
            // serviço externo (Document Intelligence) que não é iniciado na suíte
            // padrão. Ele roda em um projeto dedicado (`tesseract-real`) no CI.
            'apps/api/tests/evidence-analysis-marker-real.int.test.ts',
          ],
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
            // No v4+ o provider é uma factory, vinda do pacote
            // `@vitest/browser-playwright` (o pacote `@vitest/browser` deixou de
            // ser dependência nossa).
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      ...(process.env.TESSERACT_REAL_ENABLED === '1'
        ? [
            {
              extends: true,
              test: {
                name: 'tesseract-real',
                // Integração real com o serviço Document Intelligence (Tesseract).
                // Requer o serviço em execução em http://localhost:8000.
                // Executado apenas no job CI dedicado `tesseract-real`
                // (com TESSERACT_REAL_ENABLED=1), não no `pnpm test` padrão.
                include: ['apps/api/tests/evidence-analysis-marker-real.int.test.ts'],
                testTimeout: TEST_TIMEOUT_MS_REAL_TESSERACT,
                hookTimeout: TEST_TIMEOUT_MS_REAL_TESSERACT,
                maxWorkers: 1,
              },
            },
          ]
        : []),
    ],
  },
})
