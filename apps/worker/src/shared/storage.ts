import { S3Client } from '@aws-sdk/client-s3'
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
