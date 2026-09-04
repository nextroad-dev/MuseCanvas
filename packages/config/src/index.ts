import { hkdfSync } from 'node:crypto';

/**
 * Bootstrap configuration for MuseCanvas processes.
 *
 * Typed lazy accessors over `process.env`. Nothing in this module reads the
 * environment at import time, so importing it never throws and never breaks
 * test runs that do not touch bootstrap config. Call
 * `assertBootstrapConfig()` once during process startup to fail fast on
 * missing or malformed values.
 *
 * Bootstrap keys: DATABASE_URL, REDIS_URL, APP_MASTER_KEY, NODE_ENV.
 *
 * APP_MASTER_KEY is the single application master secret: exactly 32 bytes,
 * encoded as 64 hex characters or standard/base64url. The raw master key is
 * never exported; callers derive purpose-bound 32-byte keys with
 * `derivePurposeKey()` (HKDF-SHA256 under the current key id).
 */

// Stable, non-secret error codes. Thrown messages carry the code plus a
// reason that never includes secret material.
export const BOOTSTRAP_CONFIG_INVALID = 'BOOTSTRAP_CONFIG_INVALID' as const;
export const UNSUPPORTED_KEY_ID = 'UNSUPPORTED_KEY_ID' as const;
export const UNSUPPORTED_CRYPTO_PURPOSE = 'UNSUPPORTED_CRYPTO_PURPOSE' as const;
export const ENCRYPTION_FAILED = 'ENCRYPTION_FAILED' as const;
export const DECRYPTION_FAILED = 'DECRYPTION_FAILED' as const;

export type NodeEnv = 'development' | 'test' | 'production';

/** Current application key id. All new ciphertext is written under this id. */
export const CURRENT_KEY_ID = 'app-v1' as const;
export type AppKeyId = typeof CURRENT_KEY_ID;

/** Purpose-bound key domains. Immutable; extend only alongside a new key id. */
export const ENCRYPTION_PURPOSES = [
  'session-hmac',
  'setup-session',
  'provider-credentials',
  'provider-run-state',
  'oauth-credentials',
  'smtp-credentials',
  'object-storage-credentials',
] as const;
export type EncryptionPurpose = (typeof ENCRYPTION_PURPOSES)[number];

const KNOWN_PURPOSES: ReadonlySet<string> = new Set(ENCRYPTION_PURPOSES);

interface KeyVersion {
  readonly salt: string;
  readonly info: Readonly<Record<EncryptionPurpose, string>>;
}

/**
 * Versioned, immutable salt/info registry. Entries are frozen at module load
 * and must never change: rotation means adding a new key id, never editing
 * an existing entry, so previously derived keys stay reproducible.
 */
const KEY_VERSIONS: { readonly [K in AppKeyId]: KeyVersion } = Object.freeze({
  'app-v1': {
    salt: 'musecanvas/key-derivation/app-v1',
    info: Object.freeze({
      'session-hmac': 'musecanvas/app-v1/session-hmac',
      'setup-session': 'musecanvas/app-v1/setup-session',
      'provider-credentials': 'musecanvas/app-v1/provider-credentials',
      'provider-run-state': 'musecanvas/app-v1/provider-run-state',
      'oauth-credentials': 'musecanvas/app-v1/oauth-credentials',
      'smtp-credentials': 'musecanvas/app-v1/smtp-credentials',
      'object-storage-credentials': 'musecanvas/app-v1/object-storage-credentials',
    }),
  },
});

function invalid(reason: string): never {
  throw new Error(`${BOOTSTRAP_CONFIG_INVALID}: ${reason}`);
}

/** Parse APP_MASTER_KEY into 32 raw bytes. Never logs or returns the value. */
function parseAppMasterKey(): Buffer {
  const raw = process.env.APP_MASTER_KEY;
  if (!raw || raw.trim().length === 0) invalid('APP_MASTER_KEY is required');
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}={0,2}$/.test(value)) {
    const standard = value.replace(/-/g, '+').replace(/_/g, '/');
    const aligned = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
    const bytes = Buffer.from(aligned, 'base64');
    if (bytes.length === 32) return bytes;
  }
  return invalid('APP_MASTER_KEY must be 32 bytes encoded as 64 hex characters or base64/base64url');
}

const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function requiredUrl(name: 'DATABASE_URL' | 'REDIS_URL'): string {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) invalid(`${name} is required`);
  const value = raw.trim();
  if (!URL_LIKE.test(value)) invalid(`${name} must be a valid URL`);
  return value;
}

export function getDatabaseUrl(): string {
  return requiredUrl('DATABASE_URL');
}

export function getRedisUrl(): string {
  return requiredUrl('REDIS_URL');
}

export function getNodeEnv(): NodeEnv {
  const raw = (process.env.NODE_ENV || '').trim() || 'development';
  if (raw === 'development' || raw === 'test' || raw === 'production') return raw;
  return invalid('NODE_ENV must be one of development, test, production');
}

/**
 * Resolve a stored key id to a supported derivation version. Nullish means
 * "current". Anything else fails closed.
 */
export function normalizeKeyId(keyId?: string | null): AppKeyId {
  if (keyId === undefined || keyId === null || keyId === CURRENT_KEY_ID) return CURRENT_KEY_ID;
  throw new Error(`${UNSUPPORTED_KEY_ID}: ${keyId}`);
}

/**
 * Derive the 32-byte HKDF-SHA256 key for a purpose under a supported key id.
 * Each purpose yields a different key. Bootstrap/purpose/key-id problems
 * throw their stable codes directly and are never wrapped.
 */
export function derivePurposeKey(purpose: EncryptionPurpose, keyId?: string | null): Buffer {
  if (typeof purpose !== 'string' || !KNOWN_PURPOSES.has(purpose)) {
    throw new Error(`${UNSUPPORTED_CRYPTO_PURPOSE}: ${String(purpose)}`);
  }
  const version = KEY_VERSIONS[normalizeKeyId(keyId)];
  const master = parseAppMasterKey();
  const derived = Buffer.from(hkdfSync('sha256', master, version.salt, version.info[purpose], 32));
  master.fill(0);
  return derived;
}

export interface BootstrapConfigSummary {
  databaseUrl: string;
  redisUrl: string;
  nodeEnv: NodeEnv;
  keyId: AppKeyId;
}

/**
 * Validate every bootstrap key for process startup. Fails fast with
 * BOOTSTRAP_CONFIG_INVALID when anything is absent or malformed. The summary
 * carries the key id but never key material.
 */
export function assertBootstrapConfig(): BootstrapConfigSummary {
  const databaseUrl = getDatabaseUrl();
  const redisUrl = getRedisUrl();
  const nodeEnv = getNodeEnv();
  const master = parseAppMasterKey();
  if (master.length !== 32) invalid('APP_MASTER_KEY must decode to exactly 32 bytes');
  master.fill(0);
  return { databaseUrl, redisUrl, nodeEnv, keyId: CURRENT_KEY_ID };
}
