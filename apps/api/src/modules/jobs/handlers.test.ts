import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { db } from '@musecanvas/database'
import { NextRequest } from 'next/server'
import type { AuthedContext } from '../../router/types'
import { getJob, listJobs } from './handlers'

const actorId = '00000000-0000-4000-8000-000000000001'
const context = (id = 'job-1'): AuthedContext => ({
  actor: { id: actorId, email: 'test@example.invalid', role: 'user', status: 'active', createdAt: '' },
  params: { id }, path: 'jobs', request: new NextRequest('http://localhost/api/jobs'), json: async () => ({}),
})
const job = (id: string) => ({ id, created_by: actorId, prompt: id, status: 'succeeded', created_at: '2026-10-18T00:00:00Z' })
type Row = Record<string, unknown>

function harness(jobs: Row[], outputs: Row[] = [], inputs: Row[] = []) {
  const calls: { sql: string; params: unknown[] }[] = []
  const mocked = mock.method(db(), 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (sql.includes('FROM generation_jobs j')) {
      assert.match(sql, /j\.created_by=\$[12] AND j\.deleted_at IS NULL/)
      if (sql.includes('LIMIT 50')) {
        assert.match(sql, /ORDER BY j\.created_at DESC LIMIT 50/)
        assert.deepEqual(params, [actorId])
        return { rows: jobs, rowCount: jobs.length }
      }
      assert.deepEqual(params, ['job-1', actorId])
      return { rows: jobs.filter(row => row.id === params[0]), rowCount: 1 }
    }
    if (sql.includes('FROM generation_job_inputs gji')) {
      assert.match(sql, /gji\.job_id = ANY\(\$1\)/)
      return { rows: inputs.filter(row => (params[0] as string[]).includes(row.job_id as string)) }
    }
    if (sql.includes('FROM generation_outputs go')) {
      assert.match(sql, /JOIN assets a ON a\.id=go\.asset_id/)
      assert.match(sql, /a\.deleted_at IS NULL/)
      const ids = Array.isArray(params[0]) ? params[0] : [params[0]]
      return { rows: outputs.filter(row => ids.includes(row.job_id) && !row.deleted_at) }
    }
    throw new Error(`Unexpected query: ${sql}`)
  })
  return { calls, restore: () => mocked.mock.restore() }
}

async function data(response: Response) {
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.success, true)
  return body.data
}

test('listJobs loads fifty jobs in three queries, independent of job count', async () => {
  // Empty output/input rows isolate repository reads from storage signing queries.
  const jobs = Array.from({ length: 50 }, (_, index) => job(`job-${index}`))
  const h = harness(jobs)
  try {
    const page = await data(await listJobs(context()))
    assert.equal(page.items.length, 50)
    assert.deepEqual(page.items.map((item: Row) => item.id), jobs.map(row => row.id))
    assert.ok(page.items.every((item: Row) => Array.isArray(item.outputs) && item.outputs.length === 0))
    assert.equal(page.total, 50)
    assert.equal(page.hasMore, false)
    assert.equal(h.calls.length, 3)
    const outputReads = h.calls.filter(call => call.sql.includes('FROM generation_outputs go'))
    assert.equal(outputReads.length, 1)
    assert.match(outputReads[0].sql, /go\.job_id=ANY\(\$1\)/)
    assert.deepEqual(outputReads[0].params, [jobs.map(row => row.id)])
  } finally { h.restore() }
})

test('listJobs groups interleaved outputs and inputs without changing job order or deleted-asset filtering', async () => {
  // Presigned fixture URLs keep this handler test independent of S3 configuration.
  const output = (jobId: string, id: string, extra: Row = {}) => ({
    job_id: jobId, asset_id: id, signed_url: `https://example.invalid/${id}`, mime_type: 'image/png', ...extra,
  })
  const outputs = [
    output('job-2', 'video-1', { media_kind: 'video', duration_seconds: '2.5', width: 1280, has_audio: true }),
    output('job-1', 'image-1'), output('job-2', 'image-2'),
    output('job-1', 'deleted', { deleted_at: '2026-10-18' }), output('unrelated', 'private'),
  ]
  const h = harness([job('job-2'), job('job-1'), job('job-3')], outputs, [
    { job_id: 'job-1', id: 'input-1', position: 0, source: 'upload' },
  ])
  try {
    const page = await data(await listJobs(context()))
    assert.deepEqual(page.items.map((item: Row) => item.id), ['job-2', 'job-1', 'job-3'])
    assert.deepEqual(page.items.map((item: { outputs: Row[] }) => item.outputs.map(row => row.assetId)), [
      ['video-1', 'image-2'], ['image-1'], [],
    ])
    assert.equal(page.items[0].outputs[0].mediaKind, 'video')
    assert.equal(page.items[0].outputs[0].metadata.durationSeconds, 2.5)
    assert.equal(page.items[0].outputs[0].metadata.hasAudio, true)
    assert.equal(page.items[1].outputs[0].imageUrl, 'https://example.invalid/image-1')
    assert.deepEqual(page.items.map((item: { inputs: Row[] }) => item.inputs.map(row => row.id)), [[], ['input-1'], []])
    assert.equal(page.total, 3)
    assert.equal(page.hasMore, false)
  } finally { h.restore() }
})

test('listJobs returns an empty page without querying inputs or outputs', async () => {
  const h = harness([])
  try {
    assert.deepEqual(await data(await listJobs(context())), { items: [], total: 0, hasMore: false })
    assert.equal(h.calls.length, 1)
  } finally { h.restore() }
})

test('getJob retains its single-job output query and response shape', async () => {
  const h = harness([job('job-1')], [{ job_id: 'job-1', asset_id: 'image-1', signed_url: 'https://example.invalid/image-1' }])
  try {
    const item = await data(await getJob(context()))
    assert.equal(item.id, 'job-1')
    assert.deepEqual(item.outputs.map((output: Row) => output.assetId), ['image-1'])
    const outputRead = h.calls.find(call => call.sql.includes('FROM generation_outputs go'))!
    assert.match(outputRead.sql, /go\.job_id=\$1/)
    assert.deepEqual(outputRead.params, ['job-1'])
  } finally { h.restore() }
})

test('listJobs propagates an output query failure instead of returning incomplete jobs', async () => {
  const error = new Error('OUTPUT_READ_FAILED')
  const mocked = mock.method(db(), 'query', async (sql: string) => {
    if (sql.includes('FROM generation_jobs j')) return { rows: [job('job-1')], rowCount: 1 }
    if (sql.includes('FROM generation_job_inputs gji')) return { rows: [] }
    throw error
  })
  try {
    await assert.rejects(listJobs(context()), error)
  } finally { mocked.mock.restore() }
})

test('getJob returns 404 before loading inputs or outputs for an unavailable job', async () => {
  const h = harness([])
  try {
    const response = await getJob(context())
    assert.equal(response.status, 404)
    const body = await response.json()
    assert.equal(body.success, false)
    assert.equal(body.error.code, 'NOT_FOUND')
    assert.equal(h.calls.length, 1)
  } finally { h.restore() }
})
