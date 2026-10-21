import { Readable } from 'node:stream'
import type { ResolvedLocalStorageConfig } from '@musecanvas/database'
import {
  assertLocalObjectKey,
  currentLocalStorageConfig,
  LocalStorageDriver,
  StorageDriverError,
  verifyLocalClaims,
  isValidStorageContentType,
  type LocalSignedClaims,
} from '../../shared/storage'
import { parseByteRange } from './range'
import { multipartBoundary, MEDIA_UPLOAD_INVALID, readMultipartFilePart } from './multipart'

// Local-disk media endpoints. Both are reached only through URLs minted by
// LocalStorageDriver.signRead / signUpload. Routes are wired by the router, not here.
// Every failure responds with a stable { code } and no path, key or signature text.

/** Multipart framing allowance on top of the declared file size. */
const FORM_OVERHEAD_BYTES = 64 * 1024
const INLINE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
])

/** Test seams. Production calls with no arguments. */
export interface MediaHandlerDeps {
  resolveConfig?: () => Promise<ResolvedLocalStorageConfig | null>
  /** Clock in milliseconds. */
  now?: () => number
}

const STATUS_BY_CODE: Record<string, number> = {
  MEDIA_SIGNATURE_INVALID: 403,
  MEDIA_URL_EXPIRED: 403,
  MEDIA_NOT_FOUND: 404,
  MEDIA_UNAVAILABLE: 500,
  MEDIA_UPLOAD_FAILED: 500,
  MEDIA_UPLOAD_INVALID: 400,
  MEDIA_CONTENT_TYPE_MISMATCH: 415,
  STORAGE_OBJECT_NOT_FOUND: 404,
  STORAGE_OBJECT_TOO_LARGE: 413,
  STORAGE_KEY_INVALID: 400,
  STORAGE_LOCAL_UNWRITABLE: 500,
}

function mediaError(code: string): Response {
  return Response.json(
    { success: false, error: { code, message: code } },
    {
      status: STATUS_BY_CODE[code] ?? 500,
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    },
  )
}

function nowSeconds(deps: MediaHandlerDeps): number {
  return Math.floor((deps.now ?? Date.now)() / 1000)
}

/** Parses the signed query parameters. Anything malformed is a bad signature. */
function parseClaims(params: URLSearchParams, method: 'GET' | 'POST'): (LocalSignedClaims & { sig: string }) | null {
  const key = params.get('key')
  const exp = params.get('exp')
  const sig = params.get('sig')
  if (!key || !exp || !/^\d{1,12}$/.test(exp) || !sig) return null
  if (method === 'GET') return { method, key, exp: Number(exp), sig }
  const contentType = params.get('ct')
  const max = params.get('max')
  if (!contentType || !isValidStorageContentType(contentType) || !max || !/^\d{1,12}$/.test(max) || Number(max) < 1) return null
  return { method, key, exp: Number(exp), contentType, maxBytes: Number(max), sig }
}

/** Lowercase `type/subtype` without parameters. Media types are case-insensitive (RFC 9110, 8.3.1). */
function mediaTypeOf(value: string): string {
  return value.split(';')[0].trim().toLowerCase()
}

/** Only images that cannot execute script and video are rendered inline. Everything else downloads. */
function dispositionFor(contentType: string): string {
  return INLINE_CONTENT_TYPES.has(contentType.toLowerCase()) ? 'inline' : 'attachment'
}

function toWebStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
}

/**
 * GET /api/media/object?key=&exp=&sig=. Streams a local object with Range support.
 * 403 for a bad or expired signature, 404 when the object is missing or the driver is not local.
 */
export async function serveMediaObject(request: Request, deps: MediaHandlerDeps = {}): Promise<Response> {
  try {
    const claims = parseClaims(new URL(request.url).searchParams, 'GET')
    if (!claims) return mediaError('MEDIA_SIGNATURE_INVALID')
    if (!verifyLocalClaims(claims, claims.sig)) return mediaError('MEDIA_SIGNATURE_INVALID')
    const now = nowSeconds(deps)
    if (now >= claims.exp) return mediaError('MEDIA_URL_EXPIRED')
    const config = await (deps.resolveConfig ?? currentLocalStorageConfig)()
    if (!config) return mediaError('MEDIA_NOT_FOUND')
    assertLocalObjectKey(claims.key)

    const driver = new LocalStorageDriver(config, { now: deps.now })
    const info = await driver.statObject(claims.key)
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Type': info.contentType,
      'Cache-Control': `private, max-age=${Math.max(0, claims.exp - now)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': dispositionFor(info.contentType),
    })
    const range = parseByteRange(request.headers.get('range'), info.size)
    if (range.kind === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${info.size}`)
      return new Response(null, { status: 416, headers })
    }
    if (range.kind === 'partial') {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
      headers.set('Content-Length', String(range.end - range.start + 1))
      const stream = await driver.openRead(claims.key, { start: range.start, end: range.end })
      return new Response(toWebStream(stream), { status: 206, headers })
    }
    headers.set('Content-Length', String(info.size))
    const stream = await driver.openRead(claims.key)
    return new Response(toWebStream(stream), { status: 200, headers })
  } catch (error) {
    return mapError(error, 'MEDIA_UNAVAILABLE')
  }
}

function mapError(error: unknown, fallback: string): Response {
  if (error instanceof StorageDriverError) return mediaError(error.code)
  if (error instanceof Error && STATUS_BY_CODE[error.message] !== undefined) return mediaError(error.message)
  return mediaError(fallback)
}

async function* readerChunks(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Uint8Array> {
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    yield value
  }
}

/**
 * POST /api/media/upload?key=&exp=&ct=&max=&sig=. Accepts a multipart form whose `file` part
 * is the object, or a raw body whose Content-Type equals `ct`. The exact content type and the
 * byte limit are enforced while streaming, and the object is published atomically.
 * 204 on success, matching the S3 presigned POST success response.
 */
export async function receiveMediaUpload(request: Request, deps: MediaHandlerDeps = {}): Promise<Response> {
  try {
    const claims = parseClaims(new URL(request.url).searchParams, 'POST')
    if (!claims || claims.method !== 'POST') return mediaError('MEDIA_SIGNATURE_INVALID')
    if (!verifyLocalClaims(claims, claims.sig)) return mediaError('MEDIA_SIGNATURE_INVALID')
    if (nowSeconds(deps) >= claims.exp) return mediaError('MEDIA_URL_EXPIRED')
    const config = await (deps.resolveConfig ?? currentLocalStorageConfig)()
    if (!config) return mediaError('MEDIA_NOT_FOUND')
    if (!request.body) return mediaError('MEDIA_UPLOAD_INVALID')

    const declared = request.headers.get('content-length')
    if (declared !== null && Number(declared) > claims.maxBytes + FORM_OVERHEAD_BYTES) return mediaError('STORAGE_OBJECT_TOO_LARGE')

    const driver = new LocalStorageDriver(config, { now: deps.now })
    const writer = await driver.beginWrite(claims.key, claims.contentType, claims.maxBytes)
    const reader = request.body.getReader()
    try {
      const contentTypeHeader = request.headers.get('content-type') ?? ''
      const mediaType = mediaTypeOf(contentTypeHeader)
      // Older signed URLs may carry a mixed-case claim; compare on the normalised form.
      const expectedType = mediaTypeOf(claims.contentType)
      if (mediaType === 'multipart/form-data') {
        const boundary = multipartBoundary(contentTypeHeader)
        if (!boundary) throw new Error(MEDIA_UPLOAD_INVALID)
        const found = await readMultipartFilePart(readerChunks(reader), boundary, {
          start: partType => {
            if (mediaTypeOf(partType) !== expectedType) throw new Error('MEDIA_CONTENT_TYPE_MISMATCH')
          },
          data: chunk => writer.write(chunk),
        }, { maxTotalBytes: claims.maxBytes + FORM_OVERHEAD_BYTES })
        if (!found) throw new Error(MEDIA_UPLOAD_INVALID)
      } else {
        if (mediaType !== expectedType) throw new Error('MEDIA_CONTENT_TYPE_MISMATCH')
        for await (const chunk of readerChunks(reader)) await writer.write(chunk)
      }
      await writer.commit('replace')
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      await writer.abort()
      throw error
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  } catch (error) {
    return mapError(error, 'MEDIA_UPLOAD_FAILED')
  }
}
