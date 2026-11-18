import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentToolContext, AgentSqlClient } from '../ports'
import type { JsonObject, AgentDecimal } from '@musecanvas/contracts'
import { canvasAgentRequestDigest } from '@musecanvas/database'
import { AgentMediaApprovalRequiredError, createAgentMediaTools, executeApprovedAgentMediaProposal } from './media'
import { createAgentToolRegistry } from './registry'
import { createReadonlyAgentTools } from './readonly'

const ownerId = '11111111-1111-4111-8111-111111111111'
const modelId = '22222222-2222-4222-8222-222222222222'
const revisionId = '33333333-3333-4333-8333-333333333333'
const sourceId = '44444444-4444-4444-8444-444444444444'
const maskId = '55555555-5555-4555-8555-555555555555'
const base: JsonObject = { modelId, modelRevisionId: revisionId, prompt: 'draw', parameters: { size: '1024x1024', count: 1 }, inputs: [], inputBindings: [], pricing: { amount: '0', currency: 'USD', pricingRevision: 'free-v1' } }
function fixture(options: { video?: boolean; edit?: boolean; denied?: boolean; gateDenied?: boolean; drift?: boolean; boundDrift?: boolean; reserveFailure?: boolean; linkFailure?: boolean; abortAtEnd?: boolean; optimization?: boolean } = {}) {
  const statements: string[] = []
  const capabilities = { modes: options.edit ? ['inpaint'] : options.video ? ['text_to_video'] : ['text_to_image'],
    supportedMediaKinds: [options.video ? 'video' : 'image'], declaredBy: 'plugin-manifest', maxCount: 2,
    parameters: [{ name: 'size', type: 'enum', options: ['1024x1024'], defaultValue: '1024x1024' }, { name: 'count', type: 'integer', min: 1, max: 2, defaultValue: 1 }],
    inputSlots: options.edit ? [{ role: 'reference_image', required: true, minCount: 1, maxCount: 1, allowedMediaKinds: ['image'] }, { role: 'mask', required: true, minCount: 1, maxCount: 1, allowedMediaKinds: ['image'] }] : [], ...(options.edit ? { flags: { mask: true, inpainting: true } } : {}) }
  const model = { id: modelId, model_kind: options.video ? 'video' : 'image', revision_id: revisionId, revision: 1, revision_number: 1,
    capabilities, defaults: {}, revision_capabilities: capabilities, revision_defaults: {}, provider_id: 'provider', plugin_id: 'synthetic', plugin_version: '1.0.0' }
  const args = structuredClone(base)
  if (options.edit) {
    args.inputs = [{ assetId: sourceId, role: 'reference_image', position: 0 }, { uploadId: maskId, role: 'mask', position: 1 }]
    args.inputBindings = [{ id: sourceId, checksum: 'a'.repeat(64), role: 'reference_image', position: 0 }, { id: maskId, checksum: 'b'.repeat(64), role: 'mask', position: 1, sourceChecksum: 'a'.repeat(64), preparationVersion: 1 }]
  }
  const abort = new AbortController()
  let job: Record<string, unknown> | undefined
  let linked = false
  let gates = 0
  const reserves = new Map<string, string>()
  const upload = { id: maskId, media_kind: 'image', mime_type: 'image/png', width: 1024, height: 1024, size_bytes: 100,
    checksum: 'b'.repeat(64), status: 'ready', attached_job_id: null, deleted_at: null, unexpired: true, expires_at: new Date(Date.now() + 60000) }
  const sql: AgentSqlClient = { async query(statement, params = []) {
    statements.push(statement)
    const rows = (values: Record<string, unknown>[] = []) => ({ rows: structuredClone(values), rowCount: values.length })
    if (statement.includes('SELECT c.id,c.arguments FROM agent_tool_calls')) return rows([{ id: 'tool', arguments: args }])
    if (statement.includes('FROM agent_approvals a')) return rows(options.denied ? [] : [{ id: 'approval', model_revision: 'language-revision', pricing_revision: 'free-v1', reservation_id: 'price-reservation', amount: '0.000000000', currency: 'USD' }])
    if (statement.includes('SELECT idempotency_key FROM agent_budget_reservations')) return rows([{ idempotency_key: 'approval-price' }])
    if (statement.includes('FROM model_configs')) return rows([{ ...model, revision_id: options.drift && statement.includes('revision_id,') ? 'new-revision' : revisionId }])
    if (statement.includes('SELECT capabilities FROM model_config_revisions')) return rows([{ capabilities }])
    if (statement.includes('FROM agent_media_mask_preparations')) return rows([{ owner_id: ownerId, source_checksum: 'a'.repeat(64), mask_checksum: 'b'.repeat(64), width: 1024, height: 1024, preparation_version: 1 }])
    if (statement.includes('SELECT id FROM generation_jobs') || statement.includes('SELECT * FROM generation_jobs')) return rows(job ? [job] : [])
    if (statement.includes('SELECT * FROM prompt_optimization_settings')) return rows([{ enabled: options.optimization ?? false }])
    if (statement.includes('FROM media_uploads') || statement.includes('FROM generation_input_images')) return rows([upload])
    if (statement.includes('FROM assets')) return rows([{ ...upload, id: sourceId, checksum: options.boundDrift ? 'c'.repeat(64) : 'a'.repeat(64) }])
    if (statement.startsWith('INSERT INTO generation_jobs')) {
        assert.equal(reserves.size, 4)
      job = { id: 'job', model_id: modelId, model_revision_id: revisionId, media_kind: model.model_kind, normalized_request: JSON.parse(String(params[21])) }
      return rows([job])
    }
    if (statement.includes('INSERT INTO agent_tool_job_links')) {
      if (options.linkFailure) throw new Error('LINK_FAILED')
      if (options.abortAtEnd) abort.abort()
      if (linked) return rows()
      linked = true
      return rows([{ media_job_id: 'job' }])
    }
    if (statement.includes('SELECT media_job_id FROM agent_tool_job_links')) return rows([{ media_job_id: 'job' }])
    if (/^(INSERT|UPDATE) /.test(statement)) return rows()
    assert.fail(`Unexpected SQL: ${statement}`)
  } }
  const context = { scope: { ownerId, sessionId: 'session', turnId: 'turn' }, toolCallId: 'tool', round: { roundId: 'round', position: 1, inputRevision: '1' }, sql, signal: abort.signal,
    budget: { async reserve(input: { idempotencyKey: string; quota: string; amount: AgentDecimal }) {
      statements.push(`reserve:${input.quota}`)
      if (options.reserveFailure) throw new Error('BUDGET_EXCEEDED')
      const id = input.quota === 'estimated_cost' ? 'price-reservation' : input.quota
      reserves.set(input.idempotencyKey, id)
      return { id, quota: input.quota, amount: input.amount, currency: 'USD', pricingRevision: 'free-v1' }
    } },
  } as unknown as AgentToolContext
  const tools = createAgentMediaTools({
    async assertEffectAllowed(ctx, binding) {
      assert.equal(ctx.sql, sql)
      assert.equal(binding.argumentsHash, canvasAgentRequestDigest(args))
      assert.equal(binding.modelRevisionId, revisionId)
      if (options.gateDenied) throw new Error('ROUND_GATES_NOT_READY')
      gates++
    },
    async runtimeLimits() { return { maxInputs: 8, maxImageBytes: 10000, maxTotalBytes: 20000 } },
  })
  return { args, context, tools, statements, options, get gates() { return gates }, get job() { return job }, reserves }
}

test('media tools require injected enforcement and durable approved binding; no effects on denial', async () => {
  assert.throws(() => createAgentMediaTools(undefined as never), /PORTS_REQUIRED/)
  for (const options of [{ denied: true }, { gateDenied: true }]) {
    const f = fixture(options)
    assert.ok(f.tools.every(t => t.approval === 'required'))
    await assert.rejects(f.tools[0].execute(f.context, { modelId, prompt: 'draw', parameters: {}, inputs: [] }))
    await assert.rejects(executeApprovedAgentMediaProposal('generate_image', f.context, f.args, { assertEffectAllowed: async (_ctx, binding) => { assert.equal(binding.argumentsHash, canvasAgentRequestDigest(f.args)); if (f.options.gateDenied) throw new Error('ROUND_GATES_NOT_READY') }, runtimeLimits: async () => ({ maxInputs: 8, maxImageBytes: 10000, maxTotalBytes: 20000 }) }))
    assert.equal(f.job, undefined)
    assert.equal(f.reserves.size, 0)
    assert.ok(!f.statements.some(s => /^(INSERT|UPDATE|reserve:)/.test(s)))
  }
})

test('approved materialized image proposal reserves, creates and links through shared service on caller SQL', async () => {
  const f = fixture()
  assert.deepEqual(await executeApprovedAgentMediaProposal('generate_image', f.context, f.args, { assertEffectAllowed: async (_ctx, binding) => { assert.equal(binding.argumentsHash, canvasAgentRequestDigest(f.args)); if (f.options.gateDenied) throw new Error('ROUND_GATES_NOT_READY') }, runtimeLimits: async () => ({ maxInputs: 8, maxImageBytes: 10000, maxTotalBytes: 20000 }) }), { kind: 'pending', jobIds: ['job'] })
  assert.equal(f.reserves.size, 4)
  assert.equal(f.statements.filter(s => s.startsWith('INSERT INTO generation_jobs')).length, 1)
  assert.equal(f.statements.filter(s => s.includes('INSERT INTO agent_tool_job_links')).length, 1)
  assert.ok(f.statements.findIndex(s => s.includes("VALUES('generation.requested'")) < f.statements.findIndex(s => s.includes('INSERT INTO agent_tool_job_links')))
  assert.ok(!f.statements.some(s => /^(BEGIN|COMMIT|ROLLBACK)$|provider_runs/.test(s)))
  // Replay is on the same identity; budget keys and job/link remain unique.
  // The gate fixture counts submissions, so create never reaches a second INSERT.
  assert.deepEqual(await executeApprovedAgentMediaProposal('generate_image', f.context, f.args, { assertEffectAllowed: async (_ctx, binding) => { assert.equal(binding.argumentsHash, canvasAgentRequestDigest(f.args)); if (f.options.gateDenied) throw new Error('ROUND_GATES_NOT_READY') }, runtimeLimits: async () => ({ maxInputs: 8, maxImageBytes: 10000, maxTotalBytes: 20000 }) }), { kind: 'pending', jobIds: ['job'] })
  assert.equal(f.reserves.size, 4)
  assert.equal(f.statements.filter(s => s.startsWith('INSERT INTO generation_jobs')).length, 1)
})

test('approved video and preprepared-mask-only edit proposals use shared media command', async () => {
  for (const options of [{ video: true }, { edit: true }]) {
    const f = fixture(options)
    const tool = f.tools[options.video ? 1 : 2]
    assert.deepEqual(await executeApprovedAgentMediaProposal(options.video ? 'generate_video' : 'edit_image', f.context, f.args, { assertEffectAllowed: async (_ctx, binding) => { assert.equal(binding.argumentsHash, canvasAgentRequestDigest(f.args)); if (f.options.gateDenied) throw new Error('ROUND_GATES_NOT_READY') }, runtimeLimits: async () => ({ maxInputs: 8, maxImageBytes: 10000, maxTotalBytes: 20000 }) }), { kind: 'pending', jobIds: ['job'] })
    assert.equal((f.job!.normalized_request as JsonObject).mode, options.video ? 'text_to_video' : 'inpaint')
    if (options.edit) assert.match(tool.description, /prepared mask/)
  }
})

test('revision drift, checksum drift, auto optimization and unmaterialized defaults refuse approved payload changes', async () => {
  for (const options of [{ drift: true }, { edit: true, boundDrift: true }, { optimization: true }]) {
    const f = fixture(options)
    await assert.rejects(executeApprovedAgentMediaProposal(options.edit ? 'edit_image' : 'generate_image', f.context, f.args, { assertEffectAllowed: async () => {}, runtimeLimits: async () => ({ maxInputs: 8, maxImageBytes: 10000, maxTotalBytes: 20000 }) }))
    assert.equal(f.job, undefined)
  }
  const f = fixture()
  f.args.parameters = { count: 1 }
  await assert.rejects(executeApprovedAgentMediaProposal('generate_image', f.context, f.args, { assertEffectAllowed: async (_ctx, binding) => { assert.equal(binding.argumentsHash, canvasAgentRequestDigest(f.args)); if (f.options.gateDenied) throw new Error('ROUND_GATES_NOT_READY') }, runtimeLimits: async () => ({ maxInputs: 8, maxImageBytes: 10000, maxTotalBytes: 20000 }) }), /APPROVAL_CONFLICT/)
  assert.equal(f.reserves.size, 0)
})

test('budget/link/abort failures escape for caller rollback rather than committing a failed ToolExecutionResult', async () => {
  for (const options of [{ reserveFailure: true }, { linkFailure: true }, { abortAtEnd: true }]) {
    const f = fixture(options)
    await assert.rejects(executeApprovedAgentMediaProposal('generate_image', f.context, f.args, { assertEffectAllowed: async (_ctx, binding) => { assert.equal(binding.argumentsHash, canvasAgentRequestDigest(f.args)); if (f.options.gateDenied) throw new Error('ROUND_GATES_NOT_READY') }, runtimeLimits: async () => ({ maxInputs: 8, maxImageBytes: 10000, maxTotalBytes: 20000 }) }))
    assert.ok(!f.statements.includes('COMMIT'))
  }
})


test('executed media tools stay inert on raw requests and delegate canonical proposals exactly once', async () => {
  const f = fixture()
  const tool = f.tools[0]
  await assert.rejects(tool.execute(f.context, { modelId, prompt: 'draw', parameters: [{ name: 'size', value: '1024x1024' }], inputs: [] }),
    (error: unknown) => error instanceof AgentMediaApprovalRequiredError && error.code === 'APPROVAL_REQUIRED')
  assert.deepEqual([...f.statements], [])
  assert.equal(f.reserves.size, 0)
  assert.deepEqual(await tool.execute(f.context, f.args), { kind: 'pending', jobIds: ['job'] })
  // One delegation runs both pre-effect gates and the closing gate.
  assert.equal(f.gates, 3)
  assert.equal(f.statements.filter(s => s.startsWith('INSERT INTO generation_jobs')).length, 1)
  assert.ok(!f.statements.some(s => /^(BEGIN|COMMIT|ROLLBACK)$/.test(s)))
})

test('composed registry accepts strict raw media requests while internal proposal metadata stays out of model schema', async () => {
  const f = fixture()
  const allowlist = ['list_models@v1', 'search_assets@v1', 'get_asset@v1', 'get_canvas@v1', 'generate_image@v1', 'generate_video@v1', 'edit_image@v1']
  const registry = createAgentToolRegistry({ tools: [...createReadonlyAgentTools(), ...f.tools], allowlist })
  const raw = { modelId, prompt: 'draw', parameters: [{ name: 'size', value: '1024x1024' }, { name: 'count', value: '1' }], inputs: [] }
  const validated = registry.validateModelCall('generate_image__v1', raw)
  assert.deepEqual(validated.arguments, raw)
  assert.throws(() => registry.validateModelCall('generate_image__v1', { ...raw, approval: true }), { code: 'INVALID_ARGUMENTS' })
  assert.throws(() => registry.validateModelCall('generate_image__v1', { ...raw, prompt: 'x'.repeat(16001) }), { code: 'INVALID_ARGUMENTS' })
  const modelSchema = registry.listModelTools().find(t => t.name === 'generate_image__v1')!.parameters as JsonObject
  const modelProperties = modelSchema.properties as JsonObject
  assert.ok(!Object.hasOwn(modelProperties, 'pricing'))
  assert.equal((modelProperties.parameters as JsonObject).type, 'array')
  await assert.rejects(registry.dispatch(f.context, validated), (error: unknown) => error instanceof AgentMediaApprovalRequiredError && error.code === 'APPROVAL_REQUIRED')
  assert.equal(f.reserves.size, 0)
  assert.equal(f.job, undefined)
  assert.deepEqual(f.statements, [])
})
