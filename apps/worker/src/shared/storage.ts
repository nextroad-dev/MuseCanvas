import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import type { ResolvedS3StorageConfig } from '@musecanvas/database'
import { resolveStorageSettings } from './runtime'

// Storage driver for the worker, chosen per call from the resolved configuration.
//
// - S3: per-settings-revision client cache (as before). Multipart upload for large objects.
// - local: files at `<root>/<key>` plus a `<key>.meta.json` sidecar, the same layout the API's
//   local driver uses. The worker cannot import API source, so the key rules and atomic
//   write are repeated here. Keep the two in step.
//
// Missing storage configuration fails closed with STORAGE_NOT_CONFIGURED at the operation
// site; import time stays side-effect free.

const SIDECAR_SUFFIX = '.meta.json'
const OBJECT_KEY_MAX_LENGTH = 1024
function hasUnsafeCharacter(key: string): boolean {
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index)
    if (code < 0x20 || code === 0x7f || code === 0x5c || code === 0x3a) return true
  }
  return false
}
/** Windows device names, reserved as a segment or as the stem before the first dot, in any letter case. Mirrors the API driver. */
const WINDOWS_RESERVED_STEMS = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from('123456789¹²³').flatMap(digit => [`COM${digit}`, `LPT${digit}`]),
])
function isReservedDeviceSegment(segment: string): boolean {
  const dot = segment.indexOf('.')
  const stem = (dot === -1 ? segment : segment.slice(0, dot)).replace(/ +$/, '').toUpperCase()
  return WINDOWS_RESERVED_STEMS.has(stem)
}
const MULTIPART_THRESHOLD = 8_000_000
const PART_SIZE = 5_000_000

/** Object body: async-iterable chunks plus the transformToByteArray convenience of the S3 SDK body. */
export interface StorageReadBody extends AsyncIterable<Uint8Array> {
  transformToByteArray(): Promise<Uint8Array>
  destroy?: (error?: Error) => void
}

export interface StorageReadResult {
  body: StorageReadBody | undefined
  contentLength: number | undefined
}

/** One operation surface for both drivers. Never exposes credentials or paths. */
export interface WorkerStorageDriver {
  readonly kind: 's3' | 'local'
  open(key: string, signal: AbortSignal): Promise<StorageReadResult>
  put(key: string, data: Buffer, contentType: string, parent?: AbortSignal): Promise<void>
  /** Multipart upload for large S3 objects. Returns the upload id when multipart was used, otherwise null. */
  putLarge(key: string, data: Buffer, contentType: string, parent?: AbortSignal): Promise<string | null>
  delete(key: string, parent?: AbortSignal): Promise<void>
}

/** A storage outage must not hold a job slot forever while its lease renews. */
export function storageOperationSignal(parent?: AbortSignal): AbortSignal {
  const timeout = Number(process.env.WORKER_STORAGE_TIMEOUT_MS || 60_000)
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600_000) throw new Error('INVALID_STORAGE_TIMEOUT')
  const deadline = AbortSignal.timeout(timeout)
  return parent ? AbortSignal.any([parent, deadline]) : deadline
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

interface CachedS3Client {
  key: string
  s3: S3Client
  bucket: string
}

let cached: CachedS3Client | null = null

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
  if (prev) destroy(prev.s3)
}

class S3WorkerStorage implements WorkerStorageDriver {
  readonly kind = 's3' as const

  constructor(private readonly s3: S3Client, private readonly bucket: string) {}

  async open(key: string, signal: AbortSignal): Promise<StorageReadResult> {
    const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal })
    return {
      body: response.Body as unknown as StorageReadBody | undefined,
      contentLength: response.ContentLength,
    }
  }

  async put(key: string, data: Buffer, contentType: string, parent?: AbortSignal): Promise<void> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
      Metadata: { checksum: sha256Hex(data) },
    }), { abortSignal: storageOperationSignal(parent) })
  }

  async putLarge(key: string, data: Buffer, contentType: string, parent?: AbortSignal): Promise<string | null> {
    if (data.length < MULTIPART_THRESHOLD) {
      await this.put(key, data, contentType, parent)
      return null
    }
    const created = await this.s3.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { abortSignal: storageOperationSignal(parent) },
    )
    const uploadId = created.UploadId
    if (!uploadId) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }), { abortSignal: storageOperationSignal(parent) })
      return null
    }
    try {
      const parts: Array<{ ETag?: string; PartNumber: number }> = []
      let partNumber = 1
      for (let offset = 0; offset < data.length; offset += PART_SIZE, partNumber += 1) {
        const chunk = data.subarray(offset, Math.min(offset + PART_SIZE, data.length))
        const uploaded = await this.s3.send(
          new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: chunk }),
          { abortSignal: storageOperationSignal(parent) },
        )
        parts.push({ ETag: uploaded.ETag, PartNumber: partNumber })
      }
      await this.s3.send(
        new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }),
        { abortSignal: storageOperationSignal(parent) },
      )
      return uploadId
    } catch (error) {
      try {
        await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }), { abortSignal: storageOperationSignal() })
      } catch (abortError) {
        console.error('multipart upload abort failed', { key, code: abortError instanceof Error ? abortError.name : 'ABORT_FAILED' })
      }
      throw error
    }
  }

  async delete(key: string, parent?: AbortSignal): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: storageOperationSignal(parent) })
  }
}

async function s3Driver(settings: ResolvedS3StorageConfig): Promise<WorkerStorageDriver> {
  const endpoint = settings.endpoint || settings.publicEndpoint
  if (!endpoint || !settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) {
    throw new Error('STORAGE_NOT_CONFIGURED')
  }
  // Revision covers DB secret rotation (updateStorageSettings bumps revision);
  // endpoint/region/bucket/accessKeyId cover env-driven changes.
  const key = [settings.revision, settings.source, endpoint, settings.region, settings.bucket, settings.accessKeyId].join('|')
  if (!cached || cached.key !== key) {
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
    cached = { key, s3: next, bucket: settings.bucket }
    if (prev) destroy(prev.s3)
  }
  return new S3WorkerStorage(cached.s3, cached.bucket)
}

// ---------------------------------------------------------------------------
// Local disk
// ---------------------------------------------------------------------------

function invalidKey(): Error {
  return new Error('STORAGE_KEY_INVALID')
}

/** Same rules as the API driver. Keys are server-generated; malformed input is refused, not normalised. */
function assertLocalObjectKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > OBJECT_KEY_MAX_LENGTH) throw invalidKey()
  if (hasUnsafeCharacter(key) || key.startsWith('/')) throw invalidKey()
  const segments = key.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw invalidKey()
    if (segment.endsWith('.') || segment.endsWith(' ')) throw invalidKey()
    if (isReservedDeviceSegment(segment)) throw invalidKey()
  }
  // Case-insensitive: on a case-folding volume `x.META.JSON` would resolve to the sidecar of `x`.
  if (segments[segments.length - 1].toUpperCase().endsWith(SIDECAR_SUFFIX.toUpperCase())) throw invalidKey()
  return key
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? ''
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolves `<root>/<key>` after checking each component is a real directory inside the real
 * root. Symlinks are refused. Read mode returns null for a missing path.
 */
async function resolveObjectPath(root: string, key: string, mode: 'read' | 'write'): Promise<string | null> {
  assertLocalObjectKey(key)
  if (mode === 'write') await mkdir(root, { recursive: true })
  let rootReal: string
  try {
    rootReal = await realpath(root)
  } catch (error) {
    if (mode === 'read' && isMissing(error)) return null
    throw error
  }
  const segments = key.split('/')
  const leaf = segments.pop() as string
  let dir = rootReal
  for (const segment of segments) {
    const next = join(dir, segment)
    let info = await lstatOrNull(next)
    if (!info) {
      if (mode === 'read') return null
      await mkdir(next).catch((error: unknown) => {
        if (errorCode(error) !== 'EEXIST') throw error
      })
      info = await lstat(next)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw invalidKey()
    dir = next
  }
  const objectPath = join(dir, leaf)
  if (!isInside(rootReal, objectPath)) throw invalidKey()
  const leafInfo = await lstatOrNull(objectPath)
  if (leafInfo?.isSymbolicLink()) throw invalidKey()
  return objectPath
}

/** Atomic publish: temp file in the destination directory, fsync, rename, then the sidecar. */
async function writeObjectAtomically(root: string, key: string, data: Buffer, contentType: string): Promise<void> {
  const objectPath = await resolveObjectPath(root, key, 'write')
  if (!objectPath) throw invalidKey()
  const temp = join(dirname(objectPath), `.${basename(objectPath)}.${randomUUID()}.tmp`)
  let handle: FileHandle | undefined
  try {
    handle = await open(temp, 'wx')
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, objectPath)
    const sidecar = join(dirname(objectPath), `.${basename(objectPath)}.meta.${randomUUID()}.tmp`)
    await writeFile(sidecar, JSON.stringify({ contentType, size: data.length, sha256: sha256Hex(data) }), { flag: 'wx' })
    await rename(sidecar, objectPath + SIDECAR_SUFFIX)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlinkIfExists(temp)
    throw error
  }
}

function readableBody(stream: Readable): StorageReadBody {
  return Object.assign(stream, {
    transformToByteArray: async (): Promise<Uint8Array> => {
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks)
    },
  })
}

export class LocalWorkerStorage implements WorkerStorageDriver {
  readonly kind = 'local' as const

  constructor(private readonly root: string) {}

  async open(key: string, signal: AbortSignal): Promise<StorageReadResult> {
    const objectPath = await resolveObjectPath(this.root, key, 'read')
    if (!objectPath) throw new Error('STORAGE_OBJECT_NOT_FOUND')
    let info: Stats
    try {
      info = await stat(objectPath)
    } catch (error) {
      if (isMissing(error)) throw new Error('STORAGE_OBJECT_NOT_FOUND', { cause: error })
      throw error
    }
    if (!info.isFile()) throw new Error('STORAGE_OBJECT_NOT_FOUND')
    return { body: readableBody(createReadStream(objectPath, { signal })), contentLength: info.size }
  }

  async put(key: string, data: Buffer, contentType: string, parent?: AbortSignal): Promise<void> {
    parent?.throwIfAborted()
    await writeObjectAtomically(this.root, key, data, contentType)
  }

  /** One atomic write. A local volume has no multipart concept. */
  async putLarge(key: string, data: Buffer, contentType: string, parent?: AbortSignal): Promise<string | null> {
    await this.put(key, data, contentType, parent)
    return null
  }

  async delete(key: string): Promise<void> {
    const objectPath = await resolveObjectPath(this.root, key, 'read')
    if (!objectPath) return
    await unlinkIfExists(objectPath)
    await unlinkIfExists(objectPath + SIDECAR_SUFFIX)
  }
}

// ---------------------------------------------------------------------------
// Selection and helpers
// ---------------------------------------------------------------------------

/** Driver for the current resolved configuration. Throws STORAGE_NOT_CONFIGURED for incomplete S3 settings. */
export async function getStorageDriver(): Promise<WorkerStorageDriver> {
  const settings = await resolveStorageSettings()
  if (settings.driver === 'local') return new LocalWorkerStorage(settings.root)
  return s3Driver(settings)
}

/**
 * Read one object fully into memory, bounded by `maxBytes`.
 *
 * Lives here (rather than in the one caller, the thumbnail backfill) so that
 * scripts/ does not need its own storage configuration path.
 */
export async function getStorageObject(key: string, maxBytes: number): Promise<Buffer> {
  const driver = await getStorageDriver()
  const signal = storageOperationSignal()
  const response = await driver.open(key, signal)
  const body = response.body
  if (!body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  const stop = () => { body.destroy?.(new Error('STORAGE_TIMEOUT')) }
  signal.addEventListener('abort', stop, { once: true })
  try {
    signal.throwIfAborted()
    for await (const chunk of body) {
      signal.throwIfAborted()
      total += chunk.byteLength
      if (total > maxBytes) {
        // Stop the transfer instead of buffering an oversized object.
        body.destroy?.()
        throw new Error(`STORAGE_OBJECT_TOO_LARGE:${String(total)}`)
      }
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  } finally { signal.removeEventListener('abort', stop) }
}

/** Write one small object, with a checksum for both drivers. */
export async function putStorageObject(key: string, data: Buffer, contentType: string): Promise<void> {
  await (await getStorageDriver()).put(key, data, contentType)
}

/** Write one object that may be large. S3 uses multipart above the threshold. */
export async function putStorageObjectLarge(key: string, data: Buffer, contentType: string, parent?: AbortSignal): Promise<string | null> {
  return (await getStorageDriver()).putLarge(key, data, contentType, parent)
}

/** Idempotent single-object delete. */
export async function deleteStorageObject(key: string, parent?: AbortSignal): Promise<void> {
  await (await getStorageDriver()).delete(key, parent)
}
