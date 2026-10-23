import { inflateSync } from 'node:zlib'

/**
 * Extração de texto de PDF sem dependência externa.
 *
 * Cobre o subconjunto mínimo necessário ao MVP: PDFs com camada textual em
 * streams não comprimidos ou `FlateDecode`, operadores `Tj`/`TJ` e strings
 * literais/hex. Não cobre fontes CID/Type0 com `ToUnicode`, layout avançado nem
 * PDFs escaneados (esses retornam texto vazio e o analisador marca
 * `NO_TEXT_LAYER`/`inconclusive`). A troca por uma biblioteca de PDF fica
 * registrada como evolução, não como requisito desta etapa.
 */

const ENDSTREAM = 'endstream'
const STREAM = 'stream'

/**
 * Um PDF hostil pode conter um stream comprimido que expande para muito mais
 * que o arquivo original. O intake limita os bytes de entrada, mas não a
 * expansão; estes limites protegem o worker contra decompression bomb.
 */
const MAX_STREAM_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_TEXT_BYTES = 8 * 1024 * 1024

const decodeStream = (body: string): string => {
  const raw = Buffer.from(body, 'latin1')
  try {
    return inflateSync(raw, { maxOutputLength: MAX_STREAM_BYTES }).toString('latin1')
  } catch {
    return body
  }
}

const streamBodies = (text: string): readonly string[] => {
  const bodies: string[] = []
  let cursor = 0
  let totalBytes = 0
  while (cursor < text.length && totalBytes < MAX_TOTAL_TEXT_BYTES) {
    const start = text.indexOf(STREAM, cursor)
    if (start === -1) break
    // Não confundir o `stream` de `endstream`.
    if (text.slice(Math.max(0, start - 3), start) === 'end') {
      cursor = start + STREAM.length
      continue
    }
    let bodyStart = start + STREAM.length
    if (text[bodyStart] === '\r') bodyStart += 1
    if (text[bodyStart] === '\n') bodyStart += 1
    const end = text.indexOf(ENDSTREAM, bodyStart)
    if (end === -1) break
    const decoded = decodeStream(text.slice(bodyStart, end))
    const remaining = MAX_TOTAL_TEXT_BYTES - totalBytes
    bodies.push(decoded.length > remaining ? decoded.slice(0, remaining) : decoded)
    totalBytes += Math.min(decoded.length, remaining)
    cursor = end + ENDSTREAM.length
  }
  return bodies
}

const decodeLiteral = (raw: string): string => {
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char === undefined) break
    if (char !== '\\') {
      out += char
      continue
    }
    const next = raw[index + 1]
    if (next === undefined) break
    switch (next) {
      case 'n':
        out += '\n'
        break
      case 'r':
        out += '\r'
        break
      case 't':
        out += '\t'
        break
      case 'b':
        out += '\b'
        break
      case 'f':
        out += '\f'
        break
      case '(':
      case ')':
      case '\\':
        out += next
        break
      case '\r':
        if (raw[index + 2] === '\n') index += 1
        break
      case '\n':
        break
      default: {
        if (next >= '0' && next <= '7') {
          let octal = ''
          let cursor = index + 1
          while (octal.length < 3) {
            const following = raw[cursor]
            if (following === undefined || following < '0' || following > '7') break
            octal += following
            cursor += 1
          }
          out += String.fromCharCode(Number.parseInt(octal, 8))
          index = cursor - 1
        } else {
          out += next
        }
      }
    }
  }
  return out
}

interface LiteralRead {
  readonly value: string
  readonly end: number
}

const readLiteralString = (text: string, start: number): LiteralRead => {
  let depth = 1
  let raw = ''
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]
    if (char === undefined) break
    if (char === '\\') {
      const escaped = text[index + 1]
      raw += escaped === undefined ? char : char + escaped
      index += escaped === undefined ? 0 : 1
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return { value: decodeLiteral(raw), end: index + 1 }
    }
    raw += char
  }
  return { value: decodeLiteral(raw), end: text.length }
}

const readHexString = (text: string, start: number): LiteralRead => {
  let hex = ''
  let index = start + 1
  for (; index < text.length; index += 1) {
    const char = text[index]
    if (char === undefined || char === '>') break
    if (/[0-9a-fA-F]/.test(char)) hex += char
  }
  const padded = hex.length % 2 === 0 ? hex : `${hex}0`
  const bytes = Buffer.from(padded, 'hex')
  return {
    value: bytes.toString('latin1').split(String.fromCharCode(0)).join(''),
    end: Math.min(index + 1, text.length),
  }
}

type Token =
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'operator'; readonly value: string }
  | { readonly type: 'array-start' }
  | { readonly type: 'array-end' }

const isAlpha = (char: string): boolean => (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')
const isNumberStart = (char: string): boolean =>
  (char >= '0' && char <= '9') || char === '+' || char === '-' || char === '.'

const tokenize = (content: string): readonly Token[] => {
  const tokens: Token[] = []
  let index = 0
  while (index < content.length) {
    const char = content[index]
    if (char === undefined) break
    if (char === '(') {
      const read = readLiteralString(content, index)
      tokens.push({ type: 'string', value: read.value })
      index = read.end
      continue
    }
    if (char === '<' && content[index + 1] !== '<') {
      const read = readHexString(content, index)
      tokens.push({ type: 'string', value: read.value })
      index = read.end
      continue
    }
    if (char === '[') {
      tokens.push({ type: 'array-start' })
      index += 1
      continue
    }
    if (char === ']') {
      tokens.push({ type: 'array-end' })
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      tokens.push({ type: 'operator', value: char })
      index += 1
      continue
    }
    if (isAlpha(char)) {
      let token = ''
      while (index < content.length) {
        const current = content[index]
        if (current === undefined || !isAlpha(current)) break
        token += current
        index += 1
      }
      tokens.push({ type: 'operator', value: token })
      continue
    }
    if (isNumberStart(char)) {
      let token = ''
      while (index < content.length) {
        const current = content[index]
        if (current === undefined || !/[0-9+\-.]/.test(current)) break
        token += current
        index += 1
      }
      const value = Number(token)
      tokens.push({ type: 'number', value: Number.isFinite(value) ? value : 0 })
      continue
    }
    index += 1
  }
  return tokens
}

const textOfContent = (content: string): string => {
  const tokens = tokenize(content)
  const parts: string[] = []
  let pending: string[] = []
  let arrayDepth = 0

  for (const token of tokens) {
    if (token.type === 'array-start') {
      arrayDepth += 1
      continue
    }
    if (token.type === 'array-end') {
      arrayDepth = Math.max(0, arrayDepth - 1)
      continue
    }
    if (token.type === 'string') {
      pending.push(token.value)
      continue
    }
    if (token.type === 'number') {
      if (arrayDepth > 0 && token.value < -100) pending.push(' ')
      continue
    }
    switch (token.value) {
      case 'Tj':
      case 'TJ':
      case "'":
      case '"':
        parts.push(pending.join(''))
        pending = []
        if (token.value === "'" || token.value === '"') parts.push('\n')
        break
      case 'Td':
      case 'TD':
      case 'T*':
      case 'TL':
      case 'BT':
      case 'ET':
        if (parts.length > 0) parts.push('\n')
        pending = []
        break
      default:
        pending = []
    }
  }
  if (pending.length > 0) parts.push(pending.join(''))
  return parts
    .join('')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extrai o texto concatenado de todas as streams de conteúdo do PDF. Retorna
 * string vazia quando não há camada textual reconhecível.
 */
export const extractPdfText = (data: Uint8Array): string => {
  const raw = Buffer.from(data).toString('latin1')
  return streamBodies(raw)
    .map(textOfContent)
    .filter((text) => text.length > 0)
    .join('\n')
}
