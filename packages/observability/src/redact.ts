const CPF_RE = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g
const CNPJ_RE = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g

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
