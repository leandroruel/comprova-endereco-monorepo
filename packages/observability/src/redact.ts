/**
 * CPF/CNPJ só são mascarados quando o número aparece como um TOKEN isolado:
 * as bordas exigem que o caractere vizinho não seja alfanumérico. Sem isso,
 * uma sequência de 11 dígitos no meio de um identificador hexadecimal (UUID,
 * sha256, hash de documento) seria tratada como CPF e o identificador sairia
 * corrompido no log (`...-c25483651880` → `...-c***REDACTED***`).
 */
const CPF_RE = /(?<![0-9A-Za-z])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![0-9A-Za-z])/g
const CNPJ_RE = /(?<![0-9A-Za-z])\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?![0-9A-Za-z])/g

const REDACTED = '***REDACTED***'

const SENSITIVE_KEY_RE =
  /^(nome|name|nome_socio|nome_fantasia|razao_social|address|endereco|logradouro|complemento|bairro|email|telefone|phone|numero|street|city|cidade_exterior|doc|document|document_value|cpf|cnpj)$/i

export const redactString = (value: string): string =>
  value.replace(CNPJ_RE, REDACTED).replace(CPF_RE, REDACTED)

export const redactDeep = (value: unknown): unknown =>
  typeof value === 'string'
    ? redactString(value)
    : value === null || typeof value !== 'object'
      ? value
      : Array.isArray(value)
        ? value.map(redactDeep)
        : Object.fromEntries(
            Object.entries(value).map(([key, v]) => [
              key,
              SENSITIVE_KEY_RE.test(key) ? REDACTED : redactDeep(v),
            ]),
          )
