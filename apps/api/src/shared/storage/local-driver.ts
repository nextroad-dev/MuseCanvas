import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, createReadStream, type Stats } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, relative, sep, isAbsolute } from 'node:path'
import type { Readable } from 'node:stream'
import type { ResolvedLocalStorageConfig } from '@musecanvas/database'
import { MEDIA_ROUTE_PATHS, MEDIA_ROUTE_PREFIX } from '../../modules/media/paths'
import { signLocalClaims } from './local-url'
import { assertLocalObjectKey, invalidObjectKey, SIDECAR_SUFFIX } from './object-key'
import {
  STORAGE_LOCAL_UNWRITABLE,
  STORAGE_OBJECT_NOT_FOUND,
  STORAGE_OBJECT_TOO_LARGE,
  STORAGE_PROBE_TIMEOUT_MS,
  StorageDriverError,
  type PutIfAbsentOutcome,
  type SignedUpload,
  type StorageDriver,
  type StorageObjectStream,
} from './types'

// Local-disk driver. Objects live at `<root>/<key>` with a `<key>.meta.json` sidecar holding
// { contentType, size, sha256 }. The on-disk layout is shared with the worker's local driver,
// so both processes must mount the same root.
//
// Safety rules:
// - Keys pass assertLocalObjectKey, then every path component is lstat-ed under the real root.
//   A symlink anywhere on the path, or a leaf that is a symlink, is refused.
// - Writes go to a temp file in the destination directory, fsync, then rename (replace) or link
//   (exclusive create), so readers never observe a partially written object.

export const STORAGE_CONTENT_TYPE_INVALID = 'STORAGE_CONTENT_TYPE_INVALID'
export const STORAGE_UPLOAD_LIMIT_INVALID = 'STORAGE_UPLOAD_LIMIT_INVALID'

/** `type/subtype` token pair, no parameters. Anything else cannot be safely echoed in a header. */
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i
const EXTENSION_CONTENT_TYPES = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['avif', 'image/avif'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mov', 'video/quicktime'],
  ['zip', 'application/zip'],
  ['json', 'application/json'],
  ['txt', 'text/plain'],
])
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'])

export function isValidStorageContentType(value: string): boolean {
  return CONTENT_TYPE_PATTERN.test(value)
}

/** Content type from the extension, used only when no sidecar exists. */
export function contentTypeForKey(key: string): string {
  const slash = key.lastIndexOf('/')
  const dot = key.lastIndexOf('.')
  if (dot <= slash) return 'application/octet-stream'
  return EXTENSION_CONTENT_TYPES.get(key.slice(dot + 1).toLowerCase()) ?? 'application/octet-stream'
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? ''
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function notFound(): StorageDriverError {
  return new StorageDriverError(STORAGE_OBJECT_NOT_FOUND)
}

function unwritable(): StorageDriverError {
  return new StorageDriverError(STORAGE_LOCAL_UNWRITABLE)
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
 * Resolves `<root>/<key>` after proving every intermediate component is a real directory
 * (no symlink) inside the real root. Read mode returns null for a missing path; write mode
 * creates the directories one component at a time, so nothing is created through a symlink.
 */
async function resolveObjectPath(root: string, key: string, mode: 'read' | 'write'): Promise<string | null> {
  assertLocalObjectKey(key)
  if (mode === 'write') {
    await mkdir(root, { recursive: true }).catch(() => {
      throw unwritable()
    })
  }
  let rootReal: string
  try {
    rootReal = await realpath(root)
  } catch (error) {
    if (mode === 'read' && isMissing(error)) return null
    throw unwritable()
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
        if (errorCode(error) !== 'EEXIST') throw unwritable()
      })
      info = await lstat(next).catch(() => {
        throw unwritable()
      })
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw invalidObjectKey()
    dir = next
  }
  const objectPath = join(dir, leaf)
  if (!isInside(rootReal, objectPath)) throw invalidObjectKey()
  const leafInfo = await lstatOrNull(objectPath)
  if (leafInfo?.isSymbolicLink()) throw invalidObjectKey()
  return objectPath
}

interface SidecarMeta {
  contentType: string
  size: number
  sha256: string
}

async function writeSidecar(objectPath: string, meta: SidecarMeta): Promise<void> {
  const temp = join(dirname(objectPath), `.${basename(objectPath)}.meta.${randomUUID()}.tmp`)
  await writeFile(temp, JSON.stringify(meta), { flag: 'wx' })
  try {
    await rename(temp, objectPath + SIDECAR_SUFFIX)
  } catch (error) {
    await unlinkIfExists(temp)
    throw error
  }
}

async function readSidecarContentType(objectPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(objectPath + SIDECAR_SUFFIX, 'utf8')) as { contentType?: unknown }
    return typeof parsed.contentType === 'string' && isValidStorageContentType(parsed.contentType) ? parsed.contentType : undefined
  } catch {
    return undefined
  }
}

/**
 * One in-flight object write. Bytes stream into a temp file in the destination directory.
 * commit('replace') renames over the target; commit('exclusive') publishes with link() so
 * an existing object is never overwritten. Writes beyond maxBytes abort and clean up.
 */
export class LocalObjectWriter {
  private written = 0
  private readonly hash = createHash('sha256')
  private finished = false

  private constructor(
    private readonly handle: FileHandle,
    private readonly tempPath: string,
    private readonly objectPath: string,
    private readonly contentType: string,
    private readonly maxBytes: number,
  ) {}

  static async create(objectPath: string, contentType: string, maxBytes: number): Promise<LocalObjectWriter> {
    const tempPath = join(dirname(objectPath), `.${basename(objectPath)}.${randomUUID()}.tmp`)
    let handle: FileHandle
    try {
      handle = await open(tempPath, 'wx')
    } catch {
      throw unwritable()
    }
    return new LocalObjectWriter(handle, tempPath, objectPath, contentType, maxBytes)
  }

  get size(): number {
    return this.written
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.finished) throw new Error('STORAGE_WRITER_CLOSED')
    if (this.written + chunk.byteLength > this.maxBytes) {
      await this.abort()
      throw new StorageDriverError(STORAGE_OBJECT_TOO_LARGE)
    }
    this.written += chunk.byteLength
    this.hash.update(chunk)
    let offset = 0
    while (offset < chunk.byteLength) {
      const result = await this.handle.write(chunk, offset, chunk.byteLength - offset)
      offset += result.bytesWritten
    }
  }

  async commit(mode: 'replace' | 'exclusive'): Promise<PutIfAbsentOutcome> {
    if (this.finished) throw new Error('STORAGE_WRITER_CLOSED')
    this.finished = true
    try {
      await this.handle.sync()
      await this.handle.close()
      let outcome: PutIfAbsentOutcome = 'created'
      if (mode === 'replace') await rename(this.tempPath, this.objectPath)
      else outcome = await this.publishExclusive()
      if (outcome === 'exists') {
        await unlinkIfExists(this.tempPath)
        return outcome
      }
      await writeSidecar(this.objectPath, {
        contentType: this.contentType,
        size: this.written,
        sha256: this.hash.digest('hex'),
      })
      return outcome
    } catch (error) {
      await unlinkIfExists(this.tempPath).catch(() => undefined)
      throw error
    }
  }

  private async publishExclusive(): Promise<PutIfAbsentOutcome> {
    try {
      await link(this.tempPath, this.objectPath)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'EEXIST') return 'exists'
      if (!LINK_UNSUPPORTED_CODES.has(code)) throw error
      // Filesystems without hard links: COPYFILE_EXCL is still an atomic exclusive create.
      try {
        await copyFile(this.tempPath, this.objectPath, fsConstants.COPYFILE_EXCL)
      } catch (copyError) {
        if (errorCode(copyError) === 'EEXIST') return 'exists'
        throw copyError
      }
    }
    await unlinkIfExists(this.tempPath)
    return 'created'
  }

  async abort(): Promise<void> {
    if (!this.finished) {
      this.finished = true
      await this.handle.close().catch(() => undefined)
    }
    await unlinkIfExists(this.tempPath).catch(() => undefined)
  }
}

export interface LocalStorageDriverOptions {
  /** Origin for signed read URLs. Upload URLs are always relative. Empty or missing yields relative read URLs. */
  publicOrigin?: () => Promise<string>
  /** Clock in milliseconds. Injectable for tests. */
  now?: () => number
}

export class LocalStorageDriver implements StorageDriver {
  readonly kind = 'local' as const
  private readonly publicOrigin: () => Promise<string>
  private readonly now: () => number

  constructor(readonly config: ResolvedLocalStorageConfig, options: LocalStorageDriverOptions = {}) {
    this.publicOrigin = options.publicOrigin ?? (async () => '')
    this.now = options.now ?? Date.now
  }

  /** Size, content type and absolute path of an existing object. Throws STORAGE_OBJECT_NOT_FOUND. */
  async statObject(key: string): Promise<{ path: string; size: number; contentType: string }> {
    const path = await resolveObjectPath(this.config.root, key, 'read')
    if (!path) throw notFound()
    let info: Stats
    try {
      info = await stat(path)
    } catch (error) {
      if (isMissing(error)) throw notFound()
      throw error
    }
    if (!info.isFile()) throw notFound()
    return { path, size: info.size, contentType: (await readSidecarContentType(path)) ?? contentTypeForKey(key) }
  }

  /** Byte stream for an object, optionally limited to an inclusive range. The caller must validate range against statObject().size. */
  async openRead(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const { path } = await this.statObject(key)
    return createReadStream(path, range ? { start: range.start, end: range.end } : undefined)
  }

  /** Streaming writer for uploads that arrive as a request body. Caller must commit() or abort(). */
  async beginWrite(key: string, contentType: string, maxBytes: number): Promise<LocalObjectWriter> {
    if (!isValidStorageContentType(contentType)) throw new StorageDriverError(STORAGE_CONTENT_TYPE_INVALID)
    const path = await resolveObjectPath(this.config.root, key, 'write')
    if (!path) throw unwritable()
    return LocalObjectWriter.create(path, contentType, maxBytes)
  }

  async getBytes(key: string, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
    const { path, size } = await this.statObject(key)
    if (size > maxBytes) throw new StorageDriverError(STORAGE_OBJECT_TOO_LARGE)
    return readFile(path)
  }

  async getStream(key: string, options?: { signal?: AbortSignal }): Promise<StorageObjectStream> {
    const { path, size, contentType } = await this.statObject(key)
    return { body: createReadStream(path, { signal: options?.signal }), contentLength: size, contentType }
  }

  async putBytes(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const writer = await this.beginWrite(key, contentType, bytes.length)
    try {
      await writer.write(bytes)
      await writer.commit('replace')
    } catch (error) {
      await writer.abort()
      throw error
    }
  }

  async putIfAbsent(key: string, bytes: Buffer, contentType: string): Promise<PutIfAbsentOutcome> {
    const writer = await this.beginWrite(key, contentType, bytes.length)
    try {
      await writer.write(bytes)
      return await writer.commit('exclusive')
    } catch (error) {
      await writer.abort()
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    const path = await resolveObjectPath(this.config.root, key, 'read')
    if (!path) return
    await unlinkIfExists(path)
    await unlinkIfExists(path + SIDECAR_SUFFIX)
  }

  async signRead(key: string, ttlSeconds: number): Promise<string> {
    assertLocalObjectKey(key)
    const exp = this.nowSeconds() + ttlSeconds
    const sig = signLocalClaims({ method: 'GET', key, exp })
    const query = new URLSearchParams({ key, exp: String(exp), sig })
    return `${await this.originPrefix()}${MEDIA_ROUTE_PREFIX}/${MEDIA_ROUTE_PATHS.object}?${query.toString()}`
  }

  async signUpload(key: string, contentType: string, maxBytes: number, ttlSeconds: number): Promise<SignedUpload> {
    assertLocalObjectKey(key)
    if (!isValidStorageContentType(contentType)) throw new StorageDriverError(STORAGE_CONTENT_TYPE_INVALID)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new StorageDriverError(STORAGE_UPLOAD_LIMIT_INVALID)
    // Media types are case-insensitive, so the signed claim is always the lowercase form.
    const signedType = contentType.toLowerCase()
    const exp = this.nowSeconds() + ttlSeconds
    const sig = signLocalClaims({ method: 'POST', key, exp, contentType: signedType, maxBytes })
    const query = new URLSearchParams({ key, exp: String(exp), ct: signedType, max: String(maxBytes), sig })
    // Always same-origin: the browser POSTs here, and a cross-origin form post fails the CSRF check.
    return {
      url: `${MEDIA_ROUTE_PREFIX}/${MEDIA_ROUTE_PATHS.upload}?${query.toString()}`,
      fields: {},
    }
  }

  /**
   * Writes, reads back and removes a probe object. Any failure, or no answer within timeoutMs,
   * is STORAGE_LOCAL_UNWRITABLE.
   */
  async test(timeoutMs = STORAGE_PROBE_TIMEOUT_MS): Promise<void> {
    const key = `setup-tests/${randomUUID()}.txt`
    const payload = Buffer.from('musecanvas-setup-test')
    let timer: ReturnType<typeof setTimeout> | undefined
    // A hung volume leaves the round trip pending. The race then settles on the timer, and the
    // round trip keeps running in the background and removes its own probe object when it ends.
    const deadline = new Promise<false>(resolve => {
      timer = setTimeout(resolve, timeoutMs, false)
    })
    let ok: boolean
    try {
      ok = await Promise.race([this.probeRoundTrip(key, payload), deadline])
    } finally {
      clearTimeout(timer)
    }
    if (!ok) throw unwritable()
  }

  /** Never rejects: any failure resolves false. */
  private async probeRoundTrip(key: string, payload: Buffer): Promise<boolean> {
    try {
      await mkdir(this.config.root, { recursive: true })
      await this.putBytes(key, payload, 'text/plain')
      const readBack = await this.getBytes(key, payload.length)
      return readBack.equals(payload)
    } catch {
      return false
    } finally {
      await this.delete(key).catch(() => undefined)
    }
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000)
  }

  private async originPrefix(): Promise<string> {
    return (await this.publicOrigin()).replace(/\/+$/, '')
  }
}
