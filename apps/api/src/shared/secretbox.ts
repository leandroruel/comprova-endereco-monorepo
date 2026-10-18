import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const deriveKey = (pepper: string): Buffer => createHash('sha256').update(`webhook-secret:${pepper}`).digest()

export const encryptSecret = (pepper: string, plaintext: string): Buffer => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(pepper), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted])
}

export const decryptSecret = (pepper: string, sealed: Buffer): string => {
  const iv = sealed.subarray(0, 12)
  const tag = sealed.subarray(12, 28)
  const encrypted = sealed.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(pepper), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
