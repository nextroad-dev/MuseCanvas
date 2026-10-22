import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalWorkerStorage, storageOperationSignal } from './storage'

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'mc-worker-storage-'))
  try {
    await run(join(base, 'root'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

function codeOf(error: unknown): string {
  return (error as Error).message
}

test('local round trip: put, open with transformToByteArray, delete is idempotent', async () => {
  await withRoot(async root => {
    const storage = new LocalWorkerStorage(root)
    const data = Buffer.from('generated image bytes')
    assert.equal(await storage.putLarge('user/run/0-abc.png', data, 'image/png'), null)

    const opened = await storage.open('user/run/0-abc.png', storageOperationSignal())
    assert.equal(opened.contentLength, data.length)
    assert.ok(opened.body)
    assert.ok(Buffer.from(await opened.body.transformToByteArray()).equals(data))

    await storage.delete('user/run/0-abc.png')
    await storage.delete('user/run/0-abc.png')
    await assert.rejects(storage.open('user/run/0-abc.png', storageOperationSignal()), (error: unknown) => codeOf(error) === 'STORAGE_OBJECT_NOT_FOUND')
    assert.deepEqual(await readdir(join(root, 'user', 'run')), [])
  })
})

test('writes publish a sidecar and leave no temp file', async () => {
  await withRoot(async root => {
    const storage = new LocalWorkerStorage(root)
    await storage.put('a/b.mp4', Buffer.from('video'), 'video/mp4')
    assert.deepEqual((await readdir(join(root, 'a'))).sort(), ['b.mp4', 'b.mp4.meta.json'])
  })
})

test('keys outside the root are refused before any write', async () => {
  await withRoot(async root => {
    const storage = new LocalWorkerStorage(root)
    for (const key of ['../escape.png', '/abs.png', 'a\\b.png', 'a/./b.png', 'a\u0000b.png', 'x.meta.json']) {
      await assert.rejects(storage.put(key, Buffer.from('x'), 'image/png'), (error: unknown) => codeOf(error) === 'STORAGE_KEY_INVALID', key)
    }
  })
})

test('a symlinked directory is refused for writes and reads', async t => {
  await withRoot(async root => {
    const outside = join(root, '..', 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    try {
      await symlink(outside, join(root, 'link'), 'junction')
    } catch {
      t.skip('symlinks are not permitted on this host')
      return
    }
    const storage = new LocalWorkerStorage(root)
    await assert.rejects(storage.put('link/file.png', Buffer.from('x'), 'image/png'), (error: unknown) => codeOf(error) === 'STORAGE_KEY_INVALID')
    assert.deepEqual(await readdir(outside), [])
  })
})

// Shared with apps/api/src/shared/storage/object-key.test.ts. Keep the two literals identical.
const SHARED_ACCEPTED_KEYS = [
  'meta.json',
  'x.meta.json.bak',
  'CONSOLE',
  'con-1.png',
  'auxiliary.png',
  'COM0',
  'COM10',
  'LPT0',
  'nul2/x.png',
  'x/CONTENT.png',
]
const SHARED_REJECTED_KEYS = [
  'x.meta.json',
  'x.META.JSON',
  'a/b.Meta.Json',
  'CON',
  'con.txt',
  'a/NUL',
  'a/nul.png',
  'prn/x.png',
  'Aux/b',
  'COM1',
  'com9.txt',
  'LPT1/x.png',
  'x/lpt9',
  'COM¹.txt',
  'LPT³',
  'NUL .txt',
]

test('shared vectors: sidecar aliases and Windows device names are refused in any letter case', async () => {
  await withRoot(async root => {
    const storage = new LocalWorkerStorage(root)
    for (const key of SHARED_REJECTED_KEYS) {
      await assert.rejects(storage.put(key, Buffer.from('x'), 'image/png'), (error: unknown) => codeOf(error) === 'STORAGE_KEY_INVALID', JSON.stringify(key))
    }
    for (const key of SHARED_ACCEPTED_KEYS) {
      await storage.put(key, Buffer.from('x'), 'image/png')
    }
  })
})

test('a symlinked leaf is refused for reads', async t => {
  await withRoot(async root => {
    const secret = join(root, '..', 'secret.txt')
    await mkdir(root, { recursive: true })
    await writeFile(secret, 'do not read')
    try {
      await symlink(secret, join(root, 'leaf.txt'), 'file')
    } catch {
      t.skip('symlinks are not permitted on this host')
      return
    }
    const storage = new LocalWorkerStorage(root)
    await assert.rejects(storage.open('leaf.txt', storageOperationSignal()), (error: unknown) => codeOf(error) === 'STORAGE_KEY_INVALID')
  })
})
