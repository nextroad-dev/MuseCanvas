import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { db } from '@musecanvas/database'
import { jobDto } from './dto'
import { invalidateRuntimeSettings, resolveStorageSettings } from '../modules/settings/runtime'

const job = { id: 'job-fixture', created_at: new Date('2026-10-18T00:00:00Z') }

test('job input aliases share one signature without per-input revision queries on a warm cache', async () => {
  const environment = {
    S3_ENDPOINT: 'https://storage.example.invalid',
    S3_PUBLIC_ENDPOINT: 'https://media.example.invalid',
    S3_REGION: 'fixture',
    S3_BUCKET: 'fixture',
    S3_ACCESS_KEY_ID: 'fixture-access-key',
    S3_SECRET_ACCESS_KEY: 'fixture-secret-key',
  }
  const saved = new Map(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  let revisionQueries = 0
  const query = mock.method(db(), 'query', async (sql: string) => {
    if (sql.includes('SELECT config_revision')) {
      revisionQueries++
      return { rows: [{ config_revision: 1 }] }
    }
    return { rows: [] }
  })
  invalidateRuntimeSettings()
  try {
    // Warm the existing settings cache so the counter isolates signature work.
    await resolveStorageSettings()
    revisionQueries = 0
    const inputs = [
      { id: 'upload', object_key: 'private/upload.png', mime_type: 'image/png', width: 120, height: 80, size_bytes: 42, position: 0 },
      { id: 'asset', asset_id: 'asset', object_key: 'private/asset.png', mime_type: 'image/png', width: 60, height: 40, size_bytes: 21, position: 1 },
    ]
    const result = await jobDto(job, [], inputs)
    assert.equal(revisionQueries, 0, 'request-local signing reuses the warm configuration snapshot')
    assert.equal(result.inputs.length, 2)
    for (const [index, input] of result.inputs.entries()) {
      assert.equal(input.imageUrl, input.url)
      assert.equal(input.imageUrl, result.inputImages[index]!.imageUrl)
      const signed = new URL(input.imageUrl)
      assert.equal(signed.hostname, 'media.example.invalid')
      assert.equal(signed.pathname, `/fixture/${inputs[index]!.object_key}`)
      assert.ok(signed.searchParams.has('X-Amz-Signature'))
      assert.equal(input.width, inputs[index]!.width)
      assert.equal(result.inputImages[index]!.sizeBytes, inputs[index]!.size_bytes)
    }
    assert.equal(result.inputs[0]!.uploadId, 'upload')
    assert.equal(result.inputs[1]!.assetId, 'asset')
    assert.equal(result.inputs[1]!.uploadId, undefined)
    assert.equal(result.inputs[1]!.source, 'gallery')
  } finally {
    query.mock.restore()
    invalidateRuntimeSettings()
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('pre-signed and missing input URLs preserve compatibility without database access', async () => {
  const query = mock.method(db(), 'query', async () => assert.fail('no storage lookup is needed'))
  try {
    const result = await jobDto({ ...job, input_images: [
      { id: 'signed', imageUrl: 'https://media.example.invalid/existing', object_key: 'unused', mimeType: 'image/png', sizeBytes: 12 },
      { id: 'empty' },
    ] })
    assert.deepEqual(result.inputs.map(input => input.imageUrl), ['https://media.example.invalid/existing', ''])
    assert.deepEqual(result.inputs.map(input => input.url), result.inputImages.map(input => input.imageUrl))
    assert.equal(result.inputImages[0]!.mimeType, 'image/png')
    assert.equal(result.inputImages[0]!.sizeBytes, 12)
    assert.equal(query.mock.callCount(), 0)
  } finally {
    query.mock.restore()
  }
})
