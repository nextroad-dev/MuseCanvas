import assert from 'node:assert/strict'
import test from 'node:test'
import type { StorageSettingsRow } from './repositories/onboarding'
import {
  isStorageConfigError,
  resolveStorageConfig,
  StorageConfigError,
  type ResolvedStorageConfig,
} from './storage-config'

function row(overrides: Partial<StorageSettingsRow> = {}): StorageSettingsRow {
  return {
    endpoint: null,
    public_endpoint: null,
    region: 'us-east-1',
    bucket: null,
    access_key_id: null,
    secret_encrypted: null,
    secret_fingerprint: null,
    encryption_key_id: null,
    signed_url_ttl_seconds: 900,
    status: 'not_configured',
    storage_driver: 's3',
    local_root: null,
    revision: 3,
    updated_at: new Date(0),
    ...overrides,
  }
}

const usableS3Row = row({
  status: 'verified',
  endpoint: 'https://storage.internal.example',
  public_endpoint: 'https://media.example',
  region: 'eu-central-1',
  bucket: 'musecanvas',
  access_key_id: 'AKID',
  secret_encrypted: 'cipher-v1',
  encryption_key_id: 'key-1',
  signed_url_ttl_seconds: 1200,
  revision: 7,
})

/** Decrypt stand-in: returns a recognisable plaintext and records every call. */
function decrypter(calls: string[] = []) {
  return (stored: StorageSettingsRow) => {
    calls.push(stored.secret_encrypted ?? '')
    return `plain-of-${stored.secret_encrypted}`
  }
}

function failingDecrypter() {
  return () => {
    throw new Error('wrong key')
  }
}

function expectS3(config: ResolvedStorageConfig) {
  assert.equal(config.driver, 's3')
  if (config.driver !== 's3') throw new Error('unreachable')
  return config
}

function expectLocal(config: ResolvedStorageConfig) {
  assert.equal(config.driver, 'local')
  if (config.driver !== 'local') throw new Error('unreachable')
  return config
}

test('s3 from a configured database row uses row fields, decrypts the secret and ignores env', () => {
  const calls: string[] = []
  const config = expectS3(resolveStorageConfig({
    row: usableS3Row,
    decryptSecret: decrypter(calls),
    env: { S3_BUCKET: 'env-bucket', S3_SECRET_ACCESS_KEY: 'env-secret', S3_REGION: 'ap-east-1' },
  }))
  assert.deepEqual(calls, ['cipher-v1'])
  assert.equal(config.configured, true)
  assert.equal(config.source, 'database')
  assert.equal(config.endpoint, 'https://storage.internal.example')
  assert.equal(config.publicEndpoint, 'https://media.example')
  assert.equal(config.region, 'eu-central-1')
  assert.equal(config.bucket, 'musecanvas')
  assert.equal(config.accessKeyId, 'AKID')
  assert.equal(config.secretAccessKey, 'plain-of-cipher-v1')
  assert.equal(config.signedUrlTtlSeconds, 1200)
  assert.equal(config.forcePathStyle, true)
  assert.equal(config.revision, 7)
})

test('s3 from the environment when there is no row', () => {
  const config = expectS3(resolveStorageConfig({
    row: null,
    decryptSecret: failingDecrypter(),
    env: {
      S3_ENDPOINT: 'https://s3.env.example',
      S3_PUBLIC_ENDPOINT: 'https://cdn.env.example',
      S3_REGION: 'us-west-2',
      S3_BUCKET: 'env-bucket',
      S3_ACCESS_KEY_ID: 'env-key',
      S3_SECRET_ACCESS_KEY: 'env-secret',
      S3_SIGNED_URL_TTL: '600',
    },
  }))
  assert.equal(config.configured, true)
  assert.equal(config.source, 'environment')
  assert.equal(config.endpoint, 'https://s3.env.example')
  assert.equal(config.publicEndpoint, 'https://cdn.env.example')
  assert.equal(config.region, 'us-west-2')
  assert.equal(config.bucket, 'env-bucket')
  assert.equal(config.accessKeyId, 'env-key')
  assert.equal(config.secretAccessKey, 'env-secret')
  assert.equal(config.signedUrlTtlSeconds, 600)
  assert.equal(config.revision, 0)
})

test('a row that is not configured is ignored in favour of the environment, without decrypting it', () => {
  const calls: string[] = []
  const config = expectS3(resolveStorageConfig({
    row: row({ status: 'not_configured', bucket: 'stale-bucket', access_key_id: 'stale', secret_encrypted: 'cipher-old' }),
    decryptSecret: decrypter(calls),
    env: { S3_ENDPOINT: 'https://s3.env.example', S3_BUCKET: 'env-bucket', S3_ACCESS_KEY_ID: 'env-key', S3_SECRET_ACCESS_KEY: 'env-secret' },
  }))
  assert.deepEqual(calls, [])
  assert.equal(config.source, 'environment')
  assert.equal(config.bucket, 'env-bucket')
  assert.equal(config.secretAccessKey, 'env-secret')
})

test('an error status row is also ignored in favour of the environment', () => {
  const config = expectS3(resolveStorageConfig({
    row: row({ status: 'error', bucket: 'broken', secret_encrypted: 'cipher' }),
    decryptSecret: failingDecrypter(),
    env: { S3_ENDPOINT: 'https://s3.env.example', S3_BUCKET: 'env-bucket', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' },
  }))
  assert.equal(config.source, 'environment')
  assert.equal(config.bucket, 'env-bucket')
})

test('a usable row whose secret cannot be decrypted fails closed and never uses the env secret', () => {
  assert.throws(
    () => resolveStorageConfig({
      row: usableS3Row,
      decryptSecret: failingDecrypter(),
      env: { S3_ENDPOINT: 'https://s3.env.example', S3_BUCKET: 'env-bucket', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 'env-secret' },
    }),
    (error: unknown) => {
      assert.ok(isStorageConfigError(error))
      assert.ok(error instanceof StorageConfigError)
      assert.equal(error.code, 'INVALID_CONFIG')
      assert.equal(error.message, 'INVALID_CONFIG')
      assert.doesNotMatch(error.reason, /env-secret|cipher|wrong key/)
      return true
    },
  )
})

test('endpoint falls back to publicEndpoint and publicEndpoint falls back to endpoint', () => {
  const onlyEndpoint = expectS3(resolveStorageConfig({
    row: row({ status: 'configured', endpoint: 'https://only.example', public_endpoint: null, bucket: 'b', access_key_id: 'k', secret_encrypted: 'c' }),
    decryptSecret: decrypter(),
    env: {},
  }))
  assert.equal(onlyEndpoint.endpoint, 'https://only.example')
  assert.equal(onlyEndpoint.publicEndpoint, 'https://only.example')

  const onlyPublic = expectS3(resolveStorageConfig({
    row: row({ status: 'configured', endpoint: null, public_endpoint: 'https://public.example', bucket: 'b', access_key_id: 'k', secret_encrypted: 'c' }),
    decryptSecret: decrypter(),
    env: {},
  }))
  assert.equal(onlyPublic.endpoint, 'https://public.example')
  assert.equal(onlyPublic.publicEndpoint, 'https://public.example')

  const envOnlyPublic = expectS3(resolveStorageConfig({
    row: null,
    decryptSecret: failingDecrypter(),
    env: { S3_PUBLIC_ENDPOINT: 'https://env-public.example', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' },
  }))
  assert.equal(envOnlyPublic.endpoint, 'https://env-public.example')
  assert.equal(envOnlyPublic.configured, true)
})

test('incomplete s3 configuration is reported as not configured instead of throwing', () => {
  const config = expectS3(resolveStorageConfig({
    row: row({ status: 'verified', endpoint: 'https://s3.example', bucket: null, access_key_id: 'k', secret_encrypted: 'c' }),
    decryptSecret: decrypter(),
    env: {},
  }))
  assert.equal(config.configured, false)
  assert.equal(config.bucket, null)
  assert.equal(config.endpoint, 'https://s3.example')
})

test('local driver from a configured row uses the validated root', () => {
  const config = expectLocal(resolveStorageConfig({
    row: row({ status: 'verified', storage_driver: 'local', local_root: '/srv/musecanvas/media', revision: 4, signed_url_ttl_seconds: 300 }),
    decryptSecret: failingDecrypter(),
    env: { S3_BUCKET: 'ignored' },
  }))
  assert.equal(config.configured, true)
  assert.equal(config.source, 'database')
  assert.equal(config.root, '/srv/musecanvas/media')
  assert.equal(config.signedUrlTtlSeconds, 300)
  assert.equal(config.revision, 4)
})

test('local driver accepts a Windows drive absolute root', () => {
  const config = expectLocal(resolveStorageConfig({
    row: row({ status: 'configured', storage_driver: 'local', local_root: 'D:\\media\\store' }),
    decryptSecret: failingDecrypter(),
    env: {},
  }))
  assert.equal(config.root, 'D:\\media\\store')
})

test('local driver from the environment via STORAGE_DRIVER and STORAGE_LOCAL_ROOT', () => {
  const config = expectLocal(resolveStorageConfig({
    row: null,
    decryptSecret: failingDecrypter(),
    env: { STORAGE_DRIVER: 'local', STORAGE_LOCAL_ROOT: '  /data/uploads  ', GENERATION_UPLOAD_SIGN_TTL_SECONDS: '120' },
  }))
  assert.equal(config.source, 'environment')
  assert.equal(config.root, '/data/uploads')
  assert.equal(config.signedUrlTtlSeconds, 120)
  assert.equal(config.revision, 0)
})

test('local roots that are relative, contain ".." or are too long are rejected', () => {
  const rejected = [
    'media/store',
    './media',
    '',
    '/srv/../etc',
    '/srv/media/..',
    'C:\\data\\..\\secrets',
    'C:/data/../secrets',
    `/${'a'.repeat(512)}`,
    '/has\u0000nul',
  ]
  for (const root of rejected) {
    assert.throws(
      () => resolveStorageConfig({
        row: row({ status: 'configured', storage_driver: 'local', local_root: root }),
        decryptSecret: failingDecrypter(),
        env: {},
      }),
      (error: unknown) => isStorageConfigError(error) && error.code === 'INVALID_CONFIG',
      `expected rejection for ${JSON.stringify(root.slice(0, 40))}`,
    )
  }
})

test('a local driver with no root is an INVALID_CONFIG error in both sources', () => {
  assert.throws(
    () => resolveStorageConfig({
      row: row({ status: 'configured', storage_driver: 'local', local_root: null }),
      decryptSecret: failingDecrypter(),
      env: {},
    }),
    (error: unknown) => isStorageConfigError(error) && error.reason === 'local storage root is not configured',
  )
  assert.throws(
    () => resolveStorageConfig({ row: null, decryptSecret: failingDecrypter(), env: { STORAGE_DRIVER: 'local' } }),
    (error: unknown) => isStorageConfigError(error),
  )
})

test('unknown storage driver values are rejected', () => {
  assert.throws(
    () => resolveStorageConfig({ row: null, decryptSecret: failingDecrypter(), env: { STORAGE_DRIVER: 'ftp' } }),
    (error: unknown) => isStorageConfigError(error),
  )
  assert.throws(
    () => resolveStorageConfig({
      row: row({ status: 'verified', storage_driver: 'gcs' as never }),
      decryptSecret: failingDecrypter(),
      env: {},
    }),
    (error: unknown) => isStorageConfigError(error),
  )
})

test('signed URL TTL is clamped to 60..3600 and non-numeric input yields the default', () => {
  const ttl = (raw: unknown) => expectS3(resolveStorageConfig({
    row: row({ status: 'verified', signed_url_ttl_seconds: raw as number, bucket: 'b', access_key_id: 'k', secret_encrypted: 'c', endpoint: 'https://s' }),
    decryptSecret: decrypter(),
    env: {},
  })).signedUrlTtlSeconds
  assert.equal(ttl(10), 60)
  assert.equal(ttl(60), 60)
  assert.equal(ttl(3600), 3600)
  assert.equal(ttl(99999), 3600)
  assert.equal(ttl(Number.NaN), 900)

  const envTtl = (env: Record<string, string>) => expectS3(resolveStorageConfig({
    row: null,
    decryptSecret: failingDecrypter(),
    env,
  })).signedUrlTtlSeconds
  assert.equal(envTtl({ S3_SIGNED_URL_TTL: '5' }), 60)
  assert.equal(envTtl({ S3_SIGNED_URL_TTL: '7200' }), 3600)
  assert.equal(envTtl({ S3_SIGNED_URL_TTL: 'soon' }), 900)
  assert.equal(envTtl({}), 900)
  // S3_SIGNED_URL_TTL wins over the worker's legacy name when both are set.
  assert.equal(envTtl({ S3_SIGNED_URL_TTL: '300', GENERATION_UPLOAD_SIGN_TTL_SECONDS: '200' }), 300)
  assert.equal(envTtl({ GENERATION_UPLOAD_SIGN_TTL_SECONDS: '200' }), 200)
})

test('blank environment values count as unset', () => {
  const config = expectS3(resolveStorageConfig({
    row: null,
    decryptSecret: failingDecrypter(),
    env: { S3_ENDPOINT: '   ', S3_PUBLIC_ENDPOINT: 'https://p.example', S3_BUCKET: '', S3_REGION: '' },
  }))
  assert.equal(config.endpoint, 'https://p.example')
  assert.equal(config.bucket, null)
  assert.equal(config.region, 'us-east-1')
  assert.equal(config.configured, false)
})
