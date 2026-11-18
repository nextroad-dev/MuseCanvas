import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentTurnDTO, JsonObject } from '@musecanvas/contracts'
import { canvasAgentRequestDigest } from '@musecanvas/database'
import { MediaServiceError } from '@musecanvas/media-service'
import { AGENT_MEDIA_FREE_PRICING, isCanonicalMediaProposal, materializeAgentMediaProposal } from './media-proposal'
import type { AgentSqlClient } from './ports'

const ownerId = '11111111-1111-4111-8111-111111111111'
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const turnId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const roundId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const modelId = '22222222-2222-4222-8222-222222222222'
const revisionId = '33333333-3333-4333-8333-333333333333'
const sourceId = '44444444-4444-4444-8444-444444444444'
const maskId = '55555555-5555-4555-8555-555555555555'
const rawToolCallId = 'toolu_raw_1'
const languageRevision = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const toolCallId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const approvalId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const reservationId = '99999999-9999-4999-8999-999999999999'
const sourceChecksum = 'a'.repeat(64)
const maskChecksum = 'b'.repeat(64)

interface Options {
  edit?: boolean
  video?: boolean
  maskVersion?: number
  maskSourceChecksum?: string
  foreign?: boolean
  missingChecksum?: boolean
  languageRevision?: string | null
  aborted?: boolean
}

function modelRow(options: Options) {
  const capabilities = {
    modes: options.edit ? ['inpaint'] : options.video ? ['text_to_video'] : ['text_to_image'],
    supportedMediaKinds: [options.video ? 'video' : 'image'],
    declaredBy: 'plugin-manifest', maxCount: 2,
    parameters: [
      { name: 'size', type: 'enum', options: ['1024x1024'], defaultValue: '1024x1024' },
      { name: 'count', type: 'integer', min: 1, max: 2, defaultValue: 1 },
      { name: 'flag', type: 'boolean', defaultValue: true },
      { name: 'strength', type: 'number', min: 0, max: 1 },
    ],
    inputSlots: options.edit
      ? [{ role: 'reference_image', required: true, minCount: 1, maxCount: 1, allowedMediaKinds: ['image'] },
        { role: 'mask', required: true, minCount: 1, maxCount: 1, allowedMediaKinds: ['image'] }]
      : [],
    ...(options.edit ? { flags: { mask: true, inpainting: true } } : {}),
  }
  return { id: modelId, model_kind: options.video ? 'video' : 'image', revision_id: revisionId, revision: 1,
    revision_number: 1, capabilities, defaults: {}, revision_capabilities: capabilities, revision_defaults: {},
    provider_id: 'provider', plugin_id: 'synthetic', plugin_version: '1.0.0' }
}

function rawArgs(options: Options): JsonObject {
  return {
    modelId, prompt: '  draw a cat  ',
    parameters: [
      { name: 'size', value: '1024x1024' }, { name: 'count', value: '2' },
      { name: 'flag', value: 'false' }, { name: 'strength', value: '0.5' },
    ],
    inputs: options.edit
      ? [{ assetId: sourceId, role: 'reference_image', position: 0 }, { uploadId: maskId, role: 'mask', position: 1 }]
      : [],
  }
}

const uploadRow = { id: maskId, media_kind: 'image', mime_type: 'image/png', width: 1024, height: 1024,
  size_bytes: 100, checksum: maskChecksum, status: 'ready', attached_job_id: null,
  expires_at: new Date(Date.now() + 60_000), unexpired: true }
const assetRow = { id: sourceId, media_kind: 'image', mime_type: 'image/png', width: 1024, height: 1024,
  size_bytes: 100, checksum: sourceChecksum, status: 'ready', attached_job_id: null }

function fixture(options: Options = {}) {
  const statements: string[] = []
  const inserts: string[] = []
  let reserveStatements: number | undefined
  let reserveInput: Record<string, unknown> | undefined
  let approvalParams: unknown[] | undefined
  const abort = new AbortController()
  if (options.aborted) abort.abort()
  const rows = (values: Record<string, unknown>[] = []) => ({ rows: structuredClone(values), rowCount: values.length })
  const byId = (source: Record<string, unknown>[], requested: unknown) => {
    const ids = Array.isArray(requested) ? requested.map(String) : [String(requested)]
    return source.filter(row => ids.includes(String(row.id)))
  }
  const sql: AgentSqlClient = { async query(statement, params = []) {
    statements.push(statement)
    if (statement.includes('FROM model_configs')) return rows([modelRow(options)])
    if (statement.startsWith('SELECT id,checksum FROM media_uploads')) {
      if (options.foreign || options.missingChecksum) return rows(options.missingChecksum ? [{ id: params[0] }] : [])
      return rows(byId([uploadRow], params[0]).map(row => ({ id: row.id, checksum: row.checksum })))
    }
    if (statement.startsWith('SELECT id,checksum FROM assets')) {
      if (options.foreign || options.missingChecksum) return rows(options.missingChecksum ? [{ id: params[0] }] : [])
      return rows(byId([assetRow], params[0]).map(row => ({ id: row.id, checksum: row.checksum })))
    }
    if (statement.includes('p.owner_id,p.source_checksum')) return rows([{ owner_id: ownerId,
      source_checksum: options.maskSourceChecksum ?? sourceChecksum, mask_checksum: maskChecksum,
      width: 1024, height: 1024, preparation_version: options.maskVersion ?? 1 }])
    if (statement.includes('FROM agent_media_mask_preparations')) {
      return rows(byId([{ id: maskId }], params[0]).map(() => ({ source_checksum: options.maskSourceChecksum ?? sourceChecksum,
        preparation_version: options.maskVersion ?? 1 })))
    }
    if (statement.includes('AS unexpired FROM media_uploads')) return rows(byId([uploadRow], params[0]))
    if (statement.includes('FROM generation_input_images')) return rows(byId([uploadRow], params[0]))
    if (statement.includes('FROM assets')) return rows(byId([assetRow], params[0]))
    if (statement.includes('SELECT id FROM agent_tool_calls')) return rows([])
    if (statement.includes('INSERT INTO agent_tool_calls')) { inserts.push(statement); return rows([{ id: toolCallId }]) }
    if (statement.includes('UPDATE agent_sessions SET next_item_sequence')) return rows([{ sequence: '1' }])
    if (statement.includes('INSERT INTO agent_items')) return rows([{ id: 'item', session_id: sessionId, turn_id: turnId,
      sequence: '1', item_type: 'tool_call', tool_call_id: toolCallId, payload: {}, created_at: new Date() }])
    if (statement.includes('UPDATE agent_sessions SET next_event_cursor')) return rows([{ cursor: '1' }])
    if (statement.includes('INSERT INTO agent_session_events')) return rows()
    if (statement.includes('SELECT revision::text AS revision FROM agent_turns')) return rows([{ revision: '1' }])
    if (statement.includes("config_snapshot->>'modelRevisionId'")) {
      return rows([{ model_revision: options.languageRevision === null ? null : options.languageRevision ?? languageRevision }])
    }
    if (statement.includes('SELECT id FROM agent_approvals')) return rows([])
    if (statement.includes('INSERT INTO agent_approvals')) {
      approvalParams = [...params]
      return rows([{ id: approvalId, session_id: sessionId, turn_id: turnId, tool_call_id: toolCallId,
        arguments_hash: params[3], model_revision: params[4], pricing_revision: params[5], reservation_id: params[6],
        status: 'pending', expires_at: new Date(Date.now() + 60_000), resolved_by: null, resolved_at: null }])
    }
    if (/^(INSERT|UPDATE) /.test(statement)) { inserts.push(statement); return rows() }
    assert.fail(`Unexpected SQL: ${statement}`)
  } }

  const turn: AgentTurnDTO = { id: turnId, sessionId, status: 'running', engineVersion: 'agent-core-v1',
    revision: '1', inputRevision: '1', cancelRequestedAt: null, terminalAt: null,
    deadlineAt: new Date(Date.now() + 600_000).toISOString(), error: null }
  const context = { scope: { ownerId, sessionId, turnId }, round: { roundId, position: 1 }, turn, signal: abort.signal }
  const dependencies = {
    async runtimeLimits() { return { maxInputs: 8, maxImageBytes: 10_000, maxTotalBytes: 20_000 } },
    async reserveEstimatedCost(client: AgentSqlClient, input: Record<string, unknown>) {
      assert.equal(client, sql)
      reserveStatements = statements.length
      reserveInput = structuredClone(input)
      return { id: reservationId }
    },
  }
  return { sql, context, dependencies, statements, inserts, options,
    get reserveInput() { return reserveInput },
    get reserveStatements() { return reserveStatements },
    get approvalParams() { return approvalParams } }
}

const materialize = (f: ReturnType<typeof fixture>,
  input: { rawToolCallId?: string; toolName?: 'generate_image' | 'generate_video' | 'edit_image'; rawArgs?: JsonObject } = {}) =>
  materializeAgentMediaProposal(f.sql, f.context, {
    rawToolCallId: input.rawToolCallId ?? rawToolCallId,
    toolName: input.toolName ?? (f.options.video ? 'generate_video' : f.options.edit ? 'edit_image' : 'generate_image'),
    toolSchemaVersion: 1, rawArgs: input.rawArgs ?? rawArgs(f.options),
  }, f.dependencies)

const invalidInput = (error: unknown) => error instanceof MediaServiceError && error.code === 'INVALID_INPUT'
const noWrites = (f: ReturnType<typeof fixture>) => {
  assert.deepEqual(f.inserts, [])
  assert.ok(!f.statements.some(s => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/i.test(s)))
}

test('raw requests are validated strictly before any SQL runs', async () => {
  const f = fixture()
  const raw = rawArgs(f.options)
  for (const args of [
    { ...raw, modelRevisionId: revisionId },                       // internal key smuggled in
    { ...raw, approval: true },                                    // unknown key
    { ...raw, modelId: 'not-a-uuid' },
    { ...raw, prompt: '   ' },
    { ...raw, prompt: 'x'.repeat(16_001) },
    { ...raw, parameters: Array.from({ length: 33 }, () => ({ name: 'count', value: '1' })) },
    { ...raw, parameters: [{ name: 'count', value: '1', extra: 'x' }] },
    { ...raw, parameters: [{ name: 'count', value: '' }] },
    { ...raw, inputs: [{ role: 'reference_image', position: 0 }] },                       // no source
    { ...raw, inputs: [{ uploadId: maskId, assetId: sourceId, role: 'mask', position: 0 }] }, // both sources
    { ...raw, inputs: [{ uploadId: maskId, role: 'mask', position: 16 }] },
    { ...raw, inputs: Array.from({ length: 17 }, () => ({ uploadId: maskId, role: 'mask', position: 0 })) },
  ]) {
    await assert.rejects(materialize(f, { rawArgs: args }), invalidInput)
    assert.deepEqual(f.statements, [])
  }
})

test('canonical arguments are the frozen payload with typed parameters, sorted bindings and free pricing', async () => {
  const f = fixture()
  const result = await materialize(f)
  assert.deepEqual(result.arguments, {
    modelId, modelRevisionId: revisionId, prompt: 'draw a cat',
    parameters: { size: '1024x1024', count: 2, flag: false, strength: 0.5 },
    inputs: [], inputBindings: [], pricing: { ...AGENT_MEDIA_FREE_PRICING },
  })
  assert.equal(result.toolCallId, toolCallId)
  assert.equal(result.approvalId, approvalId)
  assert.equal(result.argumentsHash, canvasAgentRequestDigest(result.arguments))
  assert.deepEqual(AGENT_MEDIA_FREE_PRICING, { amount: '0', currency: 'USD', pricingRevision: 'free-v1' })
  assert.ok(isCanonicalMediaProposal(result.arguments))
})

test('pinned descriptor coercion rejects unknown names and unsupported types instead of dropping them', async () => {
  const f = fixture()
  const base = rawArgs(f.options)
  for (const parameters of [
    [{ name: 'seed', value: '7' }],                    // not declared by the pinned revision
    [{ name: 'count', value: '1.5' }],                 // integer descriptor, non-integer
    [{ name: 'count', value: 'many' }],
    [{ name: 'flag', value: 'TRUE' }],                 // boolean accepts 'true'/'false' only
    [{ name: 'count', value: '1' }, { name: 'count', value: '2' }], // duplicate name
  ]) {
    await assert.rejects(materialize(f, { rawArgs: { ...base, parameters } as JsonObject }), invalidInput)
  }
  noWrites(f)
})

test('managed checksums, ownership and mask provenance are read from rows and fail closed', async () => {
  for (const options of [{ edit: true, foreign: true }, { edit: true, missingChecksum: true },
    { edit: true, maskVersion: 2 }, { edit: true, maskSourceChecksum: 'not-a-checksum' }]) {
    const f = fixture(options)
    await assert.rejects(materialize(f), invalidInput)
    noWrites(f)
  }
  const drift = fixture({ edit: true, maskSourceChecksum: 'c'.repeat(64) })
  // A prepared mask bound to a different source checksum must not match the locked rows.
  await assert.rejects(materialize(drift), (error: unknown) => error instanceof MediaServiceError)
  noWrites(drift)
})

test('edit proposals bind the prepared mask with its preparation version and trusted source checksum', async () => {
  const f = fixture({ edit: true })
  const result = await materialize(f)
  assert.deepEqual(result.arguments.inputBindings, [
    { id: sourceId, checksum: sourceChecksum, role: 'reference_image', position: 0 },
    { id: maskId, checksum: maskChecksum, role: 'mask', position: 1, preparationVersion: 1, sourceChecksum },
  ])
  assert.equal((result.arguments.parameters as JsonObject).size, '1024x1024')
  assert.ok(f.statements.some(s => s.includes('SELECT id,checksum FROM media_uploads')))
  assert.ok(f.statements.some(s => s.includes('SELECT id,checksum FROM assets')))
  assert.ok(f.statements.some(s => s.includes('FROM agent_media_mask_preparations')))
})

test('the tool row is written before the reservation and the approval binds the frozen language revision', async () => {
  const f = fixture()
  const result = await materialize(f)
  assert.ok(f.reserveStatements !== undefined)
  assert.equal(f.statements.slice(0, f.reserveStatements).filter(s => s.includes('INSERT INTO agent_tool_calls')).length, 1)
  assert.deepEqual(f.reserveInput, {
    scope: { ownerId, sessionId, turnId }, roundId, toolCallId,
    amount: '0', currency: 'USD', pricingRevision: 'free-v1',
    limit: { maxModelCalls: 0, maxToolCalls: 0, maxMediaJobs: 0, maxMediaOutputs: 0, maxInputTokens: '0',
      maxOutputTokens: '0', maxEstimatedCost: null, maxConcurrentMediaJobs: 0, deadlineAt: f.context.turn.deadlineAt },
    nowMs: (f.reserveInput as { nowMs: number }).nowMs,
  })
  assert.ok(Number.isSafeInteger((f.reserveInput as { nowMs: number }).nowMs))
  assert.deepEqual(f.approvalParams?.slice(0, 7),
    [sessionId, turnId, toolCallId, result.argumentsHash, languageRevision, 'free-v1', reservationId])
})

test('a turn without a frozen language revision writes nothing', async () => {
  const f = fixture({ languageRevision: null })
  await assert.rejects(materialize(f), invalidInput)
  assert.ok(!f.statements.some(s => s.includes('INSERT INTO agent_approvals')))
})

test('materialization refuses to run on an aborted signal and never begins a transaction', async () => {
  const aborted = fixture({ aborted: true })
  await assert.rejects(materialize(aborted), { name: 'AbortError' })
  assert.deepEqual(aborted.statements, [])
  const f = fixture()
  await materialize(f)
  assert.ok(!f.statements.some(s => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/i.test(s) || /provider_runs|generation_jobs/i.test(s)))
})

test('a drifted price between the canonical arguments and the media-service binding aborts before any write', async () => {
  const f = fixture()
  const pricing = AGENT_MEDIA_FREE_PRICING as { amount: string }
  const amount = Object.getOwnPropertyDescriptor(pricing, 'amount')!
  let reads = 0
  // The canonical arguments and the media-service effect binding must hash the
  // same price; a price that moves between the two reads is the drift this guard
  // exists for. It must fail before the tool row, reservation or approval.
  Object.defineProperty(pricing, 'amount', { configurable: true, get: () => (reads++ === 0 ? '0' : '0.000000001') })
  try {
    await assert.rejects(materialize(f), invalidInput)
  } finally {
    Object.defineProperty(pricing, 'amount', amount)
  }
  // The failure happens after the pinned read and lock, and before the tool row.
  assert.ok(f.statements.some(s => s.includes('FROM model_configs')))
  assert.ok(!f.statements.some(s => s.includes('INSERT INTO agent_tool_calls')))
  noWrites(f)
})

test('isCanonicalMediaProposal accepts only the backend-authored key set', () => {
  const canonical = { modelId, modelRevisionId: revisionId, prompt: 'draw', parameters: {},
    inputs: [], inputBindings: [], pricing: { ...AGENT_MEDIA_FREE_PRICING } }
  assert.equal(isCanonicalMediaProposal(canonical), true)
  assert.equal(isCanonicalMediaProposal(rawArgs({})), false)
  assert.equal(isCanonicalMediaProposal({ ...canonical, parameters: [] }), false)
  assert.equal(isCanonicalMediaProposal({ ...canonical, extra: 1 }), false)
  assert.equal(isCanonicalMediaProposal({ ...canonical, prompt: '  ' }), false)
})
