import { createHash } from 'node:crypto'
import { MAX_MASK_BYTES } from '@musecanvas/contracts'
import nodemailer from 'nodemailer'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { StorageConfigError, isStorageConfigError, type ResolvedStorageConfig } from '@musecanvas/database'
import { createStorageDriver, probeStorageDriver, STORAGE_OBJECT_TOO_LARGE, StorageDriverError, type StorageDriver } from './storage'
import {
  resolveSmtpSettings,
  resolveStorageSettings,
  type ResolvedSmtpSettings,
  type ResolvedStorageSettings,
} from '../modules/settings/runtime'

// Mail and object-storage helpers resolve DB-first settings through the
// runtime resolvers (DB singleton, then legacy env, then contract defaults).
// The optional `explicit` overrides carry caller-supplied plaintext configs
// for the setup test paths; they overlay the resolved values field by field.
// Secrets are write-only: they are passed to the SDKs and never logged.

export interface SmtpExplicitConfig {
  host?: string | null
  port?: number | null
  tlsMode?: ResolvedSmtpSettings['tlsMode']
  username?: string | null
  /** Plaintext password override for test paths. Never logged or persisted here. */
  password?: string | null
  fromAddress?: string | null
  fromName?: string | null
}

export interface StorageExplicitConfig {
  endpoint?: string | null
  publicEndpoint?: string | null
  region?: string | null
  bucket?: string | null
  accessKeyId?: string | null
  /** Plaintext secret override for test paths. Never logged or persisted here. */
  secretAccessKey?: string | null
  signedUrlTtlSeconds?: number | null
}

interface SmtpEffective {
  host: string
  port: number
  secure: boolean
  requireTLS: boolean
  user: string
  pass: string
  fromAddress: string
  fromName: string
}

async function effectiveSmtp(explicit?: SmtpExplicitConfig): Promise<SmtpEffective> {
  const base = await resolveSmtpSettings().catch((): ResolvedSmtpSettings | null => null)
  const mode = explicit?.tlsMode ?? base?.tlsMode ?? 'none'
  const host = explicit?.host ?? base?.host ?? null
  if (!host) throw new Error('SMTP_NOT_CONFIGURED')
  return {
    host,
    port: explicit?.port ?? base?.port ?? 1025,
    secure: mode === 'implicit_tls',
    requireTLS: mode === 'starttls',
    user: explicit?.username ?? base?.username ?? '',
    pass: explicit?.password ?? base?.password ?? '',
    fromAddress: explicit?.fromAddress ?? base?.fromAddress ?? 'no-reply@musecanvas.local',
    fromName: explicit?.fromName ?? base?.fromName ?? 'MuseCanvas',
  }
}

function smtpEncryptionAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.ALLOW_INSECURE_SMTP === 'true'
}

export async function sendMail(
  to: string,
  subject: string,
  text: string,
  explicit?: SmtpExplicitConfig,
): Promise<void> {
  const cfg = await effectiveSmtp(explicit)
  const insecure = !cfg.secure && !cfg.requireTLS
  if (insecure && !smtpEncryptionAllowed()) throw new Error('SMTP_ENCRYPTION_REQUIRED')
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  })
  await transport.sendMail({ from: { address: cfg.fromAddress, name: cfg.fromName }, to, subject, text })
}

/** Real connection check against the submitted (or stored) SMTP config. Throws coded errors only. */
export async function verifySmtpConnection(explicit?: SmtpExplicitConfig, timeoutMs = 15000): Promise<void> {
  const cfg = await effectiveSmtp(explicit)
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  })
  try {
    await withTimeout(transport.verify(), timeoutMs, 'SMTP_TEST_FAILED')
  } catch (error) {
    if (error instanceof Error && error.message === 'SMTP_TEST_FAILED') throw error
    throw new Error('SMTP_TEST_FAILED')
  } finally {
    transport.close()
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs)
  })
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer)
  })
}

/**
 * Effective object-storage configuration for a call. Ambient calls use the saved
 * driver: 'local' yields a local config, anything else the S3 fields (with the
 * historical defaults). An explicit config is always S3 and overlays the ambient
 * S3 fields, so a setup test still works while the saved driver is 'local'.
 */
async function effectiveStorage(explicit?: StorageExplicitConfig): Promise<ResolvedStorageConfig> {
  const base = await resolveStorageSettings().catch((error: unknown): ResolvedStorageSettings | null => {
    // Ambient config errors fail closed. An explicit setup-test config carries its own values and does not need them.
    if (!explicit && isStorageConfigError(error)) throw error
    return null
  })
  if (!explicit && base?.driver === 'local') {
    if (!base.localRoot) throw new StorageConfigError('local storage root is not configured')
    return {
      driver: 'local',
      source: 'database',
      configured: true,
      root: base.localRoot,
      signedUrlTtlSeconds: base.signedUrlTtlSeconds,
      revision: base.revision,
    }
  }
  const endpoint = explicit?.endpoint ?? base?.endpoint ?? null
  const publicEndpoint = explicit?.publicEndpoint ?? base?.publicEndpoint ?? null
  const bucket = explicit?.bucket ?? base?.bucket ?? 'musecanvas'
  const accessKeyId = explicit?.accessKeyId ?? base?.accessKeyId ?? ''
  const secretAccessKey = explicit?.secretAccessKey ?? base?.secretAccessKey ?? ''
  return {
    driver: 's3',
    source: base ? 'database' : 'environment',
    configured: Boolean((endpoint || publicEndpoint) && bucket && accessKeyId && secretAccessKey),
    endpoint,
    publicEndpoint,
    region: explicit?.region ?? base?.region ?? 'us-east-1',
    bucket,
    accessKeyId,
    secretAccessKey,
    signedUrlTtlSeconds: explicit?.signedUrlTtlSeconds ?? base?.signedUrlTtlSeconds ?? 900,
    forcePathStyle: true,
    revision: base?.revision ?? 0,
  }
}

function isPreconditionFailure(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
  return status === 409 || status === 412
}

export type AssetSigner = (objectKey: string) => Promise<string>

/** Request-local only: settings and SDK client are shared, signed URLs are not
 * cached across requests, users, or a credential/configuration change. */
export function createAssetSigner(explicit?: StorageExplicitConfig): AssetSigner {
  let initialized: Promise<{ driver: StorageDriver; ttlSeconds: number }> | undefined
  return async objectKey => {
    initialized ??= effectiveStorage(explicit).then(config => ({
      driver: createStorageDriver(config),
      ttlSeconds: config.signedUrlTtlSeconds,
    }))
    const { driver, ttlSeconds } = await initialized
    return driver.signRead(objectKey, ttlSeconds)
  }
}

export async function signedAssetUrl(objectKey: string, explicit?: StorageExplicitConfig): Promise<string> {
  return createAssetSigner(explicit)(objectKey)
}

export async function createUploadPresignedPost(
  objectKey: string,
  mimeType: string,
  maxSizeBytes: number,
  expiresInSeconds = 900,
  explicit?: StorageExplicitConfig,
): Promise<{ url: string; fields: Record<string, string> }> {
  const driver = createStorageDriver(await effectiveStorage(explicit))
  return driver.signUpload(objectKey, mimeType, maxSizeBytes, expiresInSeconds)
}

/**
 * Writes server-held bytes into the private bucket: an administrator-uploaded
 * plugin artifact (entry bundle, original zip package, icon), and the two inputs
 * of a masked edit (`POST /api/images/edit`) that arrive in its own request body
 * — the source image the browser posted and the alpha mask rasterised from the
 * selection.
 *
 * Never presigned. The entry bundle is never handed to a client: only the worker
 * fetches and executes it. The admin-only package download and icon routes read
 * the zip and icon back through the API, never through a signed URL. A staged
 * input is an ordinary image, visible to its owner through the same short-lived
 * signed URL every other generation input uses, and to nobody else.
 */
export async function putPrivateS3ObjectBytes(
  objectKey: string,
  bytes: Buffer,
  contentType = 'application/octet-stream',
  explicit?: StorageExplicitConfig,
): Promise<void> {
  const driver = createStorageDriver(await effectiveStorage(explicit))
  await driver.putBytes(objectKey, bytes, contentType)
}

function assertSameReservedMask(existing: Buffer, bytes: Buffer): void {
  if (existing.length !== bytes.length || !existing.equals(bytes)
    || createHash('sha256').update(existing).digest('hex') !== createHash('sha256').update(bytes).digest('hex')) throw new Error('PREPARATION_ARTIFACT_CONFLICT')
}

/** Reserved Agent masks are immutable, even when a stale preparation resumes.
 * Only conditional conflicts may be read back. No unconditional retry or delete.
 * `ports` is the test seam for the raw S3 conditional PUT; production uses the driver. */
export async function putReservedImageMask(objectKey: string, bytes: Buffer, ports?: {
  bucket: string; put: (command: PutObjectCommand) => Promise<unknown>; read: (maxBytes: number) => Promise<Buffer>
}): Promise<void> {
  if (!bytes.length || bytes.length > MAX_MASK_BYTES) throw new Error('MASK_BYTE_LIMIT_EXCEEDED')
  if (ports) {
    try {
      await ports.put(new PutObjectCommand({ Bucket: ports.bucket, Key: objectKey, Body: bytes, ContentType: 'image/png', IfNoneMatch: '*' }))
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error
      assertSameReservedMask(await ports.read(MAX_MASK_BYTES), bytes)
    }
    return
  }
  const driver = createStorageDriver(await effectiveStorage())
  const outcome = await driver.putIfAbsent(objectKey, bytes, 'image/png')
  if (outcome === 'exists') {
    const existing = await driver.getBytes(objectKey, MAX_MASK_BYTES).catch((error: unknown) => {
      if (error instanceof StorageDriverError && error.code === STORAGE_OBJECT_TOO_LARGE) throw new Error('MASK_BYTE_LIMIT_EXCEEDED')
      throw error
    })
    assertSameReservedMask(existing, bytes)
  }
}

export async function getPrivateS3ObjectBytes(
  objectKey: string,
  explicit?: StorageExplicitConfig,
): Promise<Buffer> {
  const driver = createStorageDriver(await effectiveStorage(explicit))
  return driver.getBytes(objectKey)
}

export async function deleteS3Object(objectKey: string, explicit?: StorageExplicitConfig): Promise<void> {
  const driver = createStorageDriver(await effectiveStorage(explicit))
  await driver.delete(objectKey)
}

/**
 * Storage round-trip check with the submitted (or stored) configuration. Failed
 * checks throw a coded error only: raw upstream text never propagates. Nothing is
 * persisted here. The driver owns the probe, so S3 and local share one contract.
 */
export async function testStorageConnection(
  explicit?: StorageExplicitConfig,
  timeoutMs = 20000,
): Promise<void> {
  const result = await probeStorageDriver(await effectiveStorage(explicit), timeoutMs)
  if (!result.ok) throw new Error('STORAGE_TEST_FAILED')
}
