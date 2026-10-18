import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mock, test } from 'node:test'
import { S3Client } from '@aws-sdk/client-s3'
import { db } from '@musecanvas/database'
import { createAssetSigner, putReservedImageMask } from './services'
import { invalidateRuntimeSettings } from '../modules/settings/runtime'

test('request-local signer loads settings once and retains only its own configuration snapshot', async () => {
  const saved = process.env.S3_PUBLIC_ENDPOINT
  const query = mock.method(db(), 'query', async (sql: string) => ({ rows: sql.includes('SELECT config_revision') ? [{ config_revision: 1 }] : [] }))
  invalidateRuntimeSettings()
  process.env.S3_PUBLIC_ENDPOINT = 'https://old.example.invalid'
  const explicit = { bucket: 'synthetic', region: 'synthetic', accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }
  try {
    const first = createAssetSigner(explicit)
    assert.equal(query.mock.callCount(), 0, 'an unused signer performs no work')
    const urls = await Promise.all(Array.from({ length: 30 }, (_, index) => first(`object-${index}`)))
    assert.equal(query.mock.callCount(), 5)
    assert.ok(urls.every(url => new URL(url).hostname === 'old.example.invalid'))
    process.env.S3_PUBLIC_ENDPOINT = 'https://new.example.invalid'
    invalidateRuntimeSettings()
    assert.equal(new URL(await first('same-request')).hostname, 'old.example.invalid')
    assert.equal(new URL(await createAssetSigner(explicit)('next-request')).hostname, 'new.example.invalid')
    assert.equal(query.mock.callCount(), 10)
  } finally {
    query.mock.restore(); invalidateRuntimeSettings()
    if (saved === undefined) delete process.env.S3_PUBLIC_ENDPOINT
    else process.env.S3_PUBLIC_ENDPOINT = saved
  }
})

test('reserved mask SDK request sends If-None-Match star to a local fake S3 only', async () => {
  let conditional: string | undefined
  const server = createServer((request, response) => { conditional = request.headers['if-none-match'] as string; request.resume(); response.statusCode = 200; response.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const client = new S3Client({ endpoint: `http://127.0.0.1:${address.port}`, region: 'synthetic', forcePathStyle: true, credentials: { accessKeyId: 'synthetic-fixture', secretAccessKey: 'synthetic-fixture' }, maxAttempts: 1 })
  try {
    await putReservedImageMask('reserved.png', Buffer.from('synthetic mask'), { bucket: 'fixture', put: command => client.send(command), read: async () => assert.fail('no conflict') })
    assert.equal(conditional, '*')
  } finally { client.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test('reserved mask accepts only409/412 identical bytes, refuses mismatches and never retries or deletes', async () => {
  const bytes = Buffer.from('synthetic mask')
  for (const status of [409, 412]) {
    let writes = 0, reads = 0
    const ports = { bucket: 'fixture', put: async (command: any) => { writes++; assert.equal(command.input.IfNoneMatch, '*'); throw { $metadata: { httpStatusCode: status } } }, read: async (limit: number) => { reads++; assert.ok(limit >= bytes.length); return bytes } }
    await putReservedImageMask('reserved.png', bytes, ports)
    assert.equal(writes, 1); assert.equal(reads, 1)
    await assert.rejects(putReservedImageMask('reserved.png', bytes, { ...ports, read: async () => Buffer.from('different mask') }), /PREPARATION_ARTIFACT_CONFLICT/)
  }
  let reads = 0
  for (const status of [400, 403, 501]) await assert.rejects(putReservedImageMask('reserved.png', bytes, { bucket: 'fixture', put: async () => { throw { $metadata: { httpStatusCode: status } } }, read: async () => { reads++; return bytes } }))
  assert.equal(reads, 0)
})
