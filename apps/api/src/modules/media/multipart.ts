// Streaming extraction of the `file` part from a multipart/form-data body.
//
// The browser POSTs a presigned-style form: optional text fields, then the file as the
// last part (the same shape S3 presigned POST uses). The file is streamed to the sink
// chunk by chunk, so memory stays bounded by one chunk plus one delimiter, and the byte
// budget is enforced while reading. Errors are thrown as Error(code):
// MEDIA_UPLOAD_INVALID for malformed bodies, STORAGE_OBJECT_TOO_LARGE past the budget.

export const MEDIA_UPLOAD_INVALID = 'MEDIA_UPLOAD_INVALID'
const MAX_HEADER_BYTES = 16 * 1024
const BOUNDARY_PATTERN = /^[A-Za-z0-9'()+_,\-./:=?]{1,70}$/

/** Boundary parameter of a multipart Content-Type, or null when absent or malformed. */
export function multipartBoundary(contentType: string | null | undefined): string | null {
  if (!contentType) return null
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  const boundary = match?.[1] ?? match?.[2] ?? null
  return boundary && BOUNDARY_PATTERN.test(boundary) ? boundary : null
}

export interface MultipartFileSink {
  /** Called once with the file part's Content-Type (defaults to application/octet-stream). */
  start(contentType: string): void | Promise<void>
  /** Called with the file bytes in order. Chunks are only valid during the call. */
  data(chunk: Uint8Array): void | Promise<void>
}

function parsePartHeaders(text: string): { name: string | undefined; contentType: string } {
  let name: string | undefined
  let contentType = 'application/octet-stream'
  for (const line of text.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (field === 'content-disposition') name = /(?:^|;)\s*name="([^"]*)"/i.exec(value)?.[1]
    else if (field === 'content-type') contentType = value
  }
  return { name, contentType }
}

/**
 * Reads the body until the first part named `file` has ended. Returns true when that part
 * was found and fully delivered, false when the body held no `file` part. Remaining bytes are
 * not consumed: the caller cancels the source.
 */
export async function readMultipartFilePart(
  source: AsyncIterable<Uint8Array>,
  boundary: string,
  sink: MultipartFileSink,
  options: { maxTotalBytes: number },
): Promise<boolean> {
  // The body is conceptually preceded by CRLF, so the first delimiter matches the same way as the rest.
  const delimiter = Buffer.from(`\r\n--${boundary}`, 'latin1')
  const iterator = source[Symbol.asyncIterator]()
  let buffer: Buffer = Buffer.from('\r\n', 'latin1')
  let received = 0

  async function pull(): Promise<void> {
    const next = await iterator.next()
    if (next.done) throw new Error(MEDIA_UPLOAD_INVALID)
    received += next.value.byteLength
    if (received > options.maxTotalBytes) throw new Error('STORAGE_OBJECT_TOO_LARGE')
    buffer = buffer.length === 0 ? Buffer.from(next.value) : Buffer.concat([buffer, next.value])
  }

  /** Consumes up to and including the next delimiter line. Returns 'close' or 'part'. */
  async function seekDelimiter(emit?: (chunk: Uint8Array) => void | Promise<void>): Promise<'close' | 'part'> {
    for (;;) {
      const index = buffer.indexOf(delimiter)
      if (index !== -1) {
        // A delimiter line is followed by "--" (close) or CRLF (next part). Anything else is content
        // that merely starts like the delimiter, so it is data and the search continues after it.
        const after = index + delimiter.length
        while (buffer.length < after + 2) await pull()
        const isClose = buffer[after] === 0x2d && buffer[after + 1] === 0x2d
        const isPart = buffer[after] === 0x0d && buffer[after + 1] === 0x0a
        if (isClose || isPart) {
          if (emit && index > 0) await emit(buffer.subarray(0, index))
          buffer = buffer.subarray(isClose ? after : after + 2)
          return isClose ? 'close' : 'part'
        }
        if (emit) await emit(buffer.subarray(0, index + 1))
        buffer = buffer.subarray(index + 1)
        continue
      }
      // No delimiter yet: everything except a possible partial delimiter at the end is safe to emit.
      const drop = buffer.length - (delimiter.length - 1)
      if (drop > 0) {
        if (emit) await emit(buffer.subarray(0, drop))
        buffer = buffer.subarray(drop)
      }
      await pull()
    }
  }

  async function readHeaders(): Promise<string> {
    for (;;) {
      const index = buffer.indexOf('\r\n\r\n')
      if (index !== -1) {
        const text = buffer.subarray(0, index).toString('utf8')
        buffer = buffer.subarray(index + 4)
        return text
      }
      if (buffer.length > MAX_HEADER_BYTES) throw new Error(MEDIA_UPLOAD_INVALID)
      await pull()
    }
  }

  let kind = await seekDelimiter()
  while (kind === 'part') {
    const part = parsePartHeaders(await readHeaders())
    if (part.name === 'file') {
      await sink.start(part.contentType)
      await seekDelimiter(sink.data)
      return true
    }
    kind = await seekDelimiter()
  }
  return false
}
