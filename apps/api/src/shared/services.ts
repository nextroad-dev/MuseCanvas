import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
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

interface StorageEffective {
  endpoint: string | null
  publicEndpoint: string | null
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  signedUrlTtlSeconds: number
}

async function effectiveStorage(explicit?: StorageExplicitConfig): Promise<StorageEffective> {
  const base = await resolveStorageSettings().catch((): ResolvedStorageSettings | null => null)
  return {
    endpoint: explicit?.endpoint ?? base?.endpoint ?? null,
    publicEndpoint: explicit?.publicEndpoint ?? base?.publicEndpoint ?? null,
    region: explicit?.region ?? base?.region ?? 'us-east-1',
    bucket: explicit?.bucket ?? base?.bucket ?? 'musecanvas',
    accessKeyId: explicit?.accessKeyId ?? base?.accessKeyId ?? '',
    secretAccessKey: explicit?.secretAccessKey ?? base?.secretAccessKey ?? '',
    signedUrlTtlSeconds: explicit?.signedUrlTtlSeconds ?? base?.signedUrlTtlSeconds ?? 900,
  }
}

function storageClient(endpoint: string | null, region: string, accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    endpoint: endpoint ?? undefined,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })
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

export async function signedAssetUrl(objectKey: string, explicit?: StorageExplicitConfig): Promise<string> {
  const cfg = await effectiveStorage(explicit)
  const client = storageClient(cfg.publicEndpoint || cfg.endpoint, cfg.region, cfg.accessKeyId, cfg.secretAccessKey)
  return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: objectKey }), {
    expiresIn: cfg.signedUrlTtlSeconds,
  })
}

export async function createUploadPresignedPost(
  objectKey: string,
  mimeType: string,
  maxSizeBytes: number,
  expiresInSeconds = 900,
  explicit?: StorageExplicitConfig,
): Promise<{ url: string; fields: Record<string, string> }> {
  const cfg = await effectiveStorage(explicit)
  const client = storageClient(cfg.publicEndpoint || cfg.endpoint, cfg.region, cfg.accessKeyId, cfg.secretAccessKey)
  const result = await createPresignedPost(client, {
    Bucket: cfg.bucket,
    Key: objectKey,
    Conditions: [
      ['content-length-range', 1, maxSizeBytes],
      { 'Content-Type': mimeType },
    ],
    Fields: {
      'Content-Type': mimeType,
    },
    Expires: expiresInSeconds,
  })
  return {
    url: result.url,
    fields: result.fields,
  }
}

export async function getPrivateS3ObjectBytes(
  objectKey: string,
  explicit?: StorageExplicitConfig,
): Promise<Buffer> {
  const cfg = await effectiveStorage(explicit)
  const client = storageClient(cfg.endpoint || cfg.publicEndpoint, cfg.region, cfg.accessKeyId, cfg.secretAccessKey)
  const response = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: objectKey }))
  if (!response.Body) throw new Error('S3_OBJECT_EMPTY')
  const bytes = await response.Body.transformToByteArray()
  return Buffer.from(bytes)
}

export async function deleteS3Object(objectKey: string, explicit?: StorageExplicitConfig): Promise<void> {
  const cfg = await effectiveStorage(explicit)
  const client = storageClient(cfg.endpoint || cfg.publicEndpoint, cfg.region, cfg.accessKeyId, cfg.secretAccessKey)
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: objectKey }))
}

/**
 * Storage round-trip check: HeadBucket plus a temporary Put/Get/Delete cycle.
 * Used by the setup storage test path with the submitted config. Failed
 * checks throw coded errors only — raw upstream text never propagates — and
 * the temporary object is removed best-effort. Nothing is persisted here.
 */
export async function testStorageConnection(
  explicit?: StorageExplicitConfig,
  timeoutMs = 20000,
): Promise<void> {
  const cfg = await effectiveStorage(explicit)
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) throw new Error('STORAGE_TEST_FAILED')
  const client = storageClient(cfg.endpoint || cfg.publicEndpoint, cfg.region, cfg.accessKeyId, cfg.secretAccessKey)
  const key = `setup-tests/${randomUUID()}.txt`
  try {
    await withTimeout(client.send(new HeadBucketCommand({ Bucket: cfg.bucket })), timeoutMs, 'STORAGE_TEST_FAILED')
    await withTimeout(
      client.send(new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: 'musecanvas-setup-test',
        ContentType: 'text/plain',
      })),
      timeoutMs,
      'STORAGE_TEST_FAILED',
    )
    const got = await withTimeout(
      client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key })),
      timeoutMs,
      'STORAGE_TEST_FAILED',
    )
    try {
      await got.Body?.transformToByteArray()
    } catch {
      throw new Error('STORAGE_TEST_FAILED')
    }
    await withTimeout(
      client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key })),
      timeoutMs,
      'STORAGE_TEST_FAILED',
    )
  } catch (error) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))
    } catch {
      // Best-effort cleanup of the temporary probe object.
    }
    if (error instanceof Error && error.message === 'STORAGE_TEST_FAILED') throw error
    throw new Error('STORAGE_TEST_FAILED')
  }
}
