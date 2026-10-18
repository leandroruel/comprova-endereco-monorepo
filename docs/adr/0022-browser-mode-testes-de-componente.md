# ADR-0022: Testes de componente do dashboard no Chromium real (Vitest Browser Mode)

## Status

Aceito (2026-10-18)

## Contexto

Os testes de componente do dashboard rodavam em **jsdom** com três pacotes de
`@testing-library` e polyfills caseiros (`src/test/polyfills.ts`: `matchMedia`,
`ResizeObserver`, pointer capture, `scrollIntoView`, `elementFromPoint`). O jsdom
não faz layout nem gerencia foco: `display:none`/`aria-hidden` não mudam o
resultado das queries, eventos de ponteiro e teclado são simulados em JS, e o
nome acessível é calculado por um polyfill. Ou seja, era preciso stubbear APIs da
plataforma para o Radix funcionar — testando contra um DOM que nenhum usuário vê.

O Vitest oferece **Browser Mode** com provider Playwright, e a documentação
recomenda para React: `vitest-browser-react` para renderizar, locators
(`page`/`screen`) para buscar, `expect.element(...)` para asserção com retry e
`userEvent` de `vitest/browser` — que dispara eventos reais via CDP em vez de
simulá-los em JS. O runner subiu para o **Vitest 5** nesta mesma frente (ver
Decisão): usar o Browser Mode já significava mexer no runner, então o upgrade
veio junto em vez de virar uma segunda frente sobre os mesmos arquivos.

## Decisão

- Os testes de componente (`apps/dashboard/src/**/*.test.tsx`) rodam em
  **Chromium headless** num projeto Vitest `dashboard`; tudo o mais (API, worker,
  ingestor, pacotes e os testes puros do dashboard `*.test.ts`) segue no projeto
  `node`. A convenção é a extensão do arquivo: **`.test.tsx` = browser,
  `.test.ts` = nó**.
- Renderização com `vitest-browser-react`; busca e asserção com locators e
  `expect.element(...)`; interação com o `userEvent` do contexto do browser.
- Dependências: `playwright` e `@vitest/browser-playwright` na raiz (no v4+ o
  provider é uma factory, importada do pacote do provider; o pacote
  `@vitest/browser` deixou de ser dependência nossa) e `vitest-browser-react` no
  dashboard. **Saíram** `jsdom`, `@testing-library/{react,dom,user-event}` e o
  `src/test/polyfills.ts`.
- Runner no **`vitest@5.0.5`** com `vitest-browser-react@2.x`: a linha 2.x do
  wrapper exige `vitest@^4`, e o vitest 3 mantinha CVEs conhecidas (`@vitest/mocker`
  e `tinypool`) suprimidas à mão no `.trivyignore.yaml`. No v5 elas não existem
  mais na árvore — o ignorefile ficou **vazio de propósito** — e em troca o
  `engines.node` do repo subiu para `>=22.12`. O `vite` virou dependência
  explícita da raiz, como a doc do v5 pede (peer, não dependência do runner).
- No `vitest-browser-react@2.x` o `render` é assíncrono (`await render(...)`,
  igual ao `rerender`); os testes foram ajustados.
- `poolOptions.forks.singleFork` (v3) virou `maxWorkers: 1` no pool reescrito do
  v4, preservando a isolação por arquivo de que os testes de integração precisam
  (um container por arquivo).
- Os navegadores **não** são baixados no `pnpm install` (é um download, não um
  build script — o `allowBuilds` do `pnpm-workspace.yaml` só libera `esbuild`):
  `npx playwright install chromium` é pré-requisito local e
  passo do workflow de CI (`npx playwright install --with-deps chromium`). Sem o
  binário o teste falha com mensagem explícita, e não com erro obscuro.
- Timeout do projeto `dashboard` limitado a 30s: as asserções de locator tentam de
  novo até o timeout do teste, e 2 min por seletor quebrado é desperdício de CI.

## Alternativas rejeitadas

- **Manter jsdom + testing-library:** mais simples, mas é testar um DOM que não é
  o do usuário; os polyfills crescem a cada biblioteca nova e nada exercita foco,
  inércia de modal (`aria-hidden`) ou o nome acessível do browser.
- **Playwright puro (E2E da aplicação):** exige subir API + Postgres e autenticar
  por teste — caro e frágil para o que aqui é componente isolado; o app já tem
  cobertura de integração no projeto `node`. O Browser Mode roda o mesmo arquivo
  de teste do Vitest, sem servidor.
- **`@playwright/test` só para o dashboard:** segundo runner, segunda
  configuração, segundo relatório.
- **Ficar no `vitest@3` com `vitest-browser-react@1.x`:** era o estado inicial,
  mas mantinha as CVEs suprimidas à mão e um wrapper uma linha atrás. Adiar o
  upgrade significaria mexer duas vezes nos mesmos arquivos.
- **Ir direto para o `vitest@5` sem declarar `vite` na raiz:** deixaria a versão
  do bundler dos testes sendo resolvida implicitamente como peer do vitest.
- **`@testing-library/react` para render + `userEvent` do contexto:** a doc do
  Vitest desaconselha o `user-event` do testing-library no Browser Mode (simula
  em vez de disparar); manter o RTL apenas para renderizar não compensa o wrapper
  oficial.

## Consequências

- Eventos, foco, `aria-hidden` e nome acessível são os reais. Exemplo concreto que
  o browser revelou: ao abrir o dropdown, o Radix marca o resto da página como
  `aria-hidden`, então o locator do gatilho deixa de resolver o papel `button` —
  o teste passou a capturar a referência do elemento antes do clique.
- **Sem folha de estilo:** os testes não carregam o Tailwind, então asserções de
  visibilidade valem para elementos com caixa própria (texto, botões) e não para
  o que é só cor/espaçamento. Se um dia for necessário, o caminho é importar o CSS
  no setup do projeto `dashboard`.
- Screenshots de falha ficam em `.vitest/attachments/failure-screenshots/`
  (gitignored junto com o resto do `.vitest/`), como artefato de diagnóstico.
- Menos dependências no total: saíram o jsdom e os três pacotes de testing-library.
- O upgrade do runner zerou o `.trivyignore.yaml`: as CVEs de `@vitest/mocker` e
  `tinypool` não existem mais na árvore (confirmado com `trivy fs
--include-dev-deps`), então o gate `security` volta a acusar sozinho qualquer
  coisa nova que apareça.
- CI ganha o passo de instalação do Chromium; o projeto de browser hoje são 2
  arquivos / 15 testes e roda em poucos segundos.

## Limitações registradas

- Só renderização e interação de componente: como não há servidor do app nos
  testes, nada de rota, `fetch` real ou TanStack Query.
- O pacote `dashboard` não tem script `typecheck`, então o `turbo typecheck` não
  alcança seus fontes (lacuna pré-existente); os tipos dos testes de browser
  foram verificados com `pnpm --filter dashboard exec tsc -b`. Vale corrigir numa
  próxima frente.
