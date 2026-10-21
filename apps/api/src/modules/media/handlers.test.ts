import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ResolvedLocalStorageConfig } from '@musecanvas/database'
import { LocalStorageDriver } from '../../shared/storage/local-driver'
import { signLocalClaims } from '../../shared/storage/local-url'
import { receiveMediaUpload, serveMediaObject, type MediaHandlerDeps } from './handlers'

process.env.APP_MASTER_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const NOW_MS = 1_700_000_000_000
const BOUNDARY = 'musecanvas-test-boundary'
const TTL = 120

function config(root: string): ResolvedLocalStorageConfig {
  return { driver: 'local', source: 'environment', configured: true, root, signedUrlTtlSeconds: TTL, revision: 0 }
}

function driverFor(root: string, nowMs = NOW_MS): LocalStorageDriver {
  return new LocalStorageDriver(config(root), { publicOrigin: async () => 'https://files.example', now: () => nowMs })
}

function depsFor(root: string, nowMs = NOW_MS): MediaHandlerDeps {
  return { resolveConfig: async () => config(root), now: () => nowMs }
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'mc-media-'))
  try {
    await run(join(base, 'root'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

const PAGE_ORIGIN = 'https://files.example'

/** Upload URLs are same-origin paths, so tests resolve them against the page origin before building requests. */
function absoluteUrl(url: string): string {
  return new URL(url, PAGE_ORIGIN).toString()
}

function withParams(url: string, changes: Record<string, string>): string {
  const parsed = new URL(absoluteUrl(url))
  for (const [key, value] of Object.entries(changes)) parsed.searchParams.set(key, value)
  return parsed.toString()
}

function multipartBody(parts: Array<{ name: string; type?: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"; filename="f"\r\n`))
    if (part.type) chunks.push(Buffer.from(`Content-Type: ${part.type}\r\n`))
    chunks.push(Buffer.from('\r\n'), part.data, Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(chunks)
}

function uploadRequest(url: string, contentType: string, body: Buffer): Request {
  return new Request(absoluteUrl(url), { method: 'POST', headers: { 'content-type': contentType }, body: new Uint8Array(body) })
}

async function errorCode(response: Response): Promise<string> {
  const payload = (await response.json()) as { error?: { code?: string } }
  return payload.error?.code ?? ''
}

test('serves a signed object with full, partial and suffix ranges', async () => {
  await withRoot(async root => {
    await driverFor(root).putBytes('u/a.png', Buffer.from('abcdefghij'), 'image/png')
    const url = await driverFor(root).signRead('u/a.png', TTL)

    const full = await serveMediaObject(new Request(url), depsFor(root))
    assert.equal(full.status, 200)
    assert.equal(await full.text(), 'abcdefghij')
    assert.equal(full.headers.get('content-type'), 'image/png')
    assert.equal(full.headers.get('content-length'), '10')
    assert.equal(full.headers.get('accept-ranges'), 'bytes')
    assert.equal(full.headers.get('content-disposition'), 'inline')
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(full.headers.get('cache-control'), `private, max-age=${TTL}`)

    const middle = await serveMediaObject(new Request(url, { headers: { range: 'bytes=2-4' } }), depsFor(root))
    assert.equal(middle.status, 206)
    assert.equal(await middle.text(), 'cde')
    assert.equal(middle.headers.get('content-range'), 'bytes 2-4/10')
    assert.equal(middle.headers.get('content-length'), '3')

    const suffix = await serveMediaObject(new Request(url, { headers: { range: 'bytes=-3' } }), depsFor(root))
    assert.equal(suffix.status, 206)
    assert.equal(await suffix.text(), 'hij')
  })
})

test('an unsatisfiable range is 416 with the object size', async () => {
  await withRoot(async root => {
    await driverFor(root).putBytes('u/a.png', Buffer.from('abcdefghij'), 'image/png')
    const url = await driverFor(root).signRead('u/a.png', TTL)
    const response = await serveMediaObject(new Request(url, { headers: { range: 'bytes=20-' } }), depsFor(root))
    assert.equal(response.status, 416)
    assert.equal(response.headers.get('content-range'), 'bytes */10')
  })
})

test('scripts and documents are served as attachments', async () => {
  await withRoot(async root => {
    await driverFor(root).putBytes('u/page.html', Buffer.from('<script>1</script>'), 'text/html')
    await driverFor(root).putBytes('u/icon.svg', Buffer.from('<svg/>'), 'image/svg+xml')
    for (const key of ['u/page.html', 'u/icon.svg']) {
      const url = await driverFor(root).signRead(key, TTL)
      const response = await serveMediaObject(new Request(url), depsFor(root))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-disposition'), 'attachment', key)
    }
  })
})

test('signature failures are 403 with a stable code', async () => {
  await withRoot(async root => {
    await driverFor(root).putBytes('u/a.png', Buffer.from('abcdefghij'), 'image/png')
    const url = await driverFor(root).signRead('u/a.png', TTL)
    const exp = new URL(url).searchParams.get('exp') ?? ''

    const tamperedKey = await serveMediaObject(new Request(withParams(url, { key: 'u/b.png' })), depsFor(root))
    assert.equal(tamperedKey.status, 403)
    assert.equal(await errorCode(tamperedKey), 'MEDIA_SIGNATURE_INVALID')

    const tamperedExp = await serveMediaObject(new Request(withParams(url, { exp: String(Number(exp) + 3600) })), depsFor(root))
    assert.equal(tamperedExp.status, 403)

    const missingSig = await serveMediaObject(new Request(withParams(url, { sig: '' })), depsFor(root))
    assert.equal(missingSig.status, 403)

    const expired = await serveMediaObject(new Request(url), depsFor(root, NOW_MS + (TTL + 1) * 1000))
    assert.equal(expired.status, 403)
    assert.equal(await errorCode(expired), 'MEDIA_URL_EXPIRED')
  })
})

test('an upload-signed URL cannot be used to read, and a read URL cannot be used to upload', async () => {
  await withRoot(async root => {
    await driverFor(root).putBytes('u/a.png', Buffer.from('abcdefghij'), 'image/png')
    const readUrl = await driverFor(root).signRead('u/a.png', TTL)
    const upload = await driverFor(root).signUpload('u/a.png', 'image/png', 64, TTL)
    const asRead = await serveMediaObject(new Request(absoluteUrl(upload.url)), depsFor(root))
    assert.equal(asRead.status, 403)
    const asUpload = await receiveMediaUpload(uploadRequest(readUrl, 'image/png', Buffer.from('x')), depsFor(root))
    assert.equal(asUpload.status, 403)
  })
})

test('a missing object is 404 and a driver that is not local serves nothing', async () => {
  await withRoot(async root => {
    const missing = await driverFor(root).signRead('u/none.png', TTL)
    const response = await serveMediaObject(new Request(missing), depsFor(root))
    assert.equal(response.status, 404)
    assert.equal(await errorCode(response), 'STORAGE_OBJECT_NOT_FOUND')

    const notLocal = await serveMediaObject(new Request(missing), { resolveConfig: async () => null, now: () => NOW_MS })
    assert.equal(notLocal.status, 404)
    assert.equal(await errorCode(notLocal), 'MEDIA_NOT_FOUND')
  })
})

test('multipart upload stores the object atomically with its content type and returns 204', async () => {
  await withRoot(async root => {
    const upload = await driverFor(root).signUpload('u/up.png', 'image/png', 64, TTL)
    const body = multipartBody([{ name: 'file', type: 'image/png', data: Buffer.from('pngbytes') }])
    const response = await receiveMediaUpload(uploadRequest(upload.url, `multipart/form-data; boundary=${BOUNDARY}`, body), depsFor(root))
    assert.equal(response.status, 204)
    assert.ok((await driverFor(root).getBytes('u/up.png')).equals(Buffer.from('pngbytes')))
    assert.equal((await driverFor(root).statObject('u/up.png')).contentType, 'image/png')
    assert.deepEqual((await readdir(join(root, 'u'))).sort(), ['up.png', 'up.png.meta.json'])
  })
})

test('a file part with a different content type is refused and leaves nothing behind', async () => {
  await withRoot(async root => {
    const upload = await driverFor(root).signUpload('u/up.png', 'image/png', 64, TTL)
    const body = multipartBody([{ name: 'file', type: 'image/jpeg', data: Buffer.from('jpegbytes') }])
    const response = await receiveMediaUpload(uploadRequest(upload.url, `multipart/form-data; boundary=${BOUNDARY}`, body), depsFor(root))
    assert.equal(response.status, 415)
    assert.equal(await errorCode(response), 'MEDIA_CONTENT_TYPE_MISMATCH')
    assert.deepEqual(await readdir(join(root, 'u')), [])
  })
})

test('an oversized file is aborted at the limit and leaves nothing behind', async () => {
  await withRoot(async root => {
    const upload = await driverFor(root).signUpload('u/big.png', 'image/png', 64, TTL)
    const body = multipartBody([{ name: 'file', type: 'image/png', data: Buffer.alloc(5000, 7) }])
    const response = await receiveMediaUpload(uploadRequest(upload.url, `multipart/form-data; boundary=${BOUNDARY}`, body), depsFor(root))
    assert.equal(response.status, 413)
    assert.equal(await errorCode(response), 'STORAGE_OBJECT_TOO_LARGE')
    assert.deepEqual(await readdir(join(root, 'u')), [])
  })
})

test('tampering with the signed content type or limit invalidates the upload URL', async () => {
  await withRoot(async root => {
    const upload = await driverFor(root).signUpload('u/up.png', 'image/png', 64, TTL)
    const body = multipartBody([{ name: 'file', type: 'image/png', data: Buffer.from('ok') }])
    const retyped = await receiveMediaUpload(uploadRequest(withParams(upload.url, { ct: 'image/jpeg' }), `multipart/form-data; boundary=${BOUNDARY}`, body), depsFor(root))
    assert.equal(retyped.status, 403)
    const relimited = await receiveMediaUpload(uploadRequest(withParams(upload.url, { max: '100000' }), `multipart/form-data; boundary=${BOUNDARY}`, body), depsFor(root))
    assert.equal(relimited.status, 403)
  })
})

test('a raw body must match the signed content type exactly', async () => {
  await withRoot(async root => {
    const upload = await driverFor(root).signUpload('u/raw.webp', 'image/webp', 64, TTL)
    const wrong = await receiveMediaUpload(uploadRequest(upload.url, 'image/png', Buffer.from('raw')), depsFor(root))
    assert.equal(wrong.status, 415)
    const right = await receiveMediaUpload(uploadRequest(upload.url, 'image/webp', Buffer.from('raw')), depsFor(root))
    assert.equal(right.status, 204)
    assert.equal((await driverFor(root).getBytes('u/raw.webp')).toString(), 'raw')
  })
})

test('content type comparison ignores case and parameters on the media type, and still rejects other types', async () => {
  await withRoot(async root => {
    // Signed as given; the driver normalises the claim to lowercase.
    const raw = await driverFor(root).signUpload('u/mixed.png', 'image/PNG', 64, TTL)
    assert.equal(new URL(raw.url, PAGE_ORIGIN).searchParams.get('ct'), 'image/png')
    const jpegRaw = await receiveMediaUpload(uploadRequest(raw.url, 'image/jpeg', Buffer.from('jpeg')), depsFor(root))
    assert.equal(jpegRaw.status, 415)
    assert.equal(await errorCode(jpegRaw), 'MEDIA_CONTENT_TYPE_MISMATCH')
    const pngRaw = await receiveMediaUpload(uploadRequest(raw.url, 'image/png; charset=binary', Buffer.from('pngbytes')), depsFor(root))
    assert.equal(pngRaw.status, 204)
    assert.equal((await driverFor(root).statObject('u/mixed.png')).contentType, 'image/png')

    const multipart = await driverFor(root).signUpload('u/mixed-form.png', 'image/PNG', 64, TTL)
    const jpegPart = await receiveMediaUpload(uploadRequest(multipart.url, `multipart/form-data; boundary=${BOUNDARY}`, multipartBody([{ name: 'file', type: 'image/jpeg', data: Buffer.from('jpeg') }])), depsFor(root))
    assert.equal(jpegPart.status, 415)
    const pngPart = await receiveMediaUpload(uploadRequest(multipart.url, `multipart/form-data; boundary=${BOUNDARY}`, multipartBody([{ name: 'file', type: 'IMAGE/png; name=x', data: Buffer.from('pngbytes') }])), depsFor(root))
    assert.equal(pngPart.status, 204)
  })
})

test('a URL signed with a mixed-case claim still matches the lowercase media type', async () => {
  await withRoot(async root => {
    const exp = Math.floor(NOW_MS / 1000) + TTL
    const key = 'u/legacy.png'
    const sig = signLocalClaims({ method: 'POST', key, exp, contentType: 'image/PNG', maxBytes: 64 })
    const url = `${PAGE_ORIGIN}/api/media/upload?${new URLSearchParams({ key, exp: String(exp), ct: 'image/PNG', max: '64', sig }).toString()}`
    const accepted = await receiveMediaUpload(uploadRequest(url, 'image/png', Buffer.from('legacy')), depsFor(root))
    assert.equal(accepted.status, 204)
    const rejected = await receiveMediaUpload(uploadRequest(url, 'image/jpeg', Buffer.from('legacy')), depsFor(root))
    assert.equal(rejected.status, 415)
  })
})

test('a multipart request without a boundary is malformed', async () => {
  await withRoot(async root => {
    const upload = await driverFor(root).signUpload('u/x.png', 'image/png', 64, TTL)
    const response = await receiveMediaUpload(uploadRequest(upload.url, 'multipart/form-data', Buffer.from('x')), depsFor(root))
    assert.equal(response.status, 400)
    assert.equal(await errorCode(response), 'MEDIA_UPLOAD_INVALID')
  })
})
