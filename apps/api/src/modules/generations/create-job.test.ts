import assert from 'node:assert/strict'
import test from 'node:test'
import type pg from 'pg'
import type { Actor } from '../../auth/security'
import { createGenerationJob, type GenerationJobPorts, type CreateGenerationJobCommand } from './create-job'

const modelId = '11111111-1111-4111-8111-111111111111'
const ownerId = '22222222-2222-4222-8222-222222222222'
const capabilities = {
  modes: ['text_to_image'], supportedMediaKinds: ['image'], declaredBy: 'plugin-manifest', maxCount: 1,
  parameters: [{ name: 'size', type: 'enum', options: ['1024x1024'], defaultValue: '1024x1024' }], inputSlots: [],
}
const model = { id: modelId, model_kind: 'image', capabilities, defaults: {}, revision_capabilities: capabilities, revision_defaults: {} }
const command = (overrides: Partial<CreateGenerationJobCommand> = {}): CreateGenerationJobCommand => ({
  actor: { id: ownerId, role: 'user' } as Actor, modelId, prompt: 'draw', parameters: {}, normalizedInputs: [], idempotencyKey: 'key', ...overrides,
})

function fixture(options: { existing?: boolean; conflict?: boolean; failure?: boolean } = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = []
  const dtoRows: Record<string, unknown>[] = []
  const row = { id: 'job-1', model_id: modelId, media_kind: 'image', status: 'queued', normalized_request: {
    modelId, prompt: options.conflict ? 'other' : 'draw', parameters: { size: '1024x1024' }, inputs: [], mode: 'text_to_image',
  } }
  const query = async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params })
    if (options.failure && sql.includes('INSERT INTO outbox_events')) throw new Error('private SQL message')
    if (sql.includes('FROM model_configs')) return { rows: [model], rowCount: 1 }
    if (sql.includes('SELECT * FROM generation_jobs')) return { rows: options.existing ? [row] : [], rowCount: options.existing ? 1 : 0 }
    if (sql.includes('INSERT INTO generation_jobs') || sql.includes('FROM generation_jobs j')) return { rows: [row], rowCount: 1 }
    if (sql.includes('prompt_optimization_settings')) return { rows: [{ enabled: false }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }
  const client = { query } as unknown as pg.PoolClient
  const ports: GenerationJobPorts = {
    database: () => ({ query }) as unknown as pg.Pool,
    runTransaction: async fn => {
      await query('BEGIN')
      try { const result = await fn(client); await query('COMMIT'); return result }
      catch (error) { await query('ROLLBACK'); throw error }
    },
    runtimeLimits: async () => ({ maxImageBytes: 10_000_000, maxTotalBytes: 20_000_000, maxInputs: 4 }),
    jobDto: async row => { dtoRows.push(row); return { id: row.id, status: row.status } as unknown as Awaited<ReturnType<GenerationJobPorts['jobDto']>> },
  }
  return { ports, statements, dtoRows }
}

test('generation HTTP adapter preserves injected projection/DTO and 202 envelope', async () => {
  const f = fixture()
  const response = await createGenerationJob(command(), f.ports)
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { success: true, data: { id: 'job-1', status: 'queued' } })
  assert.equal(f.dtoRows.length, 1)
  const projection = f.statements.find(s => s.sql.includes('FROM generation_jobs j'))!
  assert.deepEqual(projection.params, ['job-1', ownerId])
  assert.equal(f.statements.filter(s => s.sql === 'BEGIN').length, 1)
  assert.equal(f.statements.filter(s => s.sql.includes('INSERT INTO outbox_events')).length, 1)
})

test('HTTP replay is 202 with no inserts; changed request keeps 409 conflict', async () => {
  const replay = fixture({ existing: true })
  assert.equal((await createGenerationJob(command(), replay.ports)).status, 202)
  assert.ok(!replay.statements.some(s => s.sql.includes('INSERT INTO')))
  const conflict = fixture({ existing: true, conflict: true })
  const response = await createGenerationJob(command(), conflict.ports)
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'IDEMPOTENCY_CONFLICT')
  assert.ok(conflict.statements.some(s => s.sql === 'ROLLBACK'))
})

test('HTTP validation forwards parameter error details without opening a transaction', async () => {
  const f = fixture()
  const response = await createGenerationJob(command({ parameters: { size: 'invalid' } }), f.ports)
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.success, false)
  assert.equal(body.error.details.parameter, 'size')
  assert.ok(!f.statements.some(s => s.sql === 'BEGIN'))
})

test('HTTP persistence failure maps only after rollback and keeps SQL details private', async () => {
  const f = fixture({ failure: true })
  const response = await createGenerationJob(command(), f.ports)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { success: false, error: { code: 'GENERATION_CREATE_FAILED', message: '创建生成任务失败' } })
  assert.equal(f.statements.at(-1)!.sql, 'ROLLBACK')
  assert.equal(f.dtoRows.length, 0)
})
