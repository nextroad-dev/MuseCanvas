import { createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { db } from '../../../../packages/database/src/index'
import {
  BOOTSTRAP_CONFIG_INVALID,
  CURRENT_KEY_ID,
  DECRYPTION_FAILED,
  LEGACY_KEY_ID,
  UNSUPPORTED_KEY_ID,
  decryptApiKey,
  decryptForPurpose,
  decryptProviderCredential,
  encryptApiKey,
  encryptForPurpose,
  encryptProviderCredential,
  fingerprintApiKey,
  hmacForPurpose,
} from '../../../../packages/providers/src/index'

export type Actor = { id: string; email: string; role: 'user' | 'admin'; status: 'active' | 'disabled'; createdAt: string }

// ---- Session / OTP hashing -------------------------------------------------
const SESSION_HMAC_PURPOSE = 'session-hmac'
const legacyTokenHash = (value: string) =>
  createHash('sha256').update(`${process.env.SESSION_SECRET || ''}:${value}`).digest('hex')
const legacyOtpHash = (email: string, value: string) =>
  createHmac('sha256', process.env.SESSION_SECRET || '').update(`${email}:${value}`).digest('hex')

const currentTokenHash = (value: string): string | null => {
  const raw = process.env.APP_MASTER_KEY
  if (!raw || raw.trim().length === 0) return null
  return hmacForPurpose(value, SESSION_HMAC_PURPOSE)
}
const currentOtpHash = (email: string, value: string): string | null => {
  const raw = process.env.APP_MASTER_KEY
  if (!raw || raw.trim().length === 0) return null
  return hmacForPurpose(`${email}:${value}`, SESSION_HMAC_PURPOSE)
}

/** Current-write hash for new session / invitation tokens. */
export const hashToken = (value: string): string => currentTokenHash(value) ?? legacyTokenHash(value)
/** Current-write hash for new OTP challenges. */
export const hashOtp = (email: string, value: string): string => currentOtpHash(email, value) ?? legacyOtpHash(email, value)

/** All accepted hashes for a session/invitation token, newest first. */
export function hashTokenCandidates(value: string): string[] {
  const out: string[] = []
  const current = currentTokenHash(value)
  if (current) out.push(current)
  const legacy = legacyTokenHash(value)
  if (!out.includes(legacy)) out.push(legacy)
  return out
}

/** All accepted hashes for an OTP code, newest first. */
export function hashOtpCandidates(email: string, value: string): string[] {
  const out: string[] = []
  const current = currentOtpHash(email, value)
  if (current) out.push(current)
  const legacy = legacyOtpHash(email, value)
  if (!out.includes(legacy)) out.push(legacy)
  return out
}

/**
 * Verify an OTP code against current + legacy candidates. Every candidate is
 * compared with the timing-safe comparator (no short-circuit before all
 * comparisons run), so legacy support does not weaken the comparison.
 */
export function verifyOtpHash(storedHash: string, email: string, code: string): boolean {
  let match = false
  for (const candidate of hashOtpCandidates(email, code)) {
    match = safeEqual(storedHash, candidate) || match
  }
  return match
}

export const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

export async function actorFrom(request: NextRequest): Promise<Actor | null> {
  const token = request.cookies.get('muse_session')?.value
  if (!token) return null
  const result = await db().query(
    `SELECT s.token_hash AS session_token_hash,u.id,u.email,u.role,u.status,u.created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash = ANY($1) AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active' AND u.deleted_at IS NULL`,
    [hashTokenCandidates(token)],
  )
  const row = result.rows[0]
  if (!row) return null
  // Lazily migrate legacy-hashed sessions to the current hash on successful auth.
  const current = currentTokenHash(token)
  if (current && row.session_token_hash !== current) {
    try {
      await db().query('UPDATE sessions SET token_hash=$1 WHERE token_hash=$2 AND revoked_at IS NULL', [
        current,
        row.session_token_hash,
      ])
    } catch {
      // Best-effort migration; the request is already authenticated.
    }
  }
  return row ? { id: row.id, email: row.email, role: row.role, status: row.status, createdAt: row.created_at.toISOString() } : null
}

// ---- OAuth client-secret encryption ----------------------------------------
//
// New writes use encryptForPurpose('oauth-credentials') under the current key
// id (app-v1); the caller persists the returned keyId in
// oauth_provider_settings.encryption_key_id. Reads dual-read: current key
// first, then the legacy OAUTH_CREDENTIALS_ENCRYPTION_KEY envelope for
// null/legacy rows. Missing/invalid APP_MASTER_KEY fails closed.

const OAUTH_CREDENTIALS_PURPOSE = 'oauth-credentials'

export function encryptOAuthSecret(value: string): { ciphertext: string; keyId: string } {
  const envelope = encryptForPurpose(value, OAUTH_CREDENTIALS_PURPOSE)
  return { ciphertext: envelope.ciphertext, keyId: envelope.keyId }
}

export function decryptOAuthSecret(ciphertext: string, keyId?: string | null): string {
  const resolved = keyId ?? null
  if (resolved !== null && resolved !== CURRENT_KEY_ID && resolved !== LEGACY_KEY_ID) {
    throw new Error(`${UNSUPPORTED_KEY_ID}: ${resolved}`)
  }
  if (resolved === null || resolved === CURRENT_KEY_ID) {
    try {
      return decryptForPurpose(ciphertext, OAUTH_CREDENTIALS_PURPOSE, CURRENT_KEY_ID)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(BOOTSTRAP_CONFIG_INVALID)) throw error
      // Fall through to the legacy envelope for pre-rollout rows.
    }
  }
  return decryptOAuthSecretLegacy(ciphertext)
}

function decryptOAuthSecretLegacy(value: string): string {
  const raw = process.env.OAUTH_CREDENTIALS_ENCRYPTION_KEY
  if (!raw) throw new Error(DECRYPTION_FAILED)
  const key = createHash('sha256').update(raw).digest()
  const parts = value.split('.')
  if (parts.length !== 3) throw new Error(DECRYPTION_FAILED)
  try {
    const [iv, tag, encrypted] = parts
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error(DECRYPTION_FAILED)
  }
}

// ---- Secure-cookie derivation ----------------------------------------------
//
// Production or an https:// public origin implies Secure; an explicit
// COOKIE_SECURE value keeps overriding for one compatibility release.

export function shouldUseSecureCookie(publicOrigin?: string): boolean {
  const override = process.env.COOKIE_SECURE
  if (override === 'true') return true
  if (override === 'false') return false
  if ((process.env.NODE_ENV || '') === 'production') return true
  return (publicOrigin || '').startsWith('https://')
}

// Source-compatible re-exports. decryptApiKey/decryptProviderCredential accept
// an optional stored key id; omitting it dual-reads current then legacy.
export { encryptApiKey, decryptApiKey, fingerprintApiKey, encryptProviderCredential, decryptProviderCredential }
