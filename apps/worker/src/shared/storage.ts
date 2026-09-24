import { createHash } from 'node:crypto'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { resolveStorageSettings } from './runtime'

// Per-settings-revision S3 client resolution for the worker.
//
// The worker must start before onboarding exists and must not require S3 until
// a storage operation runs. This module resolves the S3 client lazily from
// resolveStorageSettings() (DB first, legacy env second) and caches one client
// per settings identity. When the identity changes (revision bump, endpoint,
// region, bucket, or access key rotation) the stale client is destroyed so
// configuration changes are observed without a restart.
//
// Missing storage configuration fails closed with STORAGE_NOT_CONFIGURED at the
// storage operation site; import time stays side-effect free.

/** Resolved S3 handle for one settings identity. Never carries secrets itself. */
export interface StorageClientHandle {
  s3: S3Client
  bucket: string
}

interface CachedStorageClient {
  key: string
  handle: StorageClientHandle
}

let cached: CachedStorageClient | null = null

function destroy(client: S3Client): void {
  try {
    client.destroy()
  } catch {
    // Destroy is best-effort; a failed destroy must not break the next client.
  }
}

export function invalidateStorageClient(): void {
  const prev = cached
  cached = null
  if (prev) destroy(prev.handle.s3)
}

export async function getStorageClient(): Promise<StorageClientHandle> {
  const settings = await resolveStorageSettings()
  const endpoint = settings.endpoint || settings.publicEndpoint
  if (!endpoint || !settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) {
    throw new Error('STORAGE_NOT_CONFIGURED')
  }
  // Revision covers DB secret rotation (updateStorageSettings bumps revision);
  // endpoint/region/bucket/accessKeyId cover env-driven changes.
  const key = [
    settings.revision,
    settings.source,
    endpoint,
    settings.region,
    settings.bucket,
    settings.accessKeyId,
  ].join('|')
  if (cached && cached.key === key) return cached.handle
  const next = new S3Client({
    endpoint,
    region: settings.region || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
  })
  const prev = cached
  const handle: StorageClientHandle = { s3: next, bucket: settings.bucket }
  cached = { key, handle }
  if (prev) destroy(prev.handle.s3)
  return handle
}

/**
 * Read one object fully into memory, bounded by `maxBytes`.
 *
 * Lives here (rather than in the one caller, the thumbnail backfill) for two
 * reasons: `@aws-sdk/client-s3` does not resolve from `scripts/` under pnpm's
 * isolated layout, and this module already owns endpoint/credential resolution
 * plus the revision-scoped client cache. One source, no second S3 config path.
 */
export async function getStorageObject(key: string, maxBytes: number): Promise<Buffer> {
  const { s3, bucket } = await getStorageClient()
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const body = response.Body
  if (!body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > maxBytes) {
      // Stop the transfer instead of buffering an oversized object, then let the
      // caller decide: the backfill marks the row and moves on.
      const stream = body as { destroy?: () => void }
      if (typeof stream.destroy === 'function') stream.destroy()
      throw new Error(`STORAGE_OBJECT_TOO_LARGE:${String(total)}`)
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Write one small object, mirroring the worker's checksum metadata convention. */
export async function putStorageObject(key: string, data: Buffer, contentType: string): Promise<void> {
  const { s3, bucket } = await getStorageClient()
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: data,
    ContentType: contentType,
    Metadata: { checksum: createHash('sha256').update(data).digest('hex') },
  }))
}
