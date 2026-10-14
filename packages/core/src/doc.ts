export type DocType = 'CPF' | 'CNPJ'

export const digitsOnly = (input: string): string => input.replace(/\D+/g, '')

const isUniformDigits = (digits: string): boolean => /^(\d)\1+$/.test(digits)

const digitAt = (digits: string, index: number): number | null => {
  const char = digits[index]
  return char === undefined ? null : Number(char)
}

const isDigitsOfLength = (rawValue: string, length: number): boolean => {
  const digits = digitsOnly(rawValue)
  return digits.length === length && isUniformDigits(digits) === false
}

const cnpjWeight = (positionFromRight: number): number => ((positionFromRight - 1) % 8) + 2

const cnpjDv = (digits: string, length: number): number | null => {
  const slice = digits.slice(0, length)
  const sum = [...slice].reduce((acc, digit, i) => acc + Number(digit) * cnpjWeight(length - i), 0)
  const rest = sum % 11
  return rest < 2 ? 0 : 11 - rest
}

const cpfDv = (digits: string, length: number): number => {
  const sum = [...digits.slice(0, length)].reduce(
    (acc, digit, i) => acc + Number(digit) * (length + 1 - i),
    0,
  )
  const rest = (sum * 10) % 11
  return rest === 10 ? 0 : rest
}

export const isValidCnpj = (rawValue: string): boolean => {
  const digits = digitsOnly(rawValue)
  if (!isDigitsOfLength(rawValue, 14)) return false
  const dv1 = cnpjDv(digits, 12)
  const dv2 = cnpjDv(digits, 13)
  return dv1 === digitAt(digits, 12) && dv2 === digitAt(digits, 13)
}

export const isValidCpf = (rawValue: string): boolean => {
  const digits = digitsOnly(rawValue)
  if (!isDigitsOfLength(rawValue, 11)) return false
  const dv1 = cpfDv(digits, 9)
  const dv2 = cpfDv(digits, 10)
  return dv1 === digitAt(digits, 9) && dv2 === digitAt(digits, 10)
}

export const isValidDocument = (type: DocType, rawValue: string): boolean =>
  type === 'CNPJ' ? isValidCnpj(rawValue) : isValidCpf(rawValue)
