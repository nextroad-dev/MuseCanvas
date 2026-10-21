import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { probeStorageDriver, testStorageDriver } from './index'
import { LocalStorageDriver, contentTypeForKey } from './local-driver'
import { STORAGE_KEY_INVALID, STORAGE_LOCAL_UNWRITABLE, STORAGE_OBJECT_NOT_FOUND, STORAGE_OBJECT_TOO_LARGE, STORAGE_PROBE_TIMEOUT_MS } from './types'
import type { ResolvedLocalStorageConfig } from '@musecanvas/database'

process.env.APP_MASTER_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

async function withTempBase(run: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'mc-local-driver-'))
  try {
    await run(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

function localConfig(root: string): ResolvedLocalStorageConfig {
  return { driver: 'local', source: 'environment', configured: true, root, signedUrlTtlSeconds: 900, revision: 0 }
}

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? (error as Error).message
}

test('round trip: put, stat, read, stream, delete is idempotent', async () => {
  await withTempBase(async base => {
    const root = join(base, 'root')
    const driver = new LocalStorageDriver(localConfig(root))
    const bytes = Buffer.from('synthetic png bytes')
    await driver.putBytes('user-1/run-2/0-abc.png', bytes, 'image/png')

    assert.ok((await driver.getBytes('user-1/run-2/0-abc.png')).equals(bytes))
    const stat = await driver.statObject('user-1/run-2/0-abc.png')
    assert.equal(stat.size, bytes.length)
    assert.equal(stat.contentType, 'image/png')

    const stream = await driver.getStream('user-1/run-2/0-abc.png')
    const chunks: Buffer[] = []
    for await (const chunk of stream.body) chunks.push(Buffer.from(chunk))
    assert.ok(Buffer.concat(chunks).equals(bytes))
    assert.equal(stream.contentLength, bytes.length)

    await driver.delete('user-1/run-2/0-abc.png')
    await driver.delete('user-1/run-2/0-abc.png')
    await assert.rejects(driver.getBytes('user-1/run-2/0-abc.png'), (error: unknown) => codeOf(error) === STORAGE_OBJECT_NOT_FOUND)
    assert.deepEqual(await readdir(join(root, 'user-1', 'run-2')), [])
  })
})

test('writes leave no temp files behind and the sidecar records the content type', async () => {
  await withTempBase(async base => {
    const root = join(base, 'root')
    const driver = new LocalStorageDriver(localConfig(root))
    await driver.putBytes('a/b.bin', Buffer.from('payload'), 'video/mp4')
    assert.deepEqual((await readdir(join(root, 'a'))).sort(), ['b.bin', 'b.bin.meta.json'])
    const meta = JSON.parse(await readFile(join(root, 'a', 'b.bin.meta.json'), 'utf8')) as Record<string, unknown>
    assert.equal(meta.contentType, 'video/mp4')
    assert.equal(meta.size, 7)
    assert.equal(typeof meta.sha256, 'string')
    assert.equal((await driver.statObject('a/b.bin')).contentType, 'video/mp4')
  })
})

test('putIfAbsent: first write creates, same bytes and different bytes both report exists without changing the object', async () => {
  await withTempBase(async base => {
    const driver = new LocalStorageDriver(localConfig(join(base, 'root')))
    const original = Buffer.from('original mask')
    assert.equal(await driver.putIfAbsent('masks/m.png', original, 'image/png'), 'created')
    assert.equal(await driver.putIfAbsent('masks/m.png', Buffer.from('original mask'), 'image/png'), 'exists')
    assert.equal(await driver.putIfAbsent('masks/m.png', Buffer.from('other mask'), 'image/png'), 'exists')
    assert.ok((await driver.getBytes('masks/m.png')).equals(original))
    assert.deepEqual((await readdir(join(base, 'root', 'masks'))).sort(), ['m.png', 'm.png.meta.json'])
  })
})

test('getBytes enforces the size bound before reading', async () => {
  await withTempBase(async base => {
    const driver = new LocalStorageDriver(localConfig(join(base, 'root')))
    await driver.putBytes('x.png', Buffer.alloc(10, 1), 'image/png')
    await assert.rejects(driver.getBytes('x.png', 9), (error: unknown) => codeOf(error) === STORAGE_OBJECT_TOO_LARGE)
    assert.equal((await driver.getBytes('x.png', 10)).length, 10)
  })
})

test('a streaming writer aborts past its limit and leaves neither object nor temp file', async () => {
  await withTempBase(async base => {
    const root = join(base, 'root')
    const driver = new LocalStorageDriver(localConfig(root))
    const writer = await driver.beginWrite('u/big.mp4', 'video/mp4', 4)
    await writer.write(Buffer.from('abc'))
    await assert.rejects(writer.write(Buffer.from('de')), (error: unknown) => codeOf(error) === STORAGE_OBJECT_TOO_LARGE)
    await writer.abort()
    assert.deepEqual(await readdir(join(root, 'u')), [])
  })
})

test('content type falls back to the extension when no sidecar exists', async () => {
  await withTempBase(async base => {
    const root = join(base, 'root')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'plain.png'), 'x')
    await writeFile(join(root, 'plain.unknown'), 'x')
    const driver = new LocalStorageDriver(localConfig(root))
    assert.equal((await driver.statObject('plain.png')).contentType, 'image/png')
    assert.equal((await driver.statObject('plain.unknown')).contentType, 'application/octet-stream')
    assert.equal(contentTypeForKey('a.constructor'), 'application/octet-stream')
  })
})

test('a sidecar with an unusable content type is ignored', async () => {
  await withTempBase(async base => {
    const root = join(base, 'root')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'x.bin'), 'x')
    await writeFile(join(root, 'x.bin.meta.json'), JSON.stringify({ contentType: 'text/html\r\nX-Evil: 1' }))
    const driver = new LocalStorageDriver(localConfig(root))
    assert.equal((await driver.statObject('x.bin')).contentType, 'application/octet-stream')
  })
})

test('keys that escape the root are refused and nothing is written outside it', async () => {
  await withTempBase(async base => {
    const root = join(base, 'root')
    const driver = new LocalStorageDriver(localConfig(root))
    for (const key of ['../escape.png', '/abs.png', 'a/../../escape.png', 'a\\b.png', 'x.meta.json']) {
      await assert.rejects(driver.putBytes(key, Buffer.from('x'), 'image/png'), (error: unknown) => codeOf(error) === STORAGE_KEY_INVALID, key)
    }
    // Keys are validated before any directory is created, so not even the root appears.
    assert.deepEqual(await readdir(base), [])
  })
})

test('a symlinked directory cannot be used to write outside the root', async t => {
  await withTempBase(async base => {
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    try {
      await symlink(outside, join(root, 'link'), 'junction')
    } catch {
      t.skip('symlinks are not permitted on this host')
      return
    }
    const driver = new LocalStorageDriver(localConfig(root))
    await assert.rejects(driver.putBytes('link/file.png', Buffer.from('x'), 'image/png'), (error: unknown) => codeOf(error) === STORAGE_KEY_INVALID)
    assert.deepEqual(await readdir(outside), [])
  })
})

test('a symlink leaf is refused for reads and deletes', async t => {
  await withTempBase(async base => {
    const root = join(base, 'root')
    const secret = join(base, 'secret.txt')
    await mkdir(root, { recursive: true })
    await writeFile(secret, 'do not read')
    try {
      await symlink(secret, join(root, 'leaf.txt'), 'file')
    } catch {
      t.skip('symlinks are not permitted on this host')
      return
    }
    const driver = new LocalStorageDriver(localConfig(root))
    await assert.rejects(driver.getBytes('leaf.txt'), (error: unknown) => codeOf(error) === STORAGE_KEY_INVALID)
    await assert.rejects(driver.delete('leaf.txt'), (error: unknown) => codeOf(error) === STORAGE_KEY_INVALID)
    assert.equal(await readFile(secret, 'utf8'), 'do not read')
  })
})

test('probe: round trip succeeds and leaves no probe object behind', async () => {
  await withTempBase(async base => {
    const root = join(base, 'root')
    assert.deepEqual(await probeStorageDriver(localConfig(root)), { ok: true })
    const remaining = await readdir(join(root, 'setup-tests')).catch(() => [])
    assert.deepEqual(remaining, [])
  })
})

test('probe: a volume that never answers is cut off at the timeout with STORAGE_LOCAL_UNWRITABLE', async () => {
  await withTempBase(async base => {
    class HungDriver extends LocalStorageDriver {
      // A slow fs operation that never completes.
      override putBytes(): Promise<void> {
        return new Promise<void>(() => undefined)
      }
    }
    const started = Date.now()
    await assert.rejects(new HungDriver(localConfig(join(base, 'root'))).test(50), (error: unknown) => codeOf(error) === STORAGE_LOCAL_UNWRITABLE)
    assert.ok(Date.now() - started < 2_000, 'the probe must settle on its own timer')
  })
})

test('probe: a slow operation that finishes inside the timeout still passes and cleans up', async () => {
  await withTempBase(async base => {
    const root = join(base, 'root')
    class SlowDriver extends LocalStorageDriver {
      override async putBytes(key: string, bytes: Buffer, contentType: string): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, 30))
        return super.putBytes(key, bytes, contentType)
      }
    }
    await new SlowDriver(localConfig(root)).test(2_000)
    assert.deepEqual(await readdir(join(root, 'setup-tests')), [])
  })
})

test('probe: the timeout reaches the driver, defaulting to 10 s', async t => {
  const seen: Array<number | undefined> = []
  t.mock.method(LocalStorageDriver.prototype, 'test', async (timeoutMs?: number) => {
    seen.push(timeoutMs)
  })
  const config = localConfig(join(tmpdir(), 'mc-unused-root'))
  await probeStorageDriver(config)
  await probeStorageDriver(config, 250)
  await testStorageDriver(config)
  await testStorageDriver(config, 250)
  assert.deepEqual(seen, [STORAGE_PROBE_TIMEOUT_MS, 250, STORAGE_PROBE_TIMEOUT_MS, 250])
  assert.equal(STORAGE_PROBE_TIMEOUT_MS, 10_000)
})

test('signUpload signs and publishes the lowercase content type', async () => {
  const driver = new LocalStorageDriver(localConfig(join(tmpdir(), 'mc-unused-root')), { publicOrigin: async () => 'https://files.example', now: () => 1_700_000_000_000 })
  const upload = await driver.signUpload('u/mixed.png', 'image/PNG', 1024, 60)
  assert.equal(new URL(upload.url, 'http://same-origin.invalid').searchParams.get('ct'), 'image/png')
})

test('probe: a root that cannot be created reports STORAGE_LOCAL_UNWRITABLE', async () => {
  await withTempBase(async base => {
    const blocker = join(base, 'blocker')
    await writeFile(blocker, 'a file, not a directory')
    const result = await probeStorageDriver(localConfig(join(blocker, 'root')))
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, STORAGE_LOCAL_UNWRITABLE)
    assert.ok(!result.message.includes(blocker), 'message must not echo the path')
  })
})

test('signed read and upload URLs carry the expected shape and are relative without an origin', async () => {
  await withTempBase(async base => {
    const driver = new LocalStorageDriver(localConfig(join(base, 'root')), { publicOrigin: async () => 'https://files.example/', now: () => 1_700_000_000_000 })
    const read = new URL(await driver.signRead('u/a b.png', 120))
    assert.equal(read.origin, 'https://files.example')
    assert.equal(read.pathname, '/api/media/object')
    assert.equal(read.searchParams.get('key'), 'u/a b.png')
    assert.equal(read.searchParams.get('exp'), String(1_700_000_000 + 120))
    assert.match(read.searchParams.get('sig') ?? '', /^[A-Za-z0-9_-]{43}$/)

    const upload = await driver.signUpload('u/new.png', 'image/png', 1024, 60)
    assert.ok(upload.url.startsWith('/api/media/upload?'), 'upload URL is same-origin even when a public origin is configured')
    const up = new URL(upload.url, 'http://same-origin.invalid')
    assert.equal(up.pathname, '/api/media/upload')
    assert.equal(up.searchParams.get('ct'), 'image/png')
    assert.equal(up.searchParams.get('max'), '1024')
    assert.deepEqual(upload.fields, {})

    const relative = new LocalStorageDriver(localConfig(join(base, 'root')), { publicOrigin: async () => '' })
    assert.ok((await relative.signRead('k', 60)).startsWith('/api/media/object?'))
  })
})
