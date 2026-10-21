import assert from 'node:assert/strict'
import test from 'node:test'
import { multipartBoundary, readMultipartFilePart } from './multipart'

const BOUNDARY = 'musecanvas-boundary-123'

function body(parts: Array<{ name: string; type?: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"; filename="f"\r\n`))
    if (part.type) chunks.push(Buffer.from(`Content-Type: ${part.type}\r\n`))
    chunks.push(Buffer.from('\r\n'), part.data, Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(chunks)
}

async function* chunked(buffer: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size)
}

async function extract(source: AsyncIterable<Uint8Array>, maxTotalBytes = 1 << 20) {
  const starts: string[] = []
  const received: Buffer[] = []
  const found = await readMultipartFilePart(source, BOUNDARY, {
    start: type => { starts.push(type) },
    data: chunk => { received.push(Buffer.from(chunk)) },
  }, { maxTotalBytes })
  return { found, starts, bytes: Buffer.concat(received) }
}

// Bytes that look like the delimiter, including a near miss and a lone CRLF.
const tricky = Buffer.from(`\r\n--${BOUNDARY}x\r\n\r\n--${BOUNDARY.slice(0, 10)}\r\n\x89PNG\u0000\r\n`, 'latin1')

test('extracts the file part byte for byte at every chunk size', async () => {
  const file = Buffer.concat([tricky, Buffer.alloc(300, 0xff), tricky])
  const payload = body([
    { name: 'note', data: Buffer.from('hello') },
    { name: 'file', type: 'image/png', data: file },
  ])
  for (const size of [1, 2, 3, 7, 64, 4096]) {
    const result = await extract(chunked(payload, size))
    assert.equal(result.found, true, `size ${size}`)
    assert.deepEqual(result.starts, ['image/png'])
    assert.ok(result.bytes.equals(file), `size ${size}`)
  }
})

test('an empty file part is delivered with no data', async () => {
  const result = await extract(chunked(body([{ name: 'file', type: 'image/png', data: Buffer.alloc(0) }]), 5))
  assert.equal(result.found, true)
  assert.equal(result.bytes.length, 0)
})

test('reports no file part when only other fields are present', async () => {
  const result = await extract(chunked(body([{ name: 'key', data: Buffer.from('v') }]), 4))
  assert.equal(result.found, false)
  assert.deepEqual(result.starts, [])
})

test('a body truncated inside the file part is malformed', async () => {
  const full = body([{ name: 'file', type: 'image/png', data: Buffer.alloc(500, 1) }])
  await assert.rejects(extract(chunked(full.subarray(0, 300), 50)), /MEDIA_UPLOAD_INVALID/)
})

test('the byte budget aborts the read while streaming', async () => {
  const full = body([{ name: 'file', type: 'image/png', data: Buffer.alloc(10_000, 2) }])
  await assert.rejects(extract(chunked(full, 1000), 2000), /STORAGE_OBJECT_TOO_LARGE/)
})

test('the file part content type defaults to application/octet-stream when absent', async () => {
  const result = await extract(chunked(body([{ name: 'file', data: Buffer.from('x') }]), 3))
  assert.deepEqual(result.starts, ['application/octet-stream'])
})

test('multipartBoundary reads quoted and bare boundaries and rejects malformed ones', () => {
  assert.equal(multipartBoundary('multipart/form-data; boundary=abc123'), 'abc123')
  assert.equal(multipartBoundary('multipart/form-data; boundary="a b"'), null)
  assert.equal(multipartBoundary('multipart/form-data; boundary="abc-_.1"'), 'abc-_.1')
  assert.equal(multipartBoundary('multipart/form-data'), null)
  assert.equal(multipartBoundary(null), null)
  assert.equal(multipartBoundary(`multipart/form-data; boundary=${'x'.repeat(71)}`), null)
})
