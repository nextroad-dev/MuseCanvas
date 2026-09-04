import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DefaultSafeHttpClient,
  MAX_OUTPUT_BYTES_HARD_CEILING,
  NormalizedProviderError,
  readBoundedOutput,
  type SafeHttpClient,
} from './index'

const png100 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x64, // 100
  0x00, 0x00, 0x00, 0x64, // 100
  0x08, 0x06, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
])
const pngB64 = png100.toString('base64')

const deadHttp = {
  get: async () => {
    throw new Error('must not fetch')
  },
} as unknown as SafeHttpClient

async function rejectsOutputRead(promise: Promise<unknown>, detailMatch?: RegExp): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof NormalizedProviderError)
    assert.equal(err.diagnostic.code, 'OUTPUT_READ_FAILED')
    if (detailMatch) assert.match(err.diagnostic.detail, detailMatch)
    return true
  })
}

test('rejects invalid maxBytes without fetching', async () => {
  assert.equal(MAX_OUTPUT_BYTES_HARD_CEILING, 100_000_000)
  const descriptor = { index: 0, mimeType: 'image/png', b64Json: pngB64 }
  for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_OUTPUT_BYTES_HARD_CEILING + 1]) {
    await rejectsOutputRead(
      readBoundedOutput(descriptor, deadHttp, { maxBytes }, 'probe', '1.0.0'),
      /maxBytes/,
    )
  }
})

test('decodes valid base64 within default and explicit bounds', async () => {
  const output = await readBoundedOutput(
    { index: 0, mimeType: 'image/png', b64Json: pngB64 },
    deadHttp,
  )
  assert.equal(output.data.equals(png100), true)
  assert.equal(output.mimeType, 'image/png')
  assert.equal(output.width, 100)
  assert.equal(output.height, 100)

  const explicit = await readBoundedOutput(
    { index: 0, mimeType: 'image/png', b64Json: pngB64 },
    deadHttp,
    { maxBytes: 64 },
  )
  assert.equal(explicit.sizeBytes, png100.length)
})

test('rejects non-canonical base64 syntax', async () => {
  for (const b64Json of ['!!!', 'abc', 'ab=d', 'abcd=', 'a b c d', `${pngB64}\n`]) {
    await rejectsOutputRead(
      readBoundedOutput({ index: 0, mimeType: 'image/png', b64Json }, deadHttp),
      /canonical base64/,
    )
  }
})

test('prechecks decoded size before allocating', async () => {
  await rejectsOutputRead(
    readBoundedOutput(
      { index: 0, mimeType: 'image/png', b64Json: 'A'.repeat(64) },
      deadHttp,
      { maxBytes: 10 },
    ),
    /exceeds maximum/,
  )
})

test('postchecks empty decoded payloads', async () => {
  await rejectsOutputRead(
    readBoundedOutput({ index: 0, mimeType: 'image/png', b64Json: '' }, deadHttp),
    /invalid or exceeds maximum/,
  )
  await rejectsOutputRead(
    readBoundedOutput({ index: 0, mimeType: 'image/png' }, deadHttp),
    /neither url nor b64Json/,
  )
})

function clientFor(fetchImpl: typeof globalThis.fetch): SafeHttpClient {
  return new DefaultSafeHttpClient({
    pluginId: 'probe',
    version: '1.0.0',
    allowedHosts: ['cdn.example.com'],
    fetchImpl,
  })
}

test('rejects failed downloads and empty remote bodies', async () => {
  const http = clientFor(
    (async () => new Response('missing', { status: 404, statusText: 'Not Found' })) as typeof globalThis.fetch,
  )
  await rejectsOutputRead(
    readBoundedOutput({ index: 0, mimeType: 'image/png', url: 'https://cdn.example.com/a.png' }, http),
    /HTTP 404/,
  )

  const empty = clientFor(
    (async () => new Response('', { status: 200, headers: { 'content-type': 'image/png' } })) as typeof globalThis.fetch,
  )
  await rejectsOutputRead(
    readBoundedOutput({ index: 0, mimeType: 'image/png', url: 'https://cdn.example.com/a.png' }, empty),
    /invalid or exceeds maximum/,
  )
})
