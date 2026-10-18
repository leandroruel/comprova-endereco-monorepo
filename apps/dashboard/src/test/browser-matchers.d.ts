/**
 * Tipos do Vitest Browser Mode para os testes de componente.
 *
 * `@vitest/browser/context` traz os tipos de `page`/`userEvent` e
 * `@vitest/browser/matchers` registra os matchers de DOM (ex.: `toBeVisible`)
 * usados com `expect.element(...)`. Referenciado aqui para valer em todo o
 * projeto, sem depender de cada arquivo de teste.
 */
/// <reference types="@vitest/browser/context" />
/// <reference types="@vitest/browser/matchers" />
