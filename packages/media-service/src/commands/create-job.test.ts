import assert from 'node:assert/strict'
import test from 'node:test'
import type pg from 'pg'
import { RUNTIME_SETTINGS_DEFAULTS, type ModelCapabilities } from '@musecanvas/contracts'
import {
  prepareGeneration, createGenerationInTransaction,
  type CreateGenerationCommand,
} from './create-job'
import { MediaServiceError, generationCommandError } from '../errors'

const ownerId = '11111111-1111-4111-8111-111111111111'
const modelId = '22222222-2222-4222-8222-222222222222'
const uploadId = '33333333-3333-4333-8333-333333333333'
const capabilities: ModelCapabilities = {
  modes: ['text_to_image', 'image_to_image'], supportedMediaKinds: ['image'], declaredBy: 'plugin-manifest', maxCount: 2,
  parameters: [
    { name: 'size', type: 'enum', options: ['1024x1024', '1536x1024'], defaultValue: '1024x1024' },
    { name: 'count', type: 'integer', min: 1, max: 2, defaultValue: 1 },
  ],
  inputSlots: [{ role: 'reference_image', required: false, minCount: 0, maxCount: 4, allowedMediaKinds: ['image'] }],
}
const model = { id: modelId, model_kind: 'image', capabilities, defaults: {}, revision_id: 'revision-3', revision_capabilities: capabilities, revision_defaults: {}, plugin_id: 'synthetic', plugin_version: '1.0.0' }
const command = (overrides: Partial<CreateGenerationCommand> = {}): CreateGenerationCommand => ({ ownerId, modelId, prompt: ' draw ', parameters: { count: 1 }, normalizedInputs: [], idempotencyKey: 'request-key', ...overrides })

function fixture(options: { lockedModel?: Record<string, unknown>; failAt?: string; optimization?: boolean; missingCredential?: boolean; missingPromptCredential?: boolean; upload?: Record<string, unknown>; race?: boolean } = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = []
  let existing: Record<string, unknown> | undefined
  let staged: Record<string, unknown> | undefined
  let committed: Record<string, unknown> | undefined
  const sqlFailure = new Error('synthetic persistence failure')
  const query = async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params })
    const result = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length })
    if (options.failAt && sql.includes(options.failAt)) throw sqlFailure
    if (sql === 'BEGIN') return result()
    if (sql === 'COMMIT') { committed = staged; return result() }
    if (sql === 'ROLLBACK') { staged = undefined; return result() }
    if (sql.includes('SELECT * FROM generation_jobs')) return result(existing ? [existing] : [])
    if (sql.includes('FROM model_configs')) return result([options.lockedModel ?? model])
    if (sql.includes('SELECT * FROM prompt_optimization_settings')) return result([{ enabled: options.optimization ?? false }])
    if (sql.includes('SELECT s.*,m.display_name')) return result(options.missingPromptCredential ? [] : [{ enabled: true, language_model_config_id: 'language-model', language_protocol: 'openai', credential_id: 'prompt-credential', credential_enabled: true, api_key_encrypted: 'synthetic-placeholder' }])
    if (sql.includes('FROM provider_credentials')) return result(options.missingCredential ? [] : [{ id: 'credential', enabled: true, api_key_encrypted: 'synthetic-placeholder' }])
    if (sql.includes('INSERT INTO generation_jobs')) {
      staged = { id: 'job-1', created_by: params[0], model_id: params[1], media_kind: params[16], normalized_request: JSON.parse(String(params[21])) }
      if (options.race) { existing = staged; return result() }
      return result([staged])
    }
    if (sql.includes('FROM media_uploads')) return result(options.upload ? [options.upload] : [])
    if (sql.includes('FROM generation_input_images')) return result()
    if (sql.includes('INSERT INTO prompt_optimizations')) return result([{ id: 'optimization-1' }])
    return result()
  }
  const client = { query } as unknown as pg.PoolClient
  const prepare = (cmd = command()) => prepareGeneration(cmd, { database: () => ({ query: async () => ({ rows: [model] }) }), runtimeLimits: async () => RUNTIME_SETTINGS_DEFAULTS })
  return { statements, sqlFailure, client, prepare, replay: () => { existing = staged }, committed: () => committed }
}

const errorCode = (code: string) => (error: unknown) => error instanceof MediaServiceError && error.code === code

test('non-HTTP caller fences, reserves, creates and links on its own single transaction', async () => {
  const f = fixture({ optimization: true, lockedModel: { ...model, provider_credential_id: 'credential' } })
  const prepared = await f.prepare()
  await f.client.query('BEGIN')
  await f.client.query('caller fencing and budget reservation')
  const created = await createGenerationInTransaction(f.client, prepared)
  assert.equal(created.jobId, 'job-1')
  assert.equal(created.replayed, false)
  assert.equal('status' in created, false)
  await f.client.query('caller tool-job link', [created.jobId])
  assert.equal(f.committed(), undefined)
  await f.client.query('COMMIT')
  assert.equal(f.committed()?.id, created.jobId)
  const sql = f.statements.map(s => s.sql)
  assert.deepEqual(sql.filter(s => /^(BEGIN|COMMIT|ROLLBACK)$/.test(s)), ['BEGIN', 'COMMIT'])
  assert.ok(sql.findIndex(s => s.includes('INSERT INTO generation_jobs')) < sql.findIndex(s => s.includes('INSERT INTO prompt_optimizations')))
  assert.ok(sql.findIndex(s => s.includes('INSERT INTO outbox_events')) < sql.indexOf('caller tool-job link'))
  const insert = f.statements.find(s => s.sql.includes('INSERT INTO generation_jobs'))!
  assert.equal(insert.params[0], ownerId)
  assert.equal(insert.params[17], 'revision-3')
  assert.equal(insert.params[6], 'draw')
  assert.match(String(insert.params[22]), /^[a-f0-9]{64}$/)
})

test('owner-scoped idempotent replay returns the same job without writes; conflicts are typed', async () => {
  const f = fixture()
  const prepared = await f.prepare()
  await createGenerationInTransaction(f.client, prepared)
  f.replay()
  f.statements.length = 0
  const replay = await createGenerationInTransaction(f.client, prepared)
  assert.equal(replay.jobId, 'job-1')
  assert.equal(replay.replayed, true)
  assert.equal(f.statements.length, 1)
  assert.deepEqual(f.statements[0].params, [ownerId, 'request-key'])
  await assert.rejects(createGenerationInTransaction(f.client, await f.prepare(command({ prompt: 'different' }))), errorCode('IDEMPOTENCY_CONFLICT'))
})

test('concurrent idempotency winner is re-read and emits no duplicate input/optimization/outbox writes', async () => {
  const f = fixture({ race: true })
  const created = await createGenerationInTransaction(f.client, await f.prepare())
  assert.equal(created.replayed, true)
  assert.equal(f.statements.filter(s => s.sql.includes('SELECT * FROM generation_jobs')).length, 2)
  assert.ok(!f.statements.some(s => /INSERT INTO (generation_job_inputs|prompt_optimizations|outbox_events)/.test(s.sql)))
})

test('SQL failures escape to caller rollback and stop all later writes', async () => {
  for (const failAt of ['INSERT INTO generation_jobs', 'FROM media_uploads', 'INSERT INTO prompt_optimizations', 'INSERT INTO outbox_events']) {
    const f = fixture({ failAt, optimization: true })
    const cmd = failAt === 'FROM media_uploads' ? command({ normalizedInputs: [{ uploadId, role: 'reference_image', position: 0 }] }) : command()
    const prepared = await f.prepare(cmd)
    await f.client.query('BEGIN')
    await assert.rejects(createGenerationInTransaction(f.client, prepared), error => error === f.sqlFailure)
    assert.ok(f.statements.at(-1)!.sql.includes(failAt))
    await f.client.query('ROLLBACK')
    assert.equal(f.committed(), undefined)
    assert.ok(!f.statements.some(s => s.sql === 'COMMIT'))
  }
})

test('locked revision contract is revalidated, including mandatory input and changed defaults', async () => {
  const required = { ...capabilities, inputSlots: [{ ...capabilities.inputSlots[0], required: true, minCount: 1 }] }
  for (const lockedModel of [
    { ...model, revision_capabilities: required },
    { ...model, revision_defaults: { size: '1536x1024' } },
    { ...model, revision_capabilities: { ...capabilities, declaredBy: 'undeclared' } },
  ]) {
    const f = fixture({ lockedModel })
    await assert.rejects(createGenerationInTransaction(f.client, await f.prepare()), MediaServiceError)
    assert.ok(!f.statements.some(s => s.sql.includes('INSERT INTO')))
  }
})

test('a new revision with the same normalized payload uses its locked immutable identity', async () => {
  const f = fixture({ lockedModel: { ...model, revision_id: 'revision-4' } })
  await createGenerationInTransaction(f.client, await f.prepare())
  assert.equal(f.statements.find(s => s.sql.includes('INSERT INTO generation_jobs'))!.params[17], 'revision-4')
})

test('credential and optimization admission failures are typed before any insert', async () => {
  for (const [f, code] of [
    [fixture({ lockedModel: { ...model, provider_credential_id: 'disabled' }, missingCredential: true }), 'PROVIDER_NOT_CONFIGURED'],
    [fixture({ optimization: true, missingPromptCredential: true }), 'PROMPT_MODEL_NOT_CONFIGURED'],
  ] as const) {
    await assert.rejects(createGenerationInTransaction(f.client, await f.prepare()), errorCode(code))
    assert.ok(!f.statements.some(s => s.sql.includes('INSERT INTO')))
  }
})

test('prepare supports legacy parameters, detaches mutable input, and returns safe typed errors', async () => {
  const f = fixture()
  const cmd = command({ parameters: undefined, legacyParameters: { size: '1536x1024', count: '2' } })
  const prepared = await f.prepare(cmd)
  cmd.legacyParameters!.size = 'invalid'
  assert.deepEqual(prepared.snapshot.normalized.parameters, { size: '1536x1024', count: 2 })
  await assert.rejects(f.prepare(command({ intendedMode: 'inpaint' })), errorCode('INVALID_INPUT'))
  await assert.rejects(f.prepare(command({ parameters: { size: 'invalid' } })), error => error instanceof MediaServiceError && error.details?.parameter === 'size')
  assert.equal(generationCommandError(new Error('internal SQL detail')).message, '创建生成任务失败')
  assert.equal(generationCommandError(new Error('internal SQL detail')).status, 503)
})

test('transaction validates upload ownership, TTL and consumed state before outbox', async () => {
  for (const upload of [undefined,
    { id: uploadId, status: 'ready', deleted_at: null, attached_job_id: null, expires_at: '2000-01-01', size_bytes: 1 },
    { id: uploadId, status: 'attached', deleted_at: null, attached_job_id: 'other-job', expires_at: '2099-01-01', size_bytes: 1 },
  ]) {
    const f = fixture({ upload })
    const prepared = await f.prepare(command({ normalizedInputs: [{ uploadId, role: 'reference_image', position: 0 }] }))
    await assert.rejects(createGenerationInTransaction(f.client, prepared), MediaServiceError)
    const read = f.statements.find(s => s.sql.includes('FROM media_uploads'))!
    assert.match(read.sql, /created_by = \$2/)
    assert.equal(read.params[1], ownerId)
    assert.ok(!f.statements.some(s => s.sql.includes('INSERT INTO outbox_events')))
  }
})

test('video unified parameters share normalization and frozen intended-mode validation', async () => {
  const videoCapabilities: ModelCapabilities = {
    modes: ['text_to_video'], supportedMediaKinds: ['video'], declaredBy: 'plugin-manifest', maxCount: 1,
    parameters: [{ name: 'duration', type: 'integer', min: 1, max: 10, defaultValue: 5 }], inputSlots: [],
  }
  const ports = { database: () => ({ query: async () => ({ rows: [{ ...model, model_kind: 'video', capabilities: videoCapabilities }] }) }), runtimeLimits: async () => RUNTIME_SETTINGS_DEFAULTS }
  const prepared = await prepareGeneration(command({ parameters: { duration: 6 }, intendedMode: 'text_to_video' }), ports)
  assert.equal(prepared.snapshot.mediaKind, 'video')
  assert.equal(prepared.snapshot.normalized.mode, 'text_to_video')
  assert.equal(prepared.snapshot.normalized.parameters.duration, 6)
  await assert.rejects(prepareGeneration(command({ parameters: { duration: 6 }, intendedMode: 'text_to_image' }), ports), errorCode('INVALID_INPUT'))
})

test('runtime lookup failure uses canonical limits and missing/undeclared models fail safely', async () => {
  const ports = { database: () => ({ query: async () => ({ rows: [model] }) }), runtimeLimits: async () => { throw new Error('settings unavailable') } }
  const prepared = await prepareGeneration(command(), ports)
  assert.equal(prepared.runtimeLimits.maxInputs, RUNTIME_SETTINGS_DEFAULTS.maxInputs)
  await assert.rejects(prepareGeneration(command(), { ...ports, database: () => ({ query: async () => ({ rows: [] }) }) }), errorCode('MODEL_NOT_AVAILABLE'))
  await assert.rejects(prepareGeneration(command(), { ...ports, database: () => ({ query: async () => ({ rows: [{ ...model, capabilities: {} }] }) }) }), errorCode('MODEL_CAPABILITIES_UNDECLARED'))
})
