// Storage driver contract shared by the S3 and local-disk implementations.
// Callers never branch on the driver kind: they get a StorageDriver from
// createStorageDriver(config) and use only these operations.

export type StorageDriverKind = 's3' | 'local'

/**
 * Stable, non-secret error codes raised by drivers. The message is always the
 * bare code, so a caller can match on it without exposing paths or upstream text.
 */
export class StorageDriverError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'StorageDriverError'
    this.code = code
  }
}

export const STORAGE_OBJECT_NOT_FOUND = 'STORAGE_OBJECT_NOT_FOUND'
export const STORAGE_OBJECT_TOO_LARGE = 'STORAGE_OBJECT_TOO_LARGE'
export const STORAGE_KEY_INVALID = 'STORAGE_KEY_INVALID'
export const STORAGE_LOCAL_UNWRITABLE = 'STORAGE_LOCAL_UNWRITABLE'
export const STORAGE_TEST_FAILED = 'STORAGE_TEST_FAILED'
/** Default bound on the setup probe. A hung volume must not block the setup request indefinitely. */
export const STORAGE_PROBE_TIMEOUT_MS = 10_000

export interface StorageObjectStream {
  body: AsyncIterable<Uint8Array>
  contentLength: number | undefined
  contentType: string | undefined
}

export interface SignedUpload {
  url: string
  /** Extra form fields posted before the file part. Empty for the local driver. */
  fields: Record<string, string>
}

export type PutIfAbsentOutcome = 'created' | 'exists'

export interface StorageDriver {
  readonly kind: StorageDriverKind
  /** Whole object in memory. Rejects with STORAGE_OBJECT_TOO_LARGE above maxBytes when given. */
  getBytes(key: string, maxBytes?: number): Promise<Buffer>
  getStream(key: string, options?: { signal?: AbortSignal }): Promise<StorageObjectStream>
  /** Unconditional write. */
  putBytes(key: string, bytes: Buffer, contentType: string): Promise<void>
  /** Exclusive create. Returns 'exists' without touching the stored object when the key is taken. */
  putIfAbsent(key: string, bytes: Buffer, contentType: string): Promise<PutIfAbsentOutcome>
  /** Idempotent: a missing object is success. */
  delete(key: string): Promise<void>
  /** Time-limited URL the browser can GET. */
  signRead(key: string, ttlSeconds: number): Promise<string>
  /** Time-limited form target the browser can POST a single file to. */
  signUpload(key: string, contentType: string, maxBytes: number, ttlSeconds: number): Promise<SignedUpload>
  /** Round trip proving the backend is usable. Throws StorageDriverError with a stable code. */
  test(timeoutMs: number): Promise<void>
}
