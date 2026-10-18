# ADR-0023: Upgrade para o pnpm 12 (config de build em `pnpm-workspace.yaml` e quarentena de releases)

## Status

Aceito (2026-10-18)

## Contexto

O repo estava no `pnpm@10.7.0`, com os únicos builds aprovados declarados em
`package.json#pnpm.onlyBuiltDependencies: [esbuild]`. O pnpm 11 removeu a
configuração do campo `pnpm` do `package.json` (só sobraram no `.npmrc` as
chaves de auth/registry) e consolidou `onlyBuiltDependencies`,
`neverBuiltDependencies`, `ignoredBuiltDependencies` e
`onlyBuiltDependenciesFile` num único **`allowBuilds`** (`{ nome: true|false }`)
no `pnpm-workspace.yaml`.

Duas mudanças de comportamento vêm de carona e mexem com o nosso dia a dia:

- **`strictDepBuilds` é `true` por padrão:** o install falha
  (`ERR_PNPM_IGNORED_BUILDS`) se algum pacote da árvore tiver build script sem
  decisão registrada. Antes, o pnpm 10 só avisava e ignorava.
- **`minimumReleaseAge` é `1440` min (24h) por padrão:** versões publicadas nas
  últimas 24 horas não entram em resolução nova, e o `pnpm install` reaplica a
  política a **cada entrada do lockfile** (`trustLockfile`, passo
  "Verifying lockfile against supply-chain policies"). Quarentena de release
  recém-publicada é exatamente a janela de um pacote comprometido.

Um lockfile escrito pelo pnpm 10 não passa nessa verificação, e o `jsdom` dava
o caso concreto: ele continuava resolvido como **peer opcional do `vitest`**
(mesmo tendo saído das dependências do dashboard no ADR-0022), arrastando ~40
pacotes — dois deles (`@asamuzakjp/css-color@7.1.7`,
`@asamuzakjp/dom-selector@10.0.4`) publicados horas antes, o que barrava o
install.

## Decisão

- Migrar com o codemod oficial (`pnpx codemod run pnpm-v10-to-v11`, do próprio
  autor do pnpm) e então pinar **`packageManager: pnpm@12.14.0`** — o codemod
  leva a config para a forma que o v11 introduziu e o v12 mantém; a versão
  final é escolha nossa.
- **`allowBuilds` no `pnpm-workspace.yaml`**, com a decisão explícita para cada
  build da árvore:
  - `esbuild: true` — já era a única liberada, e `vite`/`vitest`/`tsx` dependem
    do binário.
  - `@swc/core: false` (via `@temporalio/worker`), `protobufjs: false` (via
    `@temporalio/client`), `ssh2: false` e `cpu-features: false` (via
    `testcontainers`): o pnpm 10 já **não** rodava nenhum desses scripts, então
    negar preserva o estado testado e registra a revisão — em vez de aprovar
    builds nativos de terceiros só para calar o erro.
- **Remover a aresta de peer `vitest>jsdom`** (`overrides`), já que nada consome
  jsdom: tira a árvore morta do lockfile (33 entradas menos na verificação:
  847 → 814) e com ela as duas entradas que violavam a quarentena. Se um dia
  voltar a existir teste com `environment: 'jsdom'`, é essa linha que precisa
  sair — está comentada lá.
- **Manter `minimumReleaseAge` no default**, sem lista de exclusão: depois da
  limpeza acima o lockfile passa a verificação (814 entradas) sem exceção
  alguma. O `trustLockfile: true` foi usado **só como flag de linha de comando**
  para reescrever o lockfile uma vez; ele não está no config.
- CI: `pnpm/action-setup@v4` → **`@v6`**, a linha que instala o pnpm 12 (o v4
  não sabe provisioná-lo). A versão continua vindo do `packageManager`, não do
  workflow.
- **`permissions`**: o v12 passou a pedir aprovação para o que uma dependência
  quer fazer além de rodar build — a `@tanstack/react-table` pede para instalar
  "agent skills" (arquivos que seriam copiados para o repo). Negado com
  `pnpm approve '!@tanstack/react-table'`, que gravou
  `permissions: { '@tanstack/react-table': { skills: false } }`: dependência não
  escreve arquivo nosso, e o escopo da negação é só o que ela pediu.

## Alternativas rejeitadas

- **`minimumReleaseAgeExclude` para os dois pacotes do jsdom:** resolveria a
  violação sem tocar na árvore, mas deixaria uma exceção permanente de
  "confiamos nestes dois" para pacotes que não usamos — e o `jsdom` continuaria
  resolvido. Negar a quarentena em geral (`minimumReleaseAge: 0`) jogaria fora
  a proteção que motivou o upgrade.
- **`pnpm clean --lockfile && pnpm install`** (o que o próprio erro sugere):
  re-resolve a árvore inteira e perde o pin das versões atuais; o diff de
  lockfile fica impossível de revisar por causa de um problema que era de
  escopo pequeno.
- **`pnpm approve-builds` para liberar `@swc/core`/`ssh2`/`cpu-features`:** roda
  scripts nativos de terceiros que hoje não rodam, sem necessidade demonstrada.
- **Ficar no pnpm 10:** manteria a config no lugar que o pnpm 11/12 ignora
  silenciosamente, sem a quarentena de releases e sem o build aprovado por
  nome.
- **Trocar para `pnpm/setup@v1`:** é o caminho da doc para v11+, mas troca de
  action e de passo; subir o major da mesma action entrega o mesmo resultado com
  menos superfície.

## Consequências

- **O `pnpm` local precisa ser 12+.** Com o `packageManager` pinado, o pnpm 10
  tenta provisionar o 12 pelo `@pnpm/linux-x64` (que não existe mais nessa
  linha) e falha com `ERR_PNPM_NO_MATCHING_VERSION`. `corepack enable` ou
  `npm i -g pnpm@12` resolvem; o README documenta.
- O lockfile ganhou **dois documentos YAML**: o primeiro pina o próprio
  gerenciador (`packageManagerDependencies` + binários `@pnpm/exe.*`), o segundo
  é o lockfile de sempre (`lockfileVersion: '9.0'`). O CI passa a instalar
  exatamente o pnpm 12.14.0.
- Nenhuma versão de pacote mudou com o upgrade: o diff do lockfile é a saída da
  árvore do jsdom, a entrada do pin do pnpm e o churn de **sufixo de peer** que
  o v12 passou a registrar (`(supports-color@10.2.2)`, `(lightningcss@…)`).
- `pnpm test`/`dev` agora verificam `node_modules` antes de rodar
  (`verifyDepsBeforeRun`): um lockfile fora de sincronia dispara install em vez
  de rodar com a árvore errada.
- Instalar deixa de ser "avisar e ignorar": build novo de transitivo **falha** o
  install até alguém decidir `true` ou `false` nele. É o ponto: cada decisão
  fica registrada no `pnpm-workspace.yaml`.

## Limitações registradas

- O `allowBuilds` aprovado é a árvore de hoje. Dependência nova com build
  script muda o install para vermelho por design — a correção é decidir, não
  desligar o `strictDepBuilds`.
- `overrides: 'vitest>jsdom': '-'` é a única coisa aqui que precisa sair se o
  projeto voltar a usar `environment: 'jsdom'`.
