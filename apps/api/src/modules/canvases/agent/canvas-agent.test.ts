import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import { CANVAS_AGENT_SETTINGS_DEFAULTS, CanvasErrorCode as C, type CanvasScene, type JsonValue, type JsonObject, type CanvasOp, type CanvasAgentMessageRequest, type CanvasAgentConfirmRequest } from '@musecanvas/contracts'
import { canvasAgentPendingIdentity, type CanvasAgentStoredMessage, type CanvasAgentPendingJob, type CanvasAgentMessageInput, type CreateCanvasAgentPendingInput, type CanvasAgentScope } from '@musecanvas/database'
import type { LanguageModelChatResult, LanguageModelChatToolCall, LanguageModelChatInput, callLanguageModelChat } from '@musecanvas/providers'
import type { Actor } from '../../../auth/security'
import type { AuthedContext } from '../../../router/types'
import { AgentError, assertLanguageModel, assertStorageStrings, modelConfigDigest, runtimeConfig } from './config'
import { createCanvasAgentHandlers } from './handlers'
import { publicMessage, publicPending, publicTurn, providerHistory } from './history'
import { agentStream } from './sse'
import { runAgent } from './loop'
import { PgAgentStore, type AgentStore, type RunContext, type MediaModel } from './store'
import { canvasSummary, executeTool, validateToolArguments } from './tools'
import { submitPending, type GenerationCreate } from './submit'

const actor: Actor = { id: randomUUID(), email: 'test@example.test', role: 'user', status: 'active', createdAt: new Date().toISOString() }
const canvasId = randomUUID(), modelId = randomUUID(), assetId = randomUUID(), sourceNodeId = randomUUID(), jobId = randomUUID()
const empty: CanvasScene = { nodes: [], edges: [] }
const generation = (id = 'call_image'): LanguageModelChatToolCall => ({ id, name: 'generate_image', arguments: { prompt: 'cat', modelId, parameters: { count: 1 } } })
const chatResult = (text = 'hello', calls: LanguageModelChatToolCall[] = []): LanguageModelChatResult => ({ text, toolCalls: calls, contentBlocks: [...(text ? [{ type: 'text' as const, text }] : []), ...calls.map(toolCall => ({ type: 'tool_call' as const, toolCall }))], usage: { inputTokens: 2, outputTokens: 3 } })
function request(overrides: Partial<CanvasAgentMessageRequest> = {}): CanvasAgentMessageRequest { return { kind: 'user', messageId: randomUUID(), text: 'draw a cat', baseRevision: 1, requireConfirmation: true, ...overrides } as CanvasAgentMessageRequest }
function context(input: unknown, signal?: AbortSignal, query = ''): AuthedContext {
  return { actor, params: { id: canvasId }, path: `canvases/${canvasId}/agent/messages`, request: new NextRequest(`https://example.test/api/canvases/${canvasId}/agent/messages${query}`, { method: 'POST', signal }), json: async () => input as Record<string, unknown> }
}
/** In-memory orchestration double, NOT PostgreSQL/concurrency evidence. */
class MemoryStore implements AgentStore {
  ctx: RunContext = { scope: { actorId: actor.id, canvasId, sessionId: randomUUID() }, lease: { turnId: randomUUID(), leaseToken: randomUUID() }, canvas: { revision: 1, scene: empty },
    settings: { ...CANVAS_AGENT_SETTINGS_DEFAULTS, enabled: true, languageModelConfigId: modelId, updatedAt: new Date().toISOString() }, config: { protocol: 'openai_chat', vendorModelId: 'test', apiKey: 'private-test-key', maxOutputTokens: 1000, timeoutMs: 120000 },
    requireConfirmation: true, autoContinuationCount: 0, replay: false, messages: [], pending: [], attemptedCalls: 0, baseRevision: 1, deadline: Date.now() + 120000, turnStatus: 'running', turnErrorCode: null }
  releaseCount = 0; createCount = 0; startCount = 0; historyArgs: number[] = []; seenSignals: AbortSignal[] = []
  pendingMap = new Map<string, CanvasAgentPendingJob>(); savedAsset: string | null = null; modelDigest = 'a'.repeat(64); messageSeq = 0
  async start(actorId: string, id: string, input: CanvasAgentMessageRequest) {
    this.startCount++
    assert.equal(id, canvasId)
    if (actorId !== actor.id) throw new AgentError(C.CANVAS_NOT_FOUND, 404)
    if (!this.ctx.settings.enabled) throw new AgentError(C.CANVAS_AGENT_DISABLED, 409)
    if (!this.ctx.settings.languageModelConfigId) throw new AgentError(C.CANVAS_AGENT_NOT_CONFIGURED, 409)
    if (input.baseRevision !== this.ctx.canvas.revision) throw new AgentError(C.CANVAS_REVISION_CONFLICT, 409)
    if (input.kind === 'job_event') throw new AgentError(C.INVALID_INPUT)
    this.ctx.requireConfirmation = input.requireConfirmation ?? true
    this.ctx.messages = [this.message({ role: 'user', content: input.text })]
    return this.ctx
  }
  message(input: CanvasAgentMessageInput): CanvasAgentStoredMessage { return { ...input, id: input.id ?? randomUUID(), seq: ++this.messageSeq, createdAt: new Date().toISOString(), sessionId: this.ctx.scope.sessionId, turnId: this.ctx.lease.turnId, contentBlocks: input.contentBlocks ?? [] } }
  async recordRound(_ctx: RunContext, assistant: CanvasAgentMessageInput) {
    const rows = [this.message(assistant), ...(assistant.toolCalls ?? []).map(call => this.message({ role: 'tool', content: JSON.stringify({ toolCallId: call.id, success: false, error: { code: C.CANVAS_AGENT_CANCELED } }) }))]
    this.ctx.messages.push(...rows); return rows
  }
  async result(_ctx: RunContext, id: string, content: string, ops: CanvasOp[]) { const msg = this.ctx.messages.find(m => m.id === id)!; msg.content = content; msg.ops = ops }
  async finish(_ctx: RunContext, input: CanvasAgentMessageInput) { this.releaseCount++; const message = this.message(input); this.ctx.messages.push(message); return message }
  async release() { this.releaseCount++ }
  async validateReferences() {}
  async models(): Promise<JsonValue> { return [] }
  async source(actorId: string, id: string, nodeId: string) { assert.equal(actorId, actor.id); assert.equal(id, canvasId); assert.equal(nodeId, sourceNodeId); if (!this.savedAsset) throw new AgentError(C.SOURCE_NOT_READY); return this.savedAsset }
  async mediaModel(_id: string, kind: 'image' | 'video'): Promise<MediaModel> {
    return {
      row: {}, digest: this.modelDigest, defaults: { count: 1 },
      capabilities: {
        modes: kind === 'image' ? ['text_to_image', 'image_to_image', 'inpaint'] : ['text_to_video', 'image_to_video'],
        supportedMediaKinds: [kind], declaredBy: 'plugin-manifest',
        parameters: [{ name: 'count', type: 'integer', min: 1, max: 1, defaultValue: 1 }],
        inputSlots: kind === 'image'
          ? [
              { role: 'reference_image', required: false, minCount: 0, maxCount: 4, allowedMediaKinds: ['image'] },
              { role: 'mask', required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'] },
            ]
          : [{ role: 'first_frame', required: true, minCount: 1, maxCount: 1, allowedMediaKinds: ['image'] }],
        maxCount: 1,
      },
    }
  }
  async pending(ctx: RunContext, input: CreateCanvasAgentPendingInput) {
    if (this.pendingMap.size >= ctx.settings.maxJobsPerTurn) throw new AgentError(C.CANVAS_AGENT_BUDGET_EXCEEDED)
    const ids = canvasAgentPendingIdentity(canvasId, input.toolCallId)
    const pending: CanvasAgentPendingJob = { ...input, ...ids, sessionId: ctx.scope.sessionId, canvasId, createdBy: actor.id, turnId: ctx.lease.turnId, status: 'pending', jobId: null,
      requestDigest: 'b'.repeat(64), leaseToken: null, leaseExpiresAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    this.pendingMap.set(pending.id, pending); return pending
  }
  async claim(actorId: string, id: string, input: CanvasAgentConfirmRequest) {
    assert.equal(id, canvasId)
    const pending = this.pendingMap.get(input.pendingId)
    if (actorId !== actor.id || !pending) throw new AgentError(C.CANVAS_AGENT_CONFIRM_NOT_FOUND, 404)
    if (pending.status === 'submitted') return { scope: this.ctx.scope, pending, claimed: false }
    if (pending.status !== 'pending') throw new AgentError(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
    if (Date.parse(pending.expiresAt) <= Date.now()) throw new AgentError(C.CANVAS_AGENT_CONFIRM_EXPIRED, 409)
    if (pending.baseRevision !== this.ctx.canvas.revision || pending.modelConfigDigest !== this.modelDigest || (pending.sourceAssetId && pending.sourceAssetId !== this.savedAsset)) throw new AgentError(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
    if (!input.approve) { pending.status = 'rejected'; return { scope: this.ctx.scope, pending, claimed: false } }
    pending.status = 'submitting'; pending.leaseToken = randomUUID(); return { scope: this.ctx.scope, pending, claimed: true }
  }
  async complete(_scope: CanvasAgentScope, pending: CanvasAgentPendingJob, id: string) { pending.status = 'submitted'; pending.jobId = id; pending.ops = pending.ops.map(op => op.type === 'add_node' ? { ...op, node: { ...op.node, data: { ...op.node.data, jobId: id } } } as CanvasOp : op); return pending }
  preparations = new Map<string, import('@musecanvas/database').CanvasAgentEditPreparation>()
  async reserveEdit(ctx: RunContext, toolCallId: string, identity: JsonObject) {
    const existing = this.preparations.get(toolCallId)
    if (existing) return existing
    const reservation: import('@musecanvas/database').CanvasAgentEditPreparation = { id: randomUUID(), sessionId: ctx.scope.sessionId, canvasId, createdBy: actor.id, turnId: ctx.lease.turnId, toolCallId,
      requestDigest: 'c'.repeat(64), requestSnapshot: identity, maskUploadId: randomUUID(), expiresAt: new Date(Date.now() + 600000).toISOString(), status: 'preparing', leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), artifact: null, readySnapshot: null }
    this.preparations.set(toolCallId, reservation); return reservation
  }
  async stageEditMask(_ctx: RunContext, _preparation: import('@musecanvas/database').CanvasAgentEditPreparation, _row: any, put: () => Promise<void>) { await put() }
  async completeEdit(_ctx: RunContext, preparation: import('@musecanvas/database').CanvasAgentEditPreparation, snapshot: import('@musecanvas/database').CanvasAgentPreparedEdit) {
    preparation.status = 'ready'; preparation.readySnapshot = snapshot; return preparation
  }
  async existingPending(ctx: RunContext, toolCallId: string) {
    const pending = this.pendingMap.get(canvasAgentPendingIdentity(canvasId, toolCallId).id)
    return pending?.turnId === ctx.lease.turnId ? pending : null
  }
  async turn(actorId: string, id: string, turnId: string) {
    if (actorId !== actor.id || id !== canvasId || turnId !== this.ctx.lease.turnId) throw new AgentError(C.CANVAS_NOT_FOUND, 404)
    return publicTurn({ id: turnId, messageId: this.ctx.messages[0]?.id ?? randomUUID(), status: 'completed' } as any, [...this.pendingMap.values()])
  }
  async history(_actor: string, _canvas: string, after: number, limit: number, before?: number) { this.historyArgs = [after, limit, ...(before !== undefined ? [before] : [])]; return { scope: this.ctx.scope, session: { requireConfirmation: this.ctx.requireConfirmation, autoContinuationCount: 0 } as any, messages: this.ctx.messages, nextAfterSeq: null, pending: [...this.pendingMap.values()] } }
  async apply(_actorId: string, _id: string, turnId: string) {
    if (turnId === '00000000-0000-0000-0000-000000000404') return { status: 'not_found' as const }
    if (turnId === '00000000-0000-0000-0000-000000000409') return { status: 'conflict' as const, code: C.CANVAS_AGENT_APPLY_CONFLICT }
    return { status: 'applied' as const, revision: 2, ops: [] }
  }
  async status() {
    return {
      enabled: this.ctx.settings.enabled,
      available: true,
      reason: 'ready' as const,
      maxToolCallsPerTurn: this.ctx.settings.maxToolCallsPerTurn,
      maxJobsPerTurn: this.ctx.settings.maxJobsPerTurn,
      timeoutMs: this.ctx.settings.timeoutMs,
      maxAutoContinuations: this.ctx.settings.maxAutoContinuations,
    }
  }
}
function fixture(results = [chatResult()]) {
  const store = new MemoryStore(); const inputs: LanguageModelChatInput[] = [], commands: Parameters<GenerationCreate>[0][] = []
  const chat: typeof callLanguageModelChat = async input => { inputs.push(input); store.seenSignals.push(input.signal!); return results.shift() ?? chatResult('finished') }
  const create: GenerationCreate = async cmd => { store.createCount++; commands.push(cmd); return NextResponse.json({ success: true, data: { id: jobId } }, { status: 202 }) }
  const handlers = createCanvasAgentHandlers({ store, chat, create, limited: async () => false })
  return { store, chat, create, handlers, inputs, commands }
}
function frames(text: string) { return text.split('\n\n').filter(frame => frame.startsWith('event:')).map(frame => JSON.parse(frame.split('\ndata: ')[1]!)) }

 test('real SSE first frame, full typed events and orderly end; upstream text is one segment', async () => {
  const f = fixture(); const response = await f.handlers.messages(context(request()))
  assert.equal(response.headers.get('content-type'), 'text/event-stream'); assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform'); assert.equal(response.headers.get('x-accel-buffering'), 'no')
  const reader = response.body!.getReader(), first = await reader.read()
  assert.equal(new TextDecoder().decode(first.value), ': connected\n\n')
  let text = ''; while (true) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value) }
  const events = frames(text); assert.deepEqual(events.map(e => e.type), ['text_delta', 'done']); assert.equal(events[0].delta, 'hello')
  assert.match(events[0].turnId, /^[0-9a-f-]{36}$/); assert.match(events[0].eventId, /^[0-9a-f-]{36}$/); assert.equal(f.store.releaseCount, 1)
})
 test('stream cancel and request abort share upstream signal, clear resources and release lease', async () => {
  for (const cancelRequest of [false, true]) {
    const f = fixture(), controller = new AbortController()
    let providerAborted = false
    const chat: typeof callLanguageModelChat = async input => new Promise((_, reject) => { input.signal!.addEventListener('abort', () => { providerAborted = true; reject(new Error('secret upstream prompt/url')) }, { once: true }) })
    const handlers = createCanvasAgentHandlers({ store: f.store, chat, create: f.create, limited: async () => false })
    const response = await handlers.messages(context(request(), controller.signal)), reader = response.body!.getReader()
    await reader.read(); await new Promise(resolve => setImmediate(resolve))
    if (cancelRequest) { controller.abort(); while (!(await reader.read()).done) {} } else await reader.cancel()
    assert.equal(providerAborted, true); assert.equal(f.store.releaseCount, 1)
  }
})
 test('heartbeat/deadline stream emits sanitized timeout error and cleanup once', async () => {
  let cleaned = 0, sawAbort = false
  const response = agentStream({ signal: new AbortController().signal, timeoutMs: 25, heartbeatMs: 5, cleanup: async () => { cleaned++ },
    run: async (send, signal) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => { sawAbort = true; resolve() }, { once: true })); send({ type: 'error', turnId: randomUUID(), eventId: randomUUID(), code: C.CANVAS_AGENT_TIMEOUT, message: C.CANVAS_AGENT_TIMEOUT, retryable: false }) } })
  const body = await response.text(); assert.ok(body.includes(': heartbeat')); assert.ok(body.includes(C.CANVAS_AGENT_TIMEOUT)); assert.equal(cleaned, 1); assert.equal(sawAbort, true)
})
 test('disabled/unconfigured/revision errors are JSON before stream', async () => {
  for (const [mutate, code] of [ [(s: MemoryStore) => { s.ctx.settings.enabled = false }, C.CANVAS_AGENT_DISABLED], [(s: MemoryStore) => { s.ctx.settings.languageModelConfigId = null }, C.CANVAS_AGENT_NOT_CONFIGURED], [(s: MemoryStore) => { s.ctx.canvas.revision = 2 }, C.CANVAS_REVISION_CONFLICT] ] as const) {
    const f = fixture(); mutate(f.store); const response = await f.handlers.messages(context(request())); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, code); assert.equal(f.inputs.length, 0)
  }
})
 test('strict requests, mutation origin and actor-scoped shared rate key gate before DB', async () => {
  const f = fixture(); const invalid = await f.handlers.messages(context({ ...request(), scene: empty })); assert.equal(invalid.status, 400); assert.equal(f.store.startCount, 0)
  const keys: string[] = []
  const handlers = createCanvasAgentHandlers({ store: f.store, chat: f.chat, create: f.create, limited: async key => { keys.push(key); return true } })
  for (const handler of [handlers.messages, handlers.confirm, handlers.history]) assert.equal((await handler(context(request()))).status, 429)
  assert.equal(new Set(keys).size, 1); assert.equal(keys[0], `canvas-agent:${actor.id}`)
  const ctx = context(request()); ctx.request.headers.set('origin', 'https://evil.test'); ctx.request.headers.set('host', 'example.test'); assert.equal((await f.handlers.messages(ctx)).status, 403)
})
 test('history defaults/bounds, public mapping removes private blocks/digests/leases', async () => {
  const f = fixture(); await f.handlers.history(context({}, undefined, '?afterSeq=0')); assert.deepEqual(f.store.historyArgs, [0, 50])
  for (const query of ['?limit=101', '?afterSeq=-1', '?limit=0', '?afterSeq=2.5']) assert.equal((await f.handlers.history(context({}, undefined, query))).status, 400)
  const msg = f.store.message({ role: 'assistant', content: 'hello', contentBlocks: [{ private: 'do-not-leak' }] }); assert.equal('contentBlocks' in publicMessage(msg), false)
})
 test('no job before confirm, immutable stable submit command and replay placeholder', async () => {
  const f = fixture([chatResult('', [generation()])]); const response = await f.handlers.messages(context(request())); const events = frames(await response.text())
  assert.equal(f.store.createCount, 0); assert.ok(events.some(e => e.type === 'confirm_required')); assert.equal(f.inputs.length, 1)
  const pending = [...f.store.pendingMap.values()][0]!; assert.equal(publicPending(pending).toolCallId, 'call_image'); assert.equal('modelConfigDigest' in publicPending(pending), false); assert.equal('idempotencyKey' in publicPending(pending), false)
  const confirmed = await f.handlers.confirm(context({ pendingId: pending.id, approve: true })), first = await confirmed.json()
  const second = await (await f.handlers.confirm(context({ pendingId: pending.id, approve: true }))).json()
  assert.equal(f.store.createCount, 1); assert.deepEqual(first, second); assert.equal(first.data.jobId, jobId)
  assert.equal(f.commands[0]!.idempotencyKey, pending.idempotencyKey); assert.deepEqual(f.commands[0]!.parameters, pending.parameters); assert.equal(f.commands[0]!.prompt, pending.prompt)
})
 test('confirmation false uses same persisted path, reject never creates, approve/reject CAS', async () => {
  const automatic = fixture([chatResult('', [generation()])]); const events = frames(await (await automatic.handlers.messages(context(request({ requireConfirmation: false })))).text())
  assert.equal(automatic.store.createCount, 1); assert.equal(events.some(e => e.type === 'confirm_required'), false); assert.ok(events.some(e => e.type === 'canvas_ops'))
  const f = fixture([chatResult('', [generation()])]); await (await f.handlers.messages(context(request()))).text(); const pending = [...f.store.pendingMap.values()][0]!
  assert.equal((await f.handlers.confirm(context({ pendingId: pending.id, approve: false }))).status, 200)
  assert.equal((await f.handlers.confirm(context({ pendingId: pending.id, approve: true }))).status, 409); assert.equal(f.store.createCount, 0)
  assert.equal((await f.handlers.confirm(context({ pendingId: pending.id, approve: true, modelId }))).status, 400)
})
 test('pending expiry, source replacement, revision and config changes conflict without jobs', async () => {
  for (const change of ['expiry', 'revision', 'config', 'source']) {
    const f = fixture([chatResult('', [generation()])]); await (await f.handlers.messages(context(request()))).text(); const pending = [...f.store.pendingMap.values()][0]!
    if (change === 'expiry') (pending as any).expiresAt = new Date(0).toISOString()
    if (change === 'revision') f.store.ctx.canvas.revision = 2
    if (change === 'config') f.store.modelDigest = 'c'.repeat(64)
    if (change === 'source') { (pending as any).sourceAssetId = assetId; f.store.savedAsset = randomUUID() }
    const result = await f.handlers.confirm(context({ pendingId: pending.id, approve: true })); assert.equal(result.status, 409); assert.equal(f.store.createCount, 0)
  }
})
 test('all invalid/budget calls receive paired structured results; pending ends round without busy polling', async () => {
  const f = fixture([chatResult('', [{ id: 'bad', name: 'add_node', arguments: { unexpected: true } }, generation(), generation('extra')])]); f.store.ctx.settings.maxToolCallsPerTurn = 2
  const events = frames(await (await f.handlers.messages(context(request()))).text())
  const results = events.filter(e => e.type === 'tool_result'); assert.equal(results.length, 3); assert.equal(results[0].success, false); assert.equal(results[2].result.error.code, C.CANVAS_AGENT_BUDGET_EXCEEDED)
  const history = providerHistory(f.store.ctx.messages); assert.equal(history.filter(m => m.role === 'tool').length, 3); assert.equal(f.inputs.length, 1); assert.equal(f.store.createCount, 0)
})
 test('max jobs uses persisted current-turn pending counts; no model-supplied policy', async () => {
  const f = fixture(); f.store.ctx.settings.maxJobsPerTurn = 1
  const call = generation(), first = await executeTool({ store: f.store, ctx: f.store.ctx, actor, call, scene: empty, signal: new AbortController().signal, create: f.create })
  assert.ok(first.pending)
  await assert.rejects(executeTool({ store: f.store, ctx: f.store.ctx, actor, call: generation('second'), scene: empty, signal: new AbortController().signal, create: f.create }), (e: AgentError) => e.code === C.CANVAS_AGENT_BUDGET_EXCEEDED)
  assert.throws(() => validateToolArguments('generate_image', { ...call.arguments, requireConfirmation: false }), AgentError); assert.equal(f.store.createCount, 0)
})
 test('generation rejects wrong/unknown parameters and video requires saved ready image', async () => {
  const f = fixture(); const base = { store: f.store, ctx: f.store.ctx, actor, scene: empty, signal: new AbortController().signal, create: f.create }
  await assert.rejects(executeTool({ ...base, call: { ...generation(), arguments: { ...generation().arguments, parameters: { count: 2 } } } }), AgentError)
  await assert.rejects(executeTool({ ...base, call: { id: 'video', name: 'generate_video', arguments: { sourceNodeId, modelId, prompt: 'move', parameters: { count: 1 } } } }), (e: AgentError) => e.code === C.SOURCE_NOT_READY)
  assert.equal(f.store.pendingMap.size, 0)
})
 test('CanvasOp validation applies detached virtual scene only, cumulative operations persisted before emit', async () => {
  const nodeId = randomUUID(), f = fixture([chatResult('', [{ id: 'node', name: 'add_node', arguments: { node: { id: nodeId, type: 'note', position: { x: 0, y: 0 }, data: { text: 'hi' } } } }, { id: 'arrange', name: 'arrange', arguments: { positions: [{ nodeId, position: { x: 5, y: 8 } }] } }]), chatResult('done')])
  const original = JSON.stringify(empty); const events = frames(await (await f.handlers.messages(context(request()))).text()); assert.equal(JSON.stringify(empty), original)
  assert.equal(events.filter(e => e.type === 'canvas_ops').length, 2); assert.equal(f.store.ctx.messages.flatMap(m => m.ops ?? []).length, 2)
  assert.equal(f.inputs[1]!.messages.filter(m => m.role === 'tool').length, 2)
  assert.throws(() => validateToolArguments('remove_node', { nodeId, role: 'admin' }), AgentError)
})
 test('whole-turn history truncation never leaves assistant calls unpaired; preserves ordered contentBlocks', () => {
  const f = fixture(), call = generation(), assistant = f.store.message({ role: 'assistant', content: 't', toolCalls: [call as any], contentBlocks: chatResult('t', [call]).contentBlocks as unknown as JsonValue[] })
  const tool = f.store.message({ role: 'tool', content: JSON.stringify({ toolCallId: call.id, success: false, result: { error: { code: C.CANVAS_AGENT_CANCELED } } }) })
  assert.equal(providerHistory([assistant, tool], 1).length, 0)
  const paired = providerHistory([assistant, tool]); assert.equal(paired.length, 2); assert.deepEqual((paired[0] as any).contentBlocks, assistant.contentBlocks)
  assert.equal(providerHistory([assistant]).length, 0)
})
 test('provider/submit errors are sanitized; stream-started failures stay SSE', async () => {
  const f = fixture(); const handlers = createCanvasAgentHandlers({ store: f.store, create: f.create, limited: async () => false, chat: async () => { throw new Error('sk-secret https://provider.invalid private prompt') } })
  const response = await handlers.messages(context(request())), text = await response.text(); assert.equal(response.status, 200); assert.ok(text.includes(C.CANVAS_AGENT_FAILED)); assert.ok(!text.includes('sk-secret')); assert.equal(f.store.releaseCount, 1)
  const g = fixture([chatResult('', [generation()])]); await (await g.handlers.messages(context(request()))).text(); const pending = [...g.store.pendingMap.values()][0]!
  await assert.rejects(submitPending(g.store, actor, canvasId, { pendingId: pending.id, approve: true }, async () => NextResponse.json({ success: false, error: { message: 'secret' } }, { status: 503 }), new AbortController().signal, 1000), (e: AgentError) => e.code === C.CANVAS_AGENT_FAILED)
})
 test('runtime protocol/plugin/credential checks fail closed; fingerprint ignores secret and detects revision', async () => {
  const model = { id: modelId, model_kind: 'language', enabled: true, language_protocol: 'openai_chat', plugin_id: 'openai-language', plugin_version: '1.0.0', vendor_model_id: 'test', latest_revision_id: 'rev1' }
  const credential = { enabled: true, api_key_encrypted: 'cipher', schema_id: 'legacy-api-key-v1' }
  assertLanguageModel(model, credential)
  for (const patch of [{ model_kind: 'image' }, { enabled: false }, { deleted_at: new Date() }, { language_protocol: 'openai_responses' }, { plugin_version: '9.0.0' }, { plugin_id: 'anthropic-language' }]) assert.throws(() => assertLanguageModel({ ...model, ...patch }, credential), AgentError)
  assert.throws(() => assertLanguageModel(model, { ...credential, enabled: false }), AgentError)
  assert.throws(() => assertLanguageModel(model, { ...credential, api_key_encrypted: '' }), AgentError)
  assert.equal(modelConfigDigest(model, credential), modelConfigDigest(model, { ...credential, api_key_encrypted: 'different-secret' }))
  assert.notEqual(modelConfigDigest(model, credential), modelConfigDigest({ ...model, latest_revision_id: 'rev2' }, credential))
  await assert.rejects(runtimeConfig({ query: () => { throw new Error('must not query') } } as any, { ...CANVAS_AGENT_SETTINGS_DEFAULTS, updatedAt: '' }), (e: AgentError) => e.code === C.CANVAS_AGENT_DISABLED)
})
 test('production source read is owner-scoped and never uses virtual nodes or writes scene', async () => {
  const sql: string[] = []
  const tx: any = async (fn: any) => fn({ query: async (query: string, args: unknown[]) => { sql.push(query); if (query.includes('canvas_documents')) { assert.deepEqual(args, [canvasId, actor.id]); return { rows: [{ revision: 1, scene: { nodes: [{ id: sourceNodeId, type: 'image', position: { x: 0, y: 0 }, data: { assetId } }], edges: [] } }] } } assert.ok(query.includes('created_by=$2')); return { rows: [] } } })
  const store = new PgAgentStore(tx); await assert.rejects(store.source(actor.id, canvasId, sourceNodeId), (e: AgentError) => e.code === C.SOURCE_NOT_READY); assert.ok(sql.every(query => query.startsWith('SELECT')))
})
 test('fake terminal events and changed actor cannot reach generation/continuation', async () => {
  const f = fixture(); const event = { kind: 'job_event', jobId, messageId: randomUUID(), baseRevision: 1 }
  assert.equal((await f.handlers.messages(context(event))).status, 400)
  assert.equal((await f.handlers.messages(context({ ...event, status: 'succeeded', assetId }))).status, 400)
  const wrong = context(request()); wrong.actor = { ...actor, id: randomUUID() }; assert.equal((await f.handlers.messages(wrong)).status, 404); assert.equal(f.store.createCount, 0)
})

 test('cancel after assistant calls preserves ALL pairs without task creation', async () => {
  const f = fixture([chatResult('', [{ id: 'models', name: 'list_models', arguments: {} }, generation()])]), controller = new AbortController()
  f.store.models = async () => { controller.abort(); throw new Error('interrupted tool') }
  const response = await f.handlers.messages(context(request(), controller.signal)); await response.text()
  const history = providerHistory(f.store.ctx.messages)
  assert.equal(history.filter(message => message.role === 'tool').length, 2)
  assert.equal(f.store.createCount, 0); assert.equal(f.store.releaseCount, 1)
 })
 test('expired-run retry recovers persisted pending work without fresh model calls', async () => {
  const f = fixture([chatResult('', [generation()])]); await (await f.handlers.messages(context(request()))).text()
  f.store.ctx.pending = [...f.store.pendingMap.values()]; f.store.ctx.leaseReleased = false
  const events: any[] = []
  await runAgent({ ctx: f.store.ctx, actor, store: f.store, chat: f.chat, create: f.create, signal: new AbortController().signal, send: event => events.push(event) })
  assert.equal(f.inputs.length, 1); assert.equal(f.store.pendingMap.size, 1); assert.ok(events.some(event => event.type === 'confirm_required'))
 })
 test('completed turn replay emits persisted placeholder/pending without generation; error is persisted before frame', async () => {
  const f = fixture([chatResult('', [generation()])]); await (await f.handlers.messages(context(request()))).text()
  f.store.ctx.pending = [...f.store.pendingMap.values()]; f.store.ctx.replay = true; f.store.ctx.turnStatus = 'completed'
  const events: any[] = []
  await runAgent({ ctx: f.store.ctx, actor, store: f.store, chat: f.chat, create: f.create, signal: new AbortController().signal, send: event => events.push(event) })
  assert.equal(f.inputs.length, 1); assert.equal(f.store.createCount, 0); assert.ok(events.some(event => event.type === 'done'))
  const g = fixture(); let released = false
  g.store.release = async () => { released = true }
  await runAgent({ ctx: g.store.ctx, actor, store: g.store, create: g.create, chat: async () => { throw new Error('private') }, signal: new AbortController().signal, send: event => { if (event.type === 'error') assert.equal(released, true) } })
 })

 test('synced storage-string contract rejects invalid provider text and JSON before persistence', async () => {
  for (const invalid of ['bad\u0000text', 'bad\ud800', 'bad\udfff']) {
    const value = invalid
    const f = fixture([chatResult(value)])
    const events = frames(await (await f.handlers.messages(context(request()))).text())
    assert.deepEqual(events.map(event => event.type), ['error'])
    assert.equal(events[0].code, C.CANVAS_AGENT_FAILED)
    assert.equal(f.store.ctx.messages.filter(message => message.role === 'assistant').length, 0)
    assert.equal(f.store.createCount, 0)
    assert.throws(() => assertStorageStrings({ nested: { [value]: 'x' } }), AgentError)
    assert.throws(() => assertStorageStrings({ nested: [value] }), AgentError)
  }
  assert.doesNotThrow(() => assertStorageStrings({ text: 'valid emoji 🐈' }))
 })
 test('invalid tool result becomes a paired sanitized error; bounded summary preserves surrogate pairs', async () => {
  const f = fixture([chatResult('', [{ id: 'models', name: 'list_models', arguments: {} }]), chatResult('done')])
  f.store.models = async () => ({ displayName: 'bad\u0000'.replace('\u0000', '\u0000') })
  const events = frames(await (await f.handlers.messages(context(request()))).text())
  const result = events.find(event => event.type === 'tool_result')
  assert.equal(result.success, false); assert.equal(result.result.error.code, C.CANVAS_AGENT_FAILED)
  assert.equal(providerHistory(f.store.ctx.messages).filter(message => message.role === 'tool').length, 1)
  const summary = canvasSummary({ nodes: [{ id: randomUUID(), type: 'note', position: { x: 0, y: 0 }, data: { text: `${'x'.repeat(499)}🐈tail` } }], edges: [] })
  assert.doesNotThrow(() => assertStorageStrings(summary))
 })
 test('production message string boundary rejects invalid text before opening PG transaction', async () => {
  let queries = 0
  const store = new PgAgentStore((async () => { queries++; throw new Error('must not connect') }) as any)
  await assert.rejects(store.finish(fixture().store.ctx, { role: 'assistant', content: '\u0000'.replace('\u0000', '\u0000') }), AgentError)
  await assert.rejects(store.recordRound(fixture().store.ctx, { role: 'assistant', content: 'ok', contentBlocks: [{ text: '\ud800'.replace('\ud800', '\ud800') }] }), AgentError)
  assert.equal(queries, 0)
 })

 test('crash after result commit but before ops frame redelivers before resumed model work', async () => {
  const f = fixture(), nodeId = randomUUID()
  f.store.ctx.messages = [f.store.message({ role: 'user', content: 'add note' })]
  const call = { id: 'note', name: 'add_node', arguments: { node: { id: nodeId, type: 'note', position: { x: 0, y: 0 }, data: { text: 'committed' } } } }
  const round = await f.store.recordRound(f.store.ctx, { role: 'assistant', content: '', toolCalls: [call] })
  const ops: CanvasOp[] = [{ type: 'add_node', node: { id: nodeId, type: 'note', position: { x: 0, y: 0 }, data: { text: 'committed' } } }]
  await f.store.result(f.store.ctx, round[1]!.id, JSON.stringify({ toolCallId: call.id, success: true, result: { ok: true } }), ops)
  f.store.ctx.attemptedCalls = 1
  const events: any[] = []
  await runAgent({ ctx: f.store.ctx, actor, store: f.store, create: f.create, signal: new AbortController().signal,
    chat: async () => { assert.deepEqual(events[0].ops, ops); return chatResult('resumed') }, send: event => events.push(event) })
  assert.equal(events[0].type, 'canvas_ops'); assert.equal(f.store.createCount, 0); assert.deepEqual(f.store.ctx.canvas.scene, empty)
 })
 test('submitted pending before tool-result commit survives lost recovery response and completed replay with identical ops', async () => {
  const f = fixture(), call = generation()
  f.store.ctx.messages = [f.store.message({ role: 'user', content: 'cat' })]
  await f.store.recordRound(f.store.ctx, { role: 'assistant', content: '', toolCalls: [call as any] })
  const outcome = await executeTool({ store: f.store, ctx: f.store.ctx, actor, call, scene: empty, signal: new AbortController().signal, create: f.create })
  const pending = outcome.pending!
  await f.create({ actor, modelId: pending.modelId, prompt: pending.prompt, parameters: pending.parameters, normalizedInputs: [], idempotencyKey: pending.idempotencyKey })
  await f.store.complete(f.store.ctx.scope, pending, jobId)
  f.store.ctx.pending = [pending]
  const events: any[] = []
  await runAgent({ ctx: f.store.ctx, actor, store: f.store, chat: f.chat, create: f.create, signal: new AbortController().signal, send: event => events.push(event) })
  assert.deepEqual(events.find(event => event.type === 'canvas_ops').ops, pending.ops)
  assert.deepEqual(f.store.ctx.messages.at(-1)!.ops, pending.ops)
  assert.equal(f.inputs.length, 0); assert.equal(f.store.createCount, 1)
  f.store.ctx.replay = true; f.store.ctx.turnStatus = 'completed'
  const replay: any[] = []
  await runAgent({ ctx: f.store.ctx, actor, store: f.store, chat: f.chat, create: f.create, signal: new AbortController().signal, send: event => replay.push(event) })
  assert.deepEqual(replay.find(event => event.type === 'canvas_ops').ops, pending.ops)
  assert.equal(replay.filter(event => event.type === 'canvas_ops').length, 1)
  assert.equal(f.inputs.length, 0); assert.equal(f.store.createCount, 1)
 })
 test('recovered placeholders dedupe existing stable node and edge identities without dropping general ops', async () => {
  const f = fixture(), call = generation(), source = randomUUID()
  f.store.ctx.canvas.scene = { nodes: [{ id: source, type: 'note', position: { x: 0, y: 0 }, data: { text: 'source' } }], edges: [] }
  f.store.ctx.messages = [f.store.message({ role: 'user', content: 'cat' })]
  const round = await f.store.recordRound(f.store.ctx, { role: 'assistant', content: '', toolCalls: [call as any] })
  const outcome = await executeTool({ store: f.store, ctx: f.store.ctx, actor, call, scene: f.store.ctx.canvas.scene, signal: new AbortController().signal, create: f.create })
  const pending = outcome.pending!
  pending.ops.push({ type: 'connect', edge: { id: pending.edgeId, source, target: pending.nodeId } })
  await f.store.complete(f.store.ctx.scope, pending, jobId)
  await f.store.result(f.store.ctx, round[1]!.id, JSON.stringify({ toolCallId: call.id, success: true, result: { jobId } }), pending.ops)
  f.store.ctx.pending = [pending]
  const events: any[] = []
  await runAgent({ ctx: f.store.ctx, actor, store: f.store, chat: f.chat, create: f.create, signal: new AbortController().signal, send: event => events.push(event) })
  assert.deepEqual(events.filter(event => event.type === 'canvas_ops').map(event => event.ops), [pending.ops])
  assert.deepEqual(f.store.ctx.messages.at(-1)!.ops, [])
  f.store.ctx.replay = true; f.store.ctx.turnStatus = 'completed'
  const replay: any[] = []
  await runAgent({ ctx: f.store.ctx, actor, store: f.store, chat: f.chat, create: f.create, signal: new AbortController().signal, send: event => replay.push(event) })
  assert.deepEqual(replay.find(event => event.type === 'canvas_ops').ops, pending.ops)
 })

 test('handlers.apply commits scene, rejects invalid inputs and propagates conflicts', async () => {
  const f = fixture()
  const validTurn = randomUUID()
  const res = await f.handlers.apply(context({ turnId: validTurn }))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.success, true)
  assert.equal(body.data.applied, true)
  assert.equal(body.data.revision, 2)

  // 404 when turn not found
  const notFoundRes = await f.handlers.apply(context({ turnId: '00000000-0000-0000-0000-000000000404' }))
  assert.equal(notFoundRes.status, 404)

  // 409 when conflict
  const conflictRes = await f.handlers.apply(context({ turnId: '00000000-0000-0000-0000-000000000409' }))
  assert.equal(conflictRes.status, 409)

  // 400 on bad turnId
  const badIdRes = await f.handlers.apply(context({ turnId: 'not-a-uuid' }))
  assert.equal(badIdRes.status, 400)

  // 403 on inactive actor
  const inactiveContext: AuthedContext = {
    ...context({ turnId: validTurn }),
    actor: { ...actor, status: 'disabled' },
  }
  const inactiveRes = await f.handlers.apply(inactiveContext)
  assert.equal(inactiveRes.status, 403)
 })

 test('handlers.status returns operational configuration and checks actor status', async () => {
  const f = fixture()
  const res = await f.handlers.status(context({}))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.success, true)
  assert.equal(body.data.enabled, true)
  assert.equal(body.data.available, true)
  assert.equal(body.data.reason, 'ready')

  // Inactive actor
  const inactiveContext: AuthedContext = {
    ...context({}),
    actor: { ...actor, status: 'disabled' },
  }
  const inactiveRes = await f.handlers.status(inactiveContext)
  assert.equal(inactiveRes.status, 403)
 })

 test('handlers.history enforces beforeSeq bounds and passes pagination to store', async () => {
  const f = fixture()
  // beforeSeq = 0 fails with 400 INVALID_INPUT
  const badRes = await f.handlers.history(context({}, undefined, '?beforeSeq=0'))
  assert.equal(badRes.status, 400)

  // beforeSeq = 5 succeeds
  const goodRes = await f.handlers.history(context({}, undefined, '?beforeSeq=5&limit=20'))
  assert.equal(goodRes.status, 200)
  assert.deepEqual(f.store.historyArgs, [0, 20, 5])
 })

 test('executeTool handles generate_image with multiple reference inputs', async () => {
  const f = fixture()
  const call: LanguageModelChatToolCall = {
    id: 'call_multi_input',
    name: 'generate_image',
    arguments: {
      prompt: 'cat with style',
      modelId,
      parameters: { count: 1 },
      inputs: [
        { assetId: randomUUID(), role: 'reference_image', position: 0 },
        { assetId: randomUUID(), role: 'reference_image', position: 1 },
      ],
    },
  }
  const outcome = await executeTool({
    store: f.store,
    ctx: f.store.ctx,
    actor,
    call,
    scene: f.store.ctx.canvas.scene,
    signal: new AbortController().signal,
    create: f.create,
  })
  assert.ok(outcome.pending)
  assert.equal(outcome.pending?.requestVersion, 2)
  assert.equal(outcome.pending?.kind, 'image')
  assert.equal(outcome.pending?.normalizedInputs?.length, 2)
  assert.equal(outcome.pending?.normalizedInputs?.[0]?.role, 'reference_image')
  assert.equal(outcome.pending?.normalizedInputs?.[1]?.position, 1)
 })

 test('executeTool handles generate_video with first_frame input', async () => {
  const f = fixture()
  f.store.savedAsset = assetId
  f.store.ctx.canvas.scene = {
    nodes: [{ id: sourceNodeId, type: 'image', position: { x: 0, y: 0 }, data: { assetId } }],
    edges: [],
  }
  const call: LanguageModelChatToolCall = {
    id: 'call_video',
    name: 'generate_video',
    arguments: {
      prompt: 'cat moving',
      modelId,
      parameters: {},
      sourceNodeId,
    },
  }
  const outcome = await executeTool({
    store: f.store,
    ctx: f.store.ctx,
    actor,
    call,
    scene: f.store.ctx.canvas.scene,
    signal: new AbortController().signal,
    create: f.create,
  })
  assert.ok(outcome.pending)
  assert.equal(outcome.pending?.requestVersion, 2)
  assert.equal(outcome.pending?.kind, 'video')
  assert.equal(outcome.pending?.normalizedInputs?.[0]?.role, 'first_frame')
 })

test('executeTool enforces explicit model, parameters, intent and complete first/last input identity', async () => {
  const f = fixture(), inputId = randomUUID(), tail = randomUUID()
  f.store.ctx.context = { intent: 'generate', modelId, parameters: { count: 1 }, inputs: [{ assetId: inputId, role: 'first_frame', position: 0 }, { uploadId: tail, role: 'last_frame', position: 1 }] }
  const originalModel = f.store.mediaModel.bind(f.store)
  f.store.mediaModel = async (id, kind) => {
    const model = await originalModel(id, kind)
    if (kind === 'video') model.capabilities.inputSlots.push({ role: 'last_frame', required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'] })
    return model
  }
  const base = { store: f.store, ctx: f.store.ctx, actor, scene: empty, signal: new AbortController().signal, create: f.create }
  const call: LanguageModelChatToolCall = { id: 'explicit', name: 'generate_video', arguments: { modelId, prompt: 'video' } }
  for (const changed of [{ modelId: randomUUID() }, { parameters: { count: 2 } }, { inputs: [{ assetId: inputId, role: 'first_frame', position: 0 }] }]) {
    await assert.rejects(executeTool({ ...base, call: { ...call, arguments: { ...call.arguments, ...changed } } }), AgentError)
  }
  await assert.rejects(executeTool({ ...base, call: { id: 'edit', name: 'edit_image', arguments: { modelId, prompt: 'edit', selection: { x: 0, y: 0, width: 32, height: 32 } } } }), AgentError)
  const result = await executeTool({ ...base, call })
  assert.deepEqual(result.pending!.normalizedInputs, f.store.ctx.context.inputs)
  assert.equal(result.pending!.normalizedRequest!.mode, 'image_to_video')
  assert.equal(f.store.createCount, 0)
})

test('new managed/context requests cannot opt out of costly confirmation and reentry verifies payload', async () => {
  const f = fixture(); f.store.ctx.requireConfirmation = false; f.store.ctx.context = { modelId, parameters: { count: 1 } }
  const base = { store: f.store, ctx: f.store.ctx, actor, scene: empty, signal: new AbortController().signal, create: f.create }
  const first = await executeTool({ ...base, call: generation('frozen') })
  const expiry = first.pending!.expiresAt
  const replay = await executeTool({ ...base, call: generation('frozen') })
  assert.equal(replay.pending!.id, first.pending!.id); assert.equal(replay.pending!.expiresAt, expiry)
  await assert.rejects(executeTool({ ...base, call: { ...generation('frozen'), arguments: { ...generation('frozen').arguments, prompt: 'different' } } }), AgentError)
  assert.equal(f.store.createCount, 0)
})

test('normalization refuses to drop a user explicit parameter hidden by dependency', async () => {
  const f = fixture(); f.store.ctx.context = { parameters: { compression: 82 } }
  const mediaModel = f.store.mediaModel.bind(f.store)
  f.store.mediaModel = async (id, kind) => {
    const model = await mediaModel(id, kind)
    model.capabilities.parameters.push({ name: 'format', type: 'enum', options: ['png', 'jpeg'], defaultValue: 'png' }, { name: 'compression', type: 'integer', min: 0, max: 100, dependsOn: { parameter: 'format', values: ['jpeg'] } })
    return model
  }
  await assert.rejects(executeTool({ store: f.store, ctx: f.store.ctx, actor, call: generation(), scene: empty, signal: new AbortController().signal, create: f.create }), AgentError)
  assert.equal(f.store.pendingMap.size, 0)
})

test('edit tool uses explicit source/selection, runtime credential digest, fixed-point parameters and prepared metadata; replay never re-prepares', async () => {
  const f = fixture()
  const selected = { x: -10, y: 15, width: 130, height: 100 }, clamped = { x: 0, y: 15, width: 120, height: 100 }
  f.store.ctx.context = { intent: 'edit', modelId, parameters: { count: 1 }, editSource: { assetId, selection: selected } }
  const mediaModel = f.store.mediaModel.bind(f.store)
  f.store.mediaModel = async (id, kind) => {
    const model = await mediaModel(id, kind)
    model.capabilities.parameters.push({ name: 'size', type: 'enum', options: ['1536x1024'], defaultValue: '1536x1024' })
    return model
  }
  let prepares = 0
  const prepare: NonNullable<Parameters<typeof executeTool>[0]['prepare']> = async input => {
    prepares++; assert.equal(input.assetId, assetId); assert.deepEqual(input.selection, selected)
    return { success: true, data: { model: { provider_credential_id: randomUUID() }, capabilities: (await f.store.mediaModel(modelId, 'image')).capabilities,
      prompt: 'Edit only the selected region of the image, as indicated by the mask. Keep all other areas unchanged. Preserve composition, lighting, perspective, and style unless explicitly requested.\n\nChange',
      parameters: { count: 1, size: '1536x1024' }, inputs: [{ assetId, role: 'reference_image', position: 0 }, { uploadId: input.reservedMask!.uploadId, role: 'mask', position: 1 }],
      sourceChecksum: 'c'.repeat(64), source: { width: 1200, height: 800 }, selection: clamped,
      artifacts: { source: null, mask: { checksum: 'd'.repeat(64), width: 1200, height: 800, sizeBytes: 1024 } } } }
  }
  const { buildInpaintPrompt } = await import('@musecanvas/contracts')
  const wrappedPrepare: typeof prepare = async input => {
    const result = await prepare(input)
    if (result.success) result.data.prompt = buildInpaintPrompt(input.prompt)
    return result
  }
  const base = { store: f.store, ctx: f.store.ctx, actor, scene: empty, signal: new AbortController().signal, create: f.create, prepare: wrappedPrepare }
  const call: LanguageModelChatToolCall = { id: 'edit-frozen', name: 'edit_image', arguments: { modelId, prompt: 'Change', selection: selected } }
  await assert.rejects(executeTool({ ...base, call: { ...call, arguments: { ...call.arguments, selection: { ...selected, width: 100 } } } }), AgentError)
  assert.equal(prepares, 0)
  const result = await executeTool({ ...base, call })
  assert.equal(result.pending!.modelConfigDigest, f.store.modelDigest)
  assert.equal(result.pending!.normalizedRequest!.mode, 'inpaint')
  assert.deepEqual(result.pending!.editMetadata, { selection: clamped, sourceWidth: 1200, sourceHeight: 800 })
  const replay = await executeTool({ ...base, call })
  assert.equal(prepares, 1); assert.equal(replay.pending!.expiresAt, result.pending!.expiresAt)
  assert.deepEqual(replay.pending!.normalizedRequest, result.pending!.normalizedRequest)
})

test('submitting reentry publishes persisted facts only, including legacy explicit confirmation opt-out; no model/create retry', async () => {
  const f = fixture([chatResult('', [generation()])])
  await (await f.handlers.messages(context(request({ requireConfirmation: false })))).text()
  const pending = [...f.store.pendingMap.values()][0]!
  assert.equal(f.store.createCount, 1, 'initial legacy explicit opt-out remains compatible')
  pending.status = 'submitting'; f.store.ctx.pending = [pending]; f.store.ctx.leaseReleased = false
  const events: any[] = []
  await runAgent({ store: f.store, ctx: f.store.ctx, actor, chat: async () => assert.fail('no reentry model'), create: async () => assert.fail('no reentry create'), signal: new AbortController().signal, send: event => events.push(event) })
  assert.equal(events.find(event => event.type === 'pending_jobs').pendingJobs[0].status, 'submitting')
  assert.equal(f.store.createCount, 1)
})

test('interrupted edit reentry uses recorded tool ID and frozen preparation without a model/new costly job', async () => {
  const f = fixture(), call = { id: 'recorded-edit', name: 'generate_image', arguments: { modelId, prompt: 'Recovered proposal', parameters: { count: 1 } } }
  await f.store.recordRound(f.store.ctx, { role: 'assistant', content: '', toolCalls: [call] })
  f.store.ctx.attemptedCalls = 1; f.store.ctx.requireConfirmation = false
  const events: any[] = []
  await runAgent({ store: f.store, ctx: f.store.ctx, actor, chat: async () => assert.fail('no fresh model call'), create: async () => assert.fail('no automatic media job'), signal: new AbortController().signal, send: event => events.push(event) })
  const pending = events.find(event => event.type === 'confirm_required').pending
  assert.equal(pending.toolCallId, call.id); assert.equal(f.store.createCount, 0)
})
