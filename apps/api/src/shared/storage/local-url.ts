import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { derivePurposeKey } from '@musecanvas/providers'

// Signed URLs for the local-disk driver. The HMAC key is HKDF-derived from the
// purpose key for object-storage credentials (itself derived from APP_MASTER_KEY).
// Missing or invalid APP_MASTER_KEY throws from derivePurposeKey: signing fails closed.
// The worker never signs, so it does not need this module.

const URL_KEY_INFO = 'musecanvas/local-storage-url/v1'
const MESSAGE_TAG = 'musecanvas-local-storage-url/v1'
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type LocalSignedClaims =
  | { method: 'GET'; key: string; exp: number }
  | { method: 'POST'; key: string; exp: number; contentType: string; maxBytes: number }

function urlSigningKey(): Buffer {
  const master = derivePurposeKey('object-storage-credentials')
  try {
    return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), URL_KEY_INFO, 32))
  } finally {
    master.fill(0)
  }
}

/** Length-safe, unambiguous encoding: a JSON array cannot be split into different claims. */
function canonicalMessage(claims: LocalSignedClaims): string {
  if (claims.method === 'GET') return JSON.stringify([MESSAGE_TAG, 'GET', claims.key, claims.exp])
  return JSON.stringify([MESSAGE_TAG, 'POST', claims.key, claims.exp, claims.contentType, claims.maxBytes])
}

export function signLocalClaims(claims: LocalSignedClaims): string {
  return createHmac('sha256', urlSigningKey()).update(canonicalMessage(claims), 'utf8').digest('base64url')
}

/** Constant-time check. Malformed signatures are rejected before any comparison. */
export function verifyLocalClaims(claims: LocalSignedClaims, signature: string): boolean {
  if (!SIGNATURE_PATTERN.test(signature)) return false
  const expected = Buffer.from(signLocalClaims(claims), 'base64url')
  const given = Buffer.from(signature, 'base64url')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
