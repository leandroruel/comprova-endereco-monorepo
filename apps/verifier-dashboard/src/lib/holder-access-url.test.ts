import { describe, expect, it } from 'vitest'
import {
  cleanHolderUrl,
  consumeHolderTokenFromLocation,
  extractHolderToken,
  isHolderAccessPath,
  isHolderTokenLike,
} from './holder-access-url'

/**
 * O link público do Holder carrega um token opaco no caminho da URL.
 * O token é capturado da URL e removido imediatamente: nunca deve permanecer
 * no endereço, no histórico ou em storage. Estes testes cobrem a extração
 * e limpeza puras (sem DOM).
 */
const TOKEN = 'hlt_TEST_TOKEN_0001'

describe('holder-access-url', () => {
  it('reconhece a rota pública /holder/:token', () => {
    expect(isHolderAccessPath(`/holder/${TOKEN}`)).toBe(true)
    expect(isHolderAccessPath('/holder/')).toBe(false)
    expect(isHolderAccessPath('/dashboard')).toBe(false)
    expect(isHolderAccessPath('/holder-access-other')).toBe(false)
  })

  it('extrai o token do caminho da URL', () => {
    expect(extractHolderToken(`http://localhost:5174/holder/${TOKEN}`)).toBe(TOKEN)
  })

  it('ignora token fora da rota pública ou com formato inválido', () => {
    expect(extractHolderToken(`http://localhost:5174/dashboard/${TOKEN}`)).toBeNull()
    expect(extractHolderToken('http://localhost:5174/holder/nope')).toBeNull()
    expect(extractHolderToken('http://localhost:5174/holder')).toBeNull()
    expect(isHolderTokenLike('hlt_')).toBe(false)
    expect(isHolderTokenLike(undefined)).toBe(false)
  })

  it('remove o segmento do token preservando o restante', () => {
    expect(cleanHolderUrl(`http://localhost:5174/holder/${TOKEN}`)).toBe('/holder')
    expect(cleanHolderUrl(`http://localhost:5174/holder/${TOKEN}?lang=pt`)).toBe('/holder?lang=pt')
  })

  it('não acessa storage nem window fora do browser', () => {
    // Sem `window`, a captura é nula em vez de tocar em APIs de browser.
    expect(consumeHolderTokenFromLocation()).toBeNull()
  })
})
