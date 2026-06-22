import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'

function providerKey(): Buffer {
  return createHash('sha256').update(process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY || '').digest()
}

export function encryptApiKey(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', providerKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.')
}

export function decryptApiKey(encrypted: string): string {
  const [iv, tag, data] = encrypted.split('.')
  const decipher = createDecipheriv('aes-256-gcm', providerKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}

export function fingerprintApiKey(value: string): string {
  return createHmac('sha256', providerKey()).update(value).digest('hex').slice(0, 8)
}
