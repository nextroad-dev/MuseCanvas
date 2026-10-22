import assert from 'node:assert/strict'
import test from 'node:test'

import type { StorageSettingsRow, UpdateStorageSettingsInput } from '@musecanvas/database'
import type { StorageProbeResult } from '../../shared/storage'
import { storageSettingsDto, type ResolvedStorageSettings } from '../settings/runtime'
import {
  STORAGE_SECRET_REENTER_REQUIRED,
  mergeStorageSettings,
  resolveSecretForDriver,
  runStorageSave,
  runStorageTest,
  type StorageSetupDeps,
  type StorageSetupOutcome,
} from './storage-setup'
import { validateStorageInput, type ValidStorageInput } from './validation'

const OLD_CIPHERTEXT = 'ciphertext-of-stored-secret'

function storedRow(overrides: Partial<StorageSettingsRow> = {}): StorageSettingsRow {
  return {
    endpoint: 'https://s3.internal.example',
    public_endpoint: 'https://cdn.example',
    region: 'eu-west-1',
    bucket: 'assets',
    access_key_id: 'AKIA-STORED',
    secret_encrypted: OLD_CIPHERTEXT,
    secret_fingerprint: 'fp-old',
    encryption_key_id: 'key-1',
    signed_url_ttl_seconds: 900,
    status: 'verified',
    storage_driver: 's3',
    local_root: '/srv/previous-root',
    revision: 3,
    updated_at: new Date(0),
    ...overrides,
  }
}

function input(raw: Record<string, unknown>): ValidStorageInput {
  const result = validateStorageInput(raw)
  if ('code' in result) assert.fail(`fixture rejected: ${result.code}`)
  return result
}

interface Recorder {
  persisted: UpdateStorageSettingsInput[]
  decryptCalls: number
  encryptedPlaintexts: string[]
  localProbeRoots: string[]
  s3ProbeSecrets: (string | null)[]
}

interface FakeOptions {
  row?: StorageSettingsRow | null
  decrypt?: () => string
  localProbe?: StorageProbeResult
  s3ProbeFails?: boolean
  persistFails?: boolean
}

function fakeDeps(options: FakeOptions = {}): { deps: StorageSetupDeps; rec: Recorder } {
  const rec: Recorder = { persisted: [], decryptCalls: 0, encryptedPlaintexts: [], localProbeRoots: [], s3ProbeSecrets: [] }
  const deps: StorageSetupDeps = {
    loadRow: async () => (options.row === undefined ? storedRow() : options.row),
    decryptSecret: () => {
      rec.decryptCalls += 1
      return options.decrypt ? options.decrypt() : 'STORED-PLAIN-SECRET'
    },
    encryptSecret: plaintext => {
      rec.encryptedPlaintexts.push(plaintext)
      return { ciphertext: `enc:${plaintext}`, fingerprint: `fp:${plaintext.length}`, keyId: 'key-2' }
    },
    probeLocal: async config => {
      rec.localProbeRoots.push(config.root)
      return options.localProbe ?? { ok: true }
    },
    probeS3: async settings => {
      rec.s3ProbeSecrets.push(settings.secretAccessKey)
      if (options.s3ProbeFails) throw new Error('probe failed')
    },
    persist: async write => {
      if (options.persistFails) throw new Error('db down')
      rec.persisted.push(write)
    },
  }
  return { deps, rec }
}

function assertFailure(outcome: StorageSetupOutcome, status: number, code: string): void {
  if (outcome.ok) assert.fail('expected a failure outcome')
  assert.equal(outcome.status, status)
  assert.equal(outcome.code, code)
}

// Driver x action matrix ------------------------------------------------------

test('local test success persists driver local with status verified and keeps the S3 columns', async () => {
  const { deps, rec } = fakeDeps()
  const outcome = await runStorageTest(input({ driver: 'local', localRoot: 'D:\\musecanvas\\media' }), deps)
  assert.equal(outcome.ok, true)
  assert.deepEqual(rec.localProbeRoots, ['D:\\musecanvas\\media'])
  assert.equal(rec.s3ProbeSecrets.length, 0)
  assert.equal(rec.persisted.length, 1)
  const write = rec.persisted[0]
  assert.equal(write.driver, 'local')
  assert.equal(write.localRoot, 'D:\\musecanvas\\media')
  assert.equal(write.status, 'verified')
  assert.equal(write.endpoint, 'https://s3.internal.example')
  assert.equal(write.bucket, 'assets')
  assert.equal(write.accessKeyId, 'AKIA-STORED')
  assert.equal('secretCiphertext' in write, false, 'a kept secret writes no ciphertext column')
  assert.equal('clearSecret' in write, false)
  assert.equal(rec.decryptCalls, 0, 'local never decrypts the stored S3 secret')
})

test('local test failure returns the driver code and persists nothing', async () => {
  const { deps, rec } = fakeDeps({
    localProbe: { ok: false, code: 'STORAGE_LOCAL_UNWRITABLE', message: '本地存储目录不可写，请检查路径与挂载权限' },
  })
  const outcome = await runStorageTest(input({ driver: 'local', localRoot: '/srv/readonly' }), deps)
  assertFailure(outcome, 400, 'STORAGE_LOCAL_UNWRITABLE')
  assert.equal(rec.persisted.length, 0)
})

test('s3 test failure returns STORAGE_TEST_FAILED and persists nothing', async () => {
  const { deps, rec } = fakeDeps({ s3ProbeFails: true })
  const outcome = await runStorageTest(input({ driver: 's3' }), deps)
  assertFailure(outcome, 400, 'STORAGE_TEST_FAILED')
  assert.equal(rec.persisted.length, 0)
})

test('s3 test success with a kept secret probes with the decrypted stored secret and writes no ciphertext', async () => {
  const { deps, rec } = fakeDeps()
  const outcome = await runStorageTest(input({ driver: 's3' }), deps)
  assert.equal(outcome.ok, true)
  assert.deepEqual(rec.s3ProbeSecrets, ['STORED-PLAIN-SECRET'])
  assert.equal(rec.decryptCalls, 1)
  const write = rec.persisted[0]
  assert.equal(write.driver, 's3')
  assert.equal(write.status, 'verified')
  assert.equal(write.localRoot, '/srv/previous-root', 'the previous local root is preserved for switching back')
  assert.equal('secretCiphertext' in write, false)
})

test('save with local persists driver local with status configured and never decrypts the stored secret', async () => {
  const { deps, rec } = fakeDeps({ decrypt: () => { throw new Error('unreadable') } })
  const outcome = await runStorageSave(input({ driver: 'local', localRoot: '/srv/media' }), deps)
  assert.equal(outcome.ok, true)
  assert.equal(rec.decryptCalls, 0)
  assert.equal(rec.persisted[0].driver, 'local')
  assert.equal(rec.persisted[0].localRoot, '/srv/media')
  assert.equal(rec.persisted[0].status, 'configured')
  assert.equal(rec.persisted[0].bucket, 'assets')
})

test('a save that omits driver keeps a stored local driver and never decrypts the S3 secret', async () => {
  // The web form sends `driver` only when the user switches it, so an unrelated edit
  // (here the signed URL TTL) must not flip a local-disk config back to S3.
  const { deps, rec } = fakeDeps({
    row: storedRow({ storage_driver: 'local', local_root: '/srv/media' }),
    decrypt: () => { throw new Error('unreadable') },
  })
  const outcome = await runStorageSave(input({ signedUrlTtlSeconds: 1200 }), deps)
  assert.equal(outcome.ok, true)
  assert.equal(rec.decryptCalls, 0)
  assert.equal(rec.persisted[0].driver, 'local')
  assert.equal(rec.persisted[0].localRoot, '/srv/media')
  assert.equal(rec.persisted[0].signedUrlTtlSeconds, 1200)
  assert.equal(rec.persisted[0].status, 'configured')
})

test('a test that omits driver probes the stored local root, not S3', async () => {
  const { deps, rec } = fakeDeps({ row: storedRow({ storage_driver: 'local', local_root: '/srv/media' }) })
  const outcome = await runStorageTest(input({ signedUrlTtlSeconds: 600 }), deps)
  assert.equal(outcome.ok, true)
  assert.deepEqual(rec.localProbeRoots, ['/srv/media'])
  assert.equal(rec.s3ProbeSecrets.length, 0)
  assert.equal(rec.persisted[0].driver, 'local')
  assert.equal(rec.persisted[0].status, 'verified')
})

test('a payload that omits driver on an s3 row, or with no row, stays s3', async () => {
  const stored = fakeDeps({ row: storedRow() })
  assert.equal((await runStorageSave(input({ signedUrlTtlSeconds: 600 }), stored.deps)).ok, true)
  assert.equal(stored.rec.persisted[0].driver, 's3')
  const empty = fakeDeps({ row: null })
  assert.equal((await runStorageSave(input({ bucket: 'assets', accessKeyId: 'AKIA1', secretAccessKey: 'secret' }), empty.deps)).ok, true)
  assert.equal(empty.rec.persisted[0].driver, 's3')
})

test('switching back to s3 restores the S3 driver and keeps the stored local root and bucket', async () => {
  const { deps, rec } = fakeDeps({ row: storedRow({ storage_driver: 'local', local_root: '/srv/media' }) })
  const outcome = await runStorageSave(input({ driver: 's3' }), deps)
  assert.equal(outcome.ok, true)
  assert.equal(rec.persisted[0].driver, 's3')
  assert.equal(rec.persisted[0].localRoot, '/srv/media')
  assert.equal(rec.persisted[0].bucket, 'assets')
  assert.equal(rec.persisted[0].status, 'configured')
})

test('save with s3 and no bucket is not_configured', async () => {
  const { deps, rec } = fakeDeps({ row: storedRow({ bucket: null }) })
  const outcome = await runStorageSave(input({ driver: 's3' }), deps)
  assert.equal(outcome.ok, true)
  assert.equal(rec.persisted[0].status, 'not_configured')
})

// Secret re-entry -----------------------------------------------------------

test('an unreadable stored secret blocks s3 test and save when the secret is kept', async () => {
  for (const run of [runStorageTest, runStorageSave]) {
    const { deps, rec } = fakeDeps({ decrypt: () => { throw new Error('bad key') } })
    const outcome = await run(input({ driver: 's3', bucket: 'assets' }), deps)
    assertFailure(outcome, 409, STORAGE_SECRET_REENTER_REQUIRED)
    if (!outcome.ok) assert.match(outcome.message, /重新输入/)
    assert.equal(rec.s3ProbeSecrets.length, 0)
    assert.equal(rec.persisted.length, 0)
  }
})

test('a new secret never reads the stored ciphertext, even when that ciphertext is unreadable', async () => {
  for (const run of [runStorageTest, runStorageSave]) {
    const { deps, rec } = fakeDeps({ decrypt: () => { throw new Error('bad key') } })
    const outcome = await run(input({ driver: 's3', secretAccessKey: 'NEW-SECRET' }), deps)
    assert.equal(outcome.ok, true)
    assert.equal(rec.decryptCalls, 0)
    assert.deepEqual(rec.encryptedPlaintexts, ['NEW-SECRET'])
    assert.equal(rec.persisted[0].secretCiphertext, 'enc:NEW-SECRET')
    assert.equal(rec.persisted[0].secretFingerprint, 'fp:10')
    assert.equal(rec.persisted[0].encryptionKeyId, 'key-2')
  }
})

test('clearing the secret on s3 test fails as incomplete, and on save writes clearSecret', async () => {
  const test1 = fakeDeps()
  const testOutcome = await runStorageTest(input({ driver: 's3', secretAccessKey: '' }), test1.deps)
  assertFailure(testOutcome, 400, 'STORAGE_TEST_FAILED')
  assert.equal(test1.rec.persisted.length, 0)

  const save = fakeDeps()
  const saveOutcome = await runStorageSave(input({ driver: 's3', secretAccessKey: '' }), save.deps)
  assert.equal(saveOutcome.ok, true)
  assert.equal(save.rec.persisted[0].clearSecret, true)
})

test('a failed persist after a good probe returns 500 and reports no success', async () => {
  const { deps } = fakeDeps({ persistFails: true })
  const outcome = await runStorageTest(input({ driver: 'local', localRoot: '/srv/media' }), deps)
  assertFailure(outcome, 500, 'INTERNAL_ERROR')
})

test('a database read failure returns 500 without touching secrets', async () => {
  const deps: StorageSetupDeps = {
    ...fakeDeps().deps,
    loadRow: async () => { throw new Error('connection refused') },
  }
  const outcome = await runStorageSave(input({ driver: 'local', localRoot: '/srv/media' }), deps)
  assertFailure(outcome, 500, 'INTERNAL_ERROR')
})

// Pure helpers -------------------------------------------------------------

test('resolveSecretForDriver reads the stored secret only for a kept s3 secret', () => {
  let calls = 0
  const decrypt = (): string => { calls += 1; return 'PLAIN' }
  assert.deepEqual(resolveSecretForDriver('s3', { kind: 'keep' }, storedRow(), decrypt), { ok: true, secret: 'PLAIN' })
  assert.deepEqual(resolveSecretForDriver('local', { kind: 'keep' }, storedRow(), decrypt), { ok: true, secret: null })
  assert.deepEqual(resolveSecretForDriver('s3', { kind: 'clear' }, storedRow(), decrypt), { ok: true, secret: null })
  assert.deepEqual(resolveSecretForDriver('s3', { kind: 'set', secret: 'NEW' }, storedRow(), decrypt), { ok: true, secret: 'NEW' })
  assert.deepEqual(resolveSecretForDriver('s3', { kind: 'keep' }, storedRow({ secret_encrypted: null }), decrypt), { ok: true, secret: null })
  assert.equal(calls, 1)
})

test('mergeStorageSettings takes omitted fields from the raw row and defaults the TTL when no row exists', () => {
  const fromRow = mergeStorageSettings(input({ driver: 's3' }), 'PLAIN', storedRow())
  assert.equal(fromRow.endpoint, 'https://s3.internal.example')
  assert.equal(fromRow.region, 'eu-west-1')
  assert.equal(fromRow.bucket, 'assets')
  assert.equal(fromRow.signedUrlTtlSeconds, 900)
  assert.equal(fromRow.secretAccessKey, 'PLAIN')

  const noRow = mergeStorageSettings(input({ driver: 'local', localRoot: '/srv/media' }), null, null)
  assert.equal(noRow.region, 'us-east-1')
  assert.equal(noRow.bucket, null)
  assert.equal(noRow.signedUrlTtlSeconds, 900)
  assert.equal(noRow.localRoot, '/srv/media')
})

test('the storage DTO carries driver and localRoot and never a secret', () => {
  const resolved: ResolvedStorageSettings = {
    driver: 'local',
    localRoot: 'D:\\musecanvas\\media',
    endpoint: 'https://s3.internal.example',
    publicEndpoint: null,
    region: 'us-east-1',
    bucket: 'assets',
    accessKeyId: 'AKIA-DTO',
    secretAccessKey: 'DTO-PLAIN-SECRET-VALUE',
    signedUrlTtlSeconds: 900,
    status: 'verified',
    hasSecret: true,
    secretFingerprint: 'fp-dto',
    encryptionKeyId: 'key-1',
    revision: 4,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const dto = storageSettingsDto(resolved)
  const serialized = JSON.stringify(dto)
  assert.equal(dto.driver, 'local')
  assert.equal(dto.localRoot, 'D:\\musecanvas\\media')
  assert.equal(serialized.includes('DTO-PLAIN-SECRET-VALUE'), false)
  assert.equal('secretAccessKey' in dto, false)
  assert.equal('secretCiphertext' in dto, false)
  assert.equal(dto.hasSecret, true)
})
