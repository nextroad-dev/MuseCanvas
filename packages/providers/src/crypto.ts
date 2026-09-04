import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import {
  BOOTSTRAP_CONFIG_INVALID,
  CURRENT_KEY_ID,
  DECRYPTION_FAILED,
  ENCRYPTION_FAILED,
  UNSUPPORTED_KEY_ID,
  derivePurposeKey,
  normalizeKeyId,
} from '../../config/src/index';
import type { AppKeyId, EncryptionPurpose } from '../../config/src/index';

/**
 * Version-aware AES-256-GCM envelope helpers bound to HKDF-derived purpose
 * keys (see @musecanvas/config). New writes always use the derived key under
 * CURRENT_KEY_ID; the database owns key_id storage alongside the ciphertext.
 *
 * Compatibility release: provider-credential rows written before the master
 * key rollout (null/legacy key id, keyed by PROVIDER_CREDENTIALS_ENCRYPTION_KEY)
 * remain readable through decryptApiKey/decryptProviderCredential. Fresh
 * encrypts never use the legacy key.
 *
 * Every failure is a stable, non-secret error code: key material, plaintext,
 * and ciphertext never appear in messages.
 */

export {
  BOOTSTRAP_CONFIG_INVALID,
  CURRENT_KEY_ID,
  DECRYPTION_FAILED,
  ENCRYPTION_FAILED,
  ENCRYPTION_PURPOSES,
  UNSUPPORTED_CRYPTO_PURPOSE,
  UNSUPPORTED_KEY_ID,
  derivePurposeKey,
  normalizeKeyId,
} from '../../config/src/index';
export type { AppKeyId, EncryptionPurpose } from '../../config/src/index';

/** Key id label for pre-rollout provider ciphertext. Accepted on read only. */
export const LEGACY_KEY_ID = 'legacy' as const;

export interface EncryptedEnvelope {
  ciphertext: string;
  keyId: AppKeyId;
  fingerprint: string;
}

const PROVIDER_PURPOSE: EncryptionPurpose = 'provider-credentials';
const FINGERPRINT_HEX_CHARS = 8;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const BASE64_PART = /^[A-Za-z0-9+/=_-]+$/;

/** Full HMAC-SHA256 hex of a value under a purpose key (e.g. session-hmac). */
export function hmacForPurpose(value: string, purpose: EncryptionPurpose, keyId?: string | null): string {
  if (typeof value !== 'string') throw new Error(ENCRYPTION_FAILED);
  return createHmac('sha256', derivePurposeKey(purpose, keyId)).update(value, 'utf8').digest('hex');
}

/** Truncated HMAC fingerprint safe for plaintext lookup columns. */
export function fingerprintForPurpose(value: string, purpose: EncryptionPurpose, keyId?: string | null): string {
  return hmacForPurpose(value, purpose, keyId).slice(0, FINGERPRINT_HEX_CHARS);
}

/** Encrypt under a purpose key. New writes always use the current key id. */
export function encryptForPurpose(plaintext: string, purpose: EncryptionPurpose, keyId?: string | null): EncryptedEnvelope {
  if (typeof plaintext !== 'string') throw new Error(ENCRYPTION_FAILED);
  const resolved = normalizeKeyId(keyId);
  const key = derivePurposeKey(purpose, resolved);
  try {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const ciphertext = `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
    return { ciphertext, keyId: resolved, fingerprint: fingerprintForPurpose(plaintext, purpose, resolved) };
  } catch {
    throw new Error(ENCRYPTION_FAILED);
  }
}

/** Decrypt ciphertext written under a purpose key. Fails closed. */
export function decryptForPurpose(ciphertext: string, purpose: EncryptionPurpose, keyId?: string | null): string {
  return decryptWithKey(ciphertext, derivePurposeKey(purpose, normalizeKeyId(keyId)));
}

function parseEnvelope(encrypted: string): { iv: Buffer; tag: Buffer; data: Buffer } {
  if (typeof encrypted !== 'string') throw new Error(DECRYPTION_FAILED);
  const parts = encrypted.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0 || !BASE64_PART.test(part))) {
    throw new Error(DECRYPTION_FAILED);
  }
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64'));
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) throw new Error(DECRYPTION_FAILED);
  return { iv, tag, data };
}

function decryptWithKey(encrypted: string, key: Buffer): string {
  const { iv, tag, data } = parseEnvelope(encrypted);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(DECRYPTION_FAILED);
  }
}

/** Pre-rollout provider key (sha256 of the legacy env secret). Read path only. */
function legacyProviderKey(): Buffer | null {
  const raw = process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) return null;
  return createHash('sha256').update(raw).digest();
}

function isBootstrapError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(BOOTSTRAP_CONFIG_INVALID);
}

export function encryptApiKey(value: string): string {
  return encryptForPurpose(value, PROVIDER_PURPOSE).ciphertext;
}

export function encryptProviderCredential(value: string): EncryptedEnvelope {
  return encryptForPurpose(value, PROVIDER_PURPOSE);
}

export function fingerprintApiKey(value: string): string {
  return fingerprintForPurpose(value, PROVIDER_PURPOSE);
}

/**
 * Dual-read provider credentials: tries the derived current key first, then
 * falls back to the legacy env key for null/legacy rows. A misconfigured
 * APP_MASTER_KEY fails closed instead of silently falling back; unknown key
 * ids fail closed as well.
 */
export function decryptApiKey(encrypted: string, keyId?: string | null): string {
  if (keyId !== undefined && keyId !== null && keyId !== CURRENT_KEY_ID && keyId !== LEGACY_KEY_ID) {
    throw new Error(`${UNSUPPORTED_KEY_ID}: ${keyId}`);
  }
  try {
    return decryptForPurpose(encrypted, PROVIDER_PURPOSE, CURRENT_KEY_ID);
  } catch (error) {
    if (isBootstrapError(error)) throw error;
    const legacy = legacyProviderKey();
    if (!legacy) throw new Error(DECRYPTION_FAILED);
    return decryptWithKey(encrypted, legacy);
  }
}

export function decryptProviderCredential(ciphertext: string, keyId?: string | null): string {
  return decryptApiKey(ciphertext, keyId);
}
