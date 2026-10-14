import type { FacadeClass } from '@comprova/providers'

export interface RubricExample {
  readonly text: string
  readonly klass: FacadeClass
}

export const RUBRIC: Record<Exclude<FacadeClass, 'UNKNOWN'>, readonly RubricExample[]> = {
  COMMERCIAL: [
    { text: 'Fachada com vitrine e placa "Mercadinho Bom Preco"', klass: 'COMMERCIAL' },
    { text: 'Letreiro de empresa, entrada com portao de clientes', klass: 'COMMERCIAL' },
  ],
  RESIDENTIAL: [
    { text: 'Casa com porta simples, janelas com cortina, sem placa', klass: 'RESIDENTIAL' },
    { text: 'Porta de apartamento em sobrado, campainha residencial', klass: 'RESIDENTIAL' },
  ],
  VACANT_LOT: [{ text: 'Terreno com grama e muro baixo, sem construcao', klass: 'VACANT_LOT' }],
  CONDOMINIUM: [{ text: 'Portaria com interfone e mural de unidades numeradas', klass: 'CONDOMINIUM' }],
  CONSTRUCTION: [{ text: 'Obra com tapume e andaime, placa de empreiteira', klass: 'CONSTRUCTION' }],
}

const hasWord = (text: string, word: string): boolean =>
  new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`).test(text)

export const classifyByRubricKeywords = (text: string): FacadeClass => {
  const t = text.toUpperCase()
  if (hasWord(t, 'VITRINE') || hasWord(t, 'PLACA DE') || hasWord(t, 'LETREIRO')) return 'COMMERCIAL'
  if (hasWord(t, 'PORTARIA') || hasWord(t, 'INTERFONE')) return 'CONDOMINIUM'
  if (hasWord(t, 'TAPUME') || hasWord(t, 'ANDAIME') || hasWord(t, 'OBRA')) return 'CONSTRUCTION'
  if (hasWord(t, 'TERRENO')) return 'VACANT_LOT'
  if (hasWord(t, 'CASA') || hasWord(t, 'APARTAMENTO') || hasWord(t, 'CORTINA')) return 'RESIDENTIAL'
  if (hasWord(t, 'SOBRADO') || hasWord(t, 'QUINTAL')) return 'RESIDENTIAL'
  return 'UNKNOWN'
}
