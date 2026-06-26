import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { db } from '../../../../packages/database/src/index'
import { encryptApiKey, decryptApiKey, fingerprintApiKey } from '../../../../packages/providers/src/index'

export type Actor = { id: string; email: string; role: 'user' | 'admin'; status: 'active' | 'disabled'; createdAt: string }
const secret = () => process.env.SESSION_SECRET || ''
export const hashToken = (value: string) => createHash('sha256').update(`${secret()}:${value}`).digest('hex')
export const hashOtp = (email: string, value: string) => createHmac('sha256', secret()).update(`${email}:${value}`).digest('hex')
export const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

export async function actorFrom(request: NextRequest): Promise<Actor | null> {
  const token = request.cookies.get('muse_session')?.value
  if (!token) return null
  const result = await db().query(`SELECT u.id,u.email,u.role,u.status,u.created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active' AND u.deleted_at IS NULL`, [hashToken(token)])
  const row = result.rows[0]
  return row ? { id: row.id, email: row.email, role: row.role, status: row.status, createdAt: row.created_at.toISOString() } : null
}

function oauthEncryptionKey(): Buffer { return createHash('sha256').update(process.env.OAUTH_CREDENTIALS_ENCRYPTION_KEY || '').digest() }
function encryptWithKey(value: string, key: Buffer): string {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.')
}
function decryptWithKey(value: string, key: Buffer): string {
  const [iv, tag, encrypted] = value.split('.'); const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8')
}
export const encryptOAuthSecret = (value: string) => encryptWithKey(value, oauthEncryptionKey())
export const decryptOAuthSecret = (value: string) => decryptWithKey(value, oauthEncryptionKey())
export { encryptApiKey, decryptApiKey, fingerprintApiKey }
