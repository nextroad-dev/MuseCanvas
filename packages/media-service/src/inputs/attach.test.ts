import assert from 'node:assert/strict'
import test from 'node:test'
import { attachGenerationInputs, GenerationInputError } from './attach'
import type { SqlClient } from '../ports'

const legacyId = '11111111-1111-4111-8111-111111111111'
const genericId = '22222222-2222-4222-8222-222222222222'
const ready = (id: string) => ({ id, status: 'ready', deleted_at: null, attached_job_id: null, expires_at: '2099-01-01', size_bytes: 10, media_kind: 'image' })

test('missing generic rows fall back to owner-scoped legacy rows without an invalid upload foreign key', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const client: SqlClient = { query: async (sql, params = []) => {
    queries.push({ sql, params })
    if (sql.includes('FROM media_uploads')) return { rows: [ready(genericId)] }
    if (sql.includes('FROM generation_input_images')) return { rows: [ready(legacyId)] }
    return { rows: [] }
  } }
  await attachGenerationInputs(client, 'owner', 'job', [
    { uploadId: legacyId, role: 'reference_image', position: 0 },
    { uploadId: genericId, role: 'mask', position: 1 },
  ])
  const fallback = queries.find(s => s.sql.includes('FROM generation_input_images'))!
  assert.deepEqual(fallback.params, [[legacyId], 'owner'])
  assert.match(fallback.sql, /created_by = \$2[\s\S]*FOR UPDATE/)
  const links = queries.filter(s => s.sql.includes('INSERT INTO generation_job_inputs'))
  assert.deepEqual(links.map(s => s.params), [
    ['job', legacyId, null, 0, 'reference_image'],
    ['job', genericId, genericId, 1, 'mask'],
  ])
  assert.equal(queries.filter(s => s.sql.includes('UPDATE media_uploads')).length, 1)
})

test('SQL read or attach failures stop immediately rather than falling back in an aborted transaction', async () => {
  for (const failAt of ['FROM media_uploads', 'UPDATE media_uploads']) {
    const queries: string[] = []
    const failure = Object.assign(new Error('synthetic SQL failure'), { code: '42P01' })
    const client: SqlClient = { query: async sql => {
      queries.push(sql)
      if (sql.includes(failAt)) throw failure
      if (sql.includes('FROM media_uploads')) return { rows: [ready(genericId)] }
      return { rows: [] }
    } }
    await assert.rejects(attachGenerationInputs(client, 'owner', 'job', [{ uploadId: genericId, role: 'reference_image', position: 0 }]), error => error === failure)
    assert.ok(queries.at(-1)!.includes(failAt))
    assert.ok(!queries.some(s => s.includes('FROM generation_input_images')))
  }
})

test('mixed legacy upload and reusable asset share the pooled byte ceiling', async () => {
  const sql: string[] = []
  const client: SqlClient = { query: async text => {
    sql.push(text)
    if (text.includes('FROM media_uploads')) return { rows: [] }
    if (text.includes('FROM generation_input_images')) return { rows: [ready(legacyId)] }
    if (text.includes('FROM assets')) return { rows: [{ id: genericId, media_kind: 'image', mime_type: 'image/png', width: 1024, height: 1024, size_bytes: 10, deleted_at: null }] }
    return { rows: [] }
  } }
  await assert.rejects(attachGenerationInputs(client, 'owner', 'job', [
    { uploadId: legacyId, role: 'reference_image', position: 0 },
    { assetId: genericId, role: 'reference_image', position: 1 },
  ], { maxTotalBytes: 19 }), error => error instanceof GenerationInputError && error.code === 'INVALID_INPUT_IMAGE_SIZE')
  assert.ok(!sql.some(s => s.includes('UPDATE assets')))
})
