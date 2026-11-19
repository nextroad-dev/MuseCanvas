import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import { AgentCoreError, type AgentCoreClient } from '@musecanvas/database'
import type { AgentApprovalSummaryDTO, AgentEventsPageDTO, AgentMessageAcceptedDTO, AgentSessionDTO, AgentTurnDTO } from '@musecanvas/contracts'
import { createAgentHandlers } from './handlers'
import { type AgentControlPort, validateAgentDefinition } from './service'
import { approvalInput, boundedBody, createSessionInput, definitionBudget, emptyInput, eventCursor, messageInput, pageQuery, storageString, uuid } from './validation'
import { agentReplay } from './sse'
import { agentCoreAdmissionReady, agentCoreEnabled, agentCorePathDisabled } from './feature'
import { db } from '@musecanvas/database'
import { dispatchDelete, dispatchGet, dispatchPatch, dispatchPost, dispatchPut } from '../../router/pipeline'
import { matchRoute } from '../../router/match'
import { GET_ROUTES, POST_ROUTES } from '../../router/routes'

function flag(t: TestContext, key: 'AGENT_CORE_ENABLED' | 'AGENT_CORE_ADMISSION_READY', value: string) {
  const before = process.env[key]
  process.env[key] = value
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before })
}
const id = '123e4567-e89b-12d3-a456-426614174000'
const other = '223e4567-e89b-12d3-a456-426614174000'
const actor = { id, email: 'test@example.invalid', status: 'active' as const, role: 'user' as const, createdAt: '2026-11-17T08:00:00Z' }
const turn: AgentTurnDTO = { id, sessionId: id, status: 'queued', engineVersion: 'agent-core-v1', revision: '1', inputRevision: '1',
  cancelRequestedAt: null, terminalAt: null, deadlineAt: '2026-11-17T08:05:00Z', error: null }
const accepted: AgentMessageAcceptedDTO = { turn, acceptedInputRevision: '1' }
const emptyPage: AgentEventsPageDTO = { events: [], highWater: '0', retentionFloor: '0', hasMore: false, resyncRequired: false }
function request(path = `agent/sessions/${id}/messages`, body: unknown = { clientMessageId: id, content: 'hello' }, method = 'POST', headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new NextRequest(`https://muse.test/api/${path}`, { method, headers: { host: 'muse.test', origin: 'https://muse.test', 'content-type': 'application/json', ...headers },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal })
}
function harness(overrides: Partial<AgentControlPort> = {}, options: { enabled?: boolean; ready?: (actorId: string) => boolean; unauthorized?: boolean; disabled?: boolean; rate?: boolean } = {}) {
  const calls: string[] = []
  const unavailable = async (): Promise<never> => { calls.push('unexpected'); throw new Error('unexpected repository call') }
  const port: AgentControlPort = { createSession: unavailable, listSessions: unavailable, snapshot: unavailable, items: unavailable, events: unavailable,
    message: unavailable, steer: unavailable, getTurn: unavailable, cancel: unavailable, resolveApproval: unavailable, ...overrides }
  const h = createAgentHandlers({ control: port, enabled: () => options.enabled ?? true,
    admissionReady: actorId => { calls.push(`admission:${actorId}`); return options.ready?.(actorId) ?? false },
    authorize: async () => { calls.push('auth'); return options.unauthorized ? NextResponse.json({}, { status: 401 }) : { ...actor, status: options.disabled ? 'disabled' : 'active' } },
    limited: async () => { calls.push('rate'); return options.rate ?? false } })
  return { h, calls }
}

test('agent: disabled handler gate answers every operation 404 before auth/rate/body/DB', async () => {
  const { h, calls } = harness({}, { enabled: false })
  for (const handler of Object.values(h)) {
    const response = await handler({ request: request('agent/bad', null, 'POST', { origin: 'https://evil.invalid' }), params: { id: 'malformed' } })
    assert.equal(response.status, 404)
  }
  assert.deepEqual(calls, [])
})
test('agent: feature flags accept only exact true and narrow namespace excludes all legacy routes', t => {
  flag(t, 'AGENT_CORE_ENABLED', 'TRUE'); flag(t, 'AGENT_CORE_ADMISSION_READY', '1')
  assert.equal(agentCoreEnabled(), false); assert.equal(agentCoreAdmissionReady(actor.id), false)
  for (const path of ['agent', 'agent/sessions', 'agent/unknown', 'agent/turns/bad!']) assert.equal(agentCorePathDisabled(path), true)
  for (const path of ['canvas-agent/status', `canvases/${id}/agent/messages`, 'agents', 'agentx']) assert.equal(agentCorePathDisabled(path), false)
})
test('agent: pipeline disabled namespace returns 404 for bad Origin, unknown paths and unauth without DB/Redis IO', async t => {
  flag(t, 'AGENT_CORE_ENABLED', 'false')
  const pool = db()
  const query = t.mock.method(pool, 'query', () => { throw new Error('DB must not be queried') })
  const connect = t.mock.method(pool, 'connect', () => { throw new Error('DB must not connect') })
  for (const dispatch of [dispatchGet, dispatchPost, dispatchPatch, dispatchPut, dispatchDelete]) {
    for (const path of ['agent', 'agent/unknown', 'agent/sessions', 'agent/turns/bad!', 'images/edit/preparations']) {
      const r = request(path, {}, 'POST', { origin: 'https://evil.invalid', cookie: 'muse_session=disabled-feature' })
      assert.equal((await dispatch(r, path)).status, 404)
    }
  }
  assert.equal(query.mock.callCount(), 0); assert.equal(connect.mock.callCount(), 0)
})
test('agent: enabled pipeline preserves Origin and authentication guards', async t => {
  flag(t, 'AGENT_CORE_ENABLED', 'true')
  assert.equal((await dispatchPost(request('agent/sessions', {}, 'POST', { origin: 'https://evil.invalid' }), 'agent/sessions')).status, 403)
  assert.equal((await dispatchGet(request('agent/sessions', null, 'GET'), 'agent/sessions')).status, 401)
  assert.equal((await dispatchPost(request('images/edit/preparations', {}, 'POST', { origin: 'https://evil.invalid' }), 'images/edit/preparations')).status, 403)
  assert.equal((await dispatchPost(request('images/edit/preparations', {}, 'POST'), 'images/edit/preparations')).status, 401)
})
test('agent: uppercase UUID routes reach HTTP handlers and normalize IDs, preserving literal paths and legacy routes', async t => {
  flag(t, 'AGENT_CORE_ENABLED', 'true')
  const upper = id.toUpperCase()
  for (const routes of [GET_ROUTES, POST_ROUTES]) {
    for (const route of routes.filter(r => r.path.startsWith('agent/') && r.path.includes(':id') && !r.path.includes(':artifactId'))) {
      const path = route.path.replace(':id', upper)
      const matched = matchRoute(routes, path)
      assert.equal(matched?.route.path, route.path)
      assert.deepEqual(matched?.params, { id: upper })
    }
  }
  const path = `agent/turns/${upper}`
  assert.equal((await dispatchGet(request(path, null, 'GET'), path)).status, 401)
  const { h } = harness({ getTurn: async (_owner, target) => { assert.equal(target, id); return turn } })
  const matched = matchRoute(GET_ROUTES, path)!
  const response = await h.turn({ request: request(path, null, 'GET'), params: matched.params })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.id, id)
  assert.equal(matchRoute(GET_ROUTES, `canvases/${upper}/agent/history`), null)
  assert.equal(matchRoute(GET_ROUTES, `Agent/turns/${upper}`), null)
})

test('agent: active-owner auth, limiter, 400 validation and generic owner 404 are mapped without executing tools', async () => {
  const unauth = harness({}, { unauthorized: true }); assert.equal((await unauth.h.turn({ request: request('agent/turns/x', null, 'GET'), params: { id } })).status, 401)
  assert.deepEqual(unauth.calls, ['auth'])
  const disabled = harness({}, { disabled: true }); assert.equal((await disabled.h.turn({ request: request('agent/turns/x', null, 'GET'), params: { id } })).status, 403)
  const rate = harness({}, { rate: true }); assert.equal((await rate.h.turn({ request: request('agent/turns/x', null, 'GET'), params: { id } })).status, 429)
  const invalid = harness(); assert.equal((await invalid.h.message({ request: request(undefined, { clientMessageId: 'no', content: '' }), params: { id } })).status, 400)
  const shadow = harness()
  assert.equal((await shadow.h.message({ request: request(undefined, { clientMessageId: id, content: 'hello' }, 'POST', { 'idempotency-key': 'shadow' }), params: { id } })).status, 400)
  const foreign = harness({ getTurn: async (owner, target) => { assert.equal(owner, actor.id); assert.equal(target, other); throw new AgentCoreError('NOT_FOUND') } })
  const absent = await foreign.h.turn({ request: request(`agent/turns/${other}`, null, 'GET'), params: { id: other } })
  assert.equal(absent.status, 404); assert.equal((await absent.json()).error.code, 'NOT_FOUND')
})
test('agent: 202 message/steer/cancel, digest 409 and admission-closed replay/control reach injected repository with no new-turn permission', async () => {
  let admissions: boolean | undefined
  const { h } = harness({ message: async (_owner, _session, input, admit) => { assert.equal(input.content, 'hello'); admissions = admit; return accepted },
    steer: async () => accepted, cancel: async () => turn, createSession: async (_owner, _input, admit) => { assert.equal(admit, false); throw new AgentCoreError('UNAVAILABLE') } })
  assert.equal((await h.message({ request: request(), params: { id } })).status, 202); assert.equal(admissions, false)
  assert.equal((await h.steer({ request: request(`agent/turns/${id}/steer`), params: { id } })).status, 202)
  assert.equal((await h.cancel({ request: request(`agent/turns/${id}/cancel`, {}), params: { id } })).status, 202)
  assert.equal((await h.createSession({ request: request('agent/sessions', { clientRequestId: 'key', agentDefinitionId: id, definitionVersion: 1 }), params: {} })).status, 503)
  const conflict = harness({ message: async () => { throw new AgentCoreError('CONFLICT') } })
  assert.equal((await conflict.h.message({ request: request(), params: { id } })).status, 409)
})
test('agent: createSession and message evaluate admission for the authenticated actor and forward both decisions', async () => {
  const session = { id } as AgentSessionDTO
  for (const ready of [false, true]) {
    const { h, calls } = harness({
      createSession: async (owner, _input, admit) => { assert.equal(owner, actor.id); assert.equal(admit, ready); return session },
      message: async (owner, sessionId, _input, admit) => { assert.equal(owner, actor.id); assert.equal(sessionId, other); assert.equal(admit, ready); return accepted },
    }, { ready: actorId => { assert.equal(actorId, actor.id); return ready } })
    assert.equal((await h.createSession({ request: request('agent/sessions', { clientRequestId: 'key', agentDefinitionId: id, definitionVersion: 1 }), params: {} })).status, 202)
    assert.equal((await h.message({ request: request(`agent/sessions/${other}/messages`), params: { id: other } })).status, 202)
    assert.deepEqual(calls.filter(call => call.startsWith('admission:')), [`admission:${actor.id}`, `admission:${actor.id}`])
  }
})
test('agent: closed admission keeps reads, steer, cancel, approval and events accessible without evaluating rollout', async t => {
  const session = { id } as AgentSessionDTO
  const ac = new AbortController()
  t.after(() => ac.abort())
  const { h, calls } = harness({
    listSessions: async () => ({ sessions: [session], nextCursor: null }),
    snapshot: async () => ({ session, activeTurn: turn, items: [], eventCursor: '0', lastItemSequence: '0', itemsHasMore: false, nextItemsCursor: '0', tools: [], approvals: [], summariesTruncated: false }),
    items: async () => ({ items: [], nextCursor: '0', hasMore: false, lastItemSequence: '0' }),
    getTurn: async () => turn, steer: async () => accepted, cancel: async () => turn,
    resolveApproval: async () => ({ approval: { id, status: 'approved' } as AgentApprovalSummaryDTO, expired: false }),
    events: async () => emptyPage,
  }, { enabled: true, ready: () => false })
  assert.equal((await h.listSessions({ request: request('agent/sessions', null, 'GET'), params: {} })).status, 200)
  assert.equal((await h.snapshot({ request: request(`agent/sessions/${id}`, null, 'GET'), params: { id } })).status, 200)
  assert.equal((await h.items({ request: request(`agent/sessions/${id}/items`, null, 'GET'), params: { id } })).status, 200)
  assert.equal((await h.turn({ request: request(`agent/turns/${id}`, null, 'GET'), params: { id } })).status, 200)
  assert.equal((await h.steer({ request: request(`agent/turns/${id}/steer`), params: { id } })).status, 202)
  assert.equal((await h.cancel({ request: request(`agent/turns/${id}/cancel`, {}), params: { id } })).status, 202)
  assert.equal((await h.resolveApproval({ request: request(`agent/approvals/${id}/resolve`, { decision: 'approved', expectedArgumentsHash: 'a'.repeat(64) }), params: { id } })).status, 202)
  const response = await h.events({ request: request(`agent/sessions/${id}/events`, null, 'GET', {}, ac.signal), params: { id } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  await response.body!.cancel()
  assert.deepEqual(calls.filter(call => call.startsWith('admission:')), [])
})
test('agent: create/list/detail/items expose bounded query and snapshot ports and 202 create', async () => {
  const session = { id } as AgentSessionDTO
  const { h } = harness({ createSession: async () => session, listSessions: async (_o, limit) => { assert.equal(limit, 1); return { sessions: [session], nextCursor: null } },
    snapshot: async () => ({ session, activeTurn: null, items: [], eventCursor: '5', lastItemSequence: '4', itemsHasMore: true, nextItemsCursor: '1', tools: [], approvals: [], summariesTruncated: false }),
    items: async (_o, _i, cursor) => { assert.equal(cursor, '9007199254740993'); return { items: [], nextCursor: cursor as `${bigint}`, hasMore: false, lastItemSequence: cursor as `${bigint}` } } }, { ready: () => true })
  assert.equal((await h.createSession({ request: request('agent/sessions', { clientRequestId: 'key', agentDefinitionId: id, definitionVersion: 1 }), params: {} })).status, 202)
  assert.equal((await h.listSessions({ request: request('agent/sessions?limit=1', null, 'GET'), params: {} })).status, 200)
  assert.equal((await (await h.snapshot({ request: request(`agent/sessions/${id}`, null, 'GET'), params: { id } })).json()).data.itemsHasMore, true)
  assert.equal((await h.items({ request: request(`agent/sessions/${id}/items?cursor=9007199254740993`, null, 'GET'), params: { id } })).status, 200)
})
test('agent: approval expiry commits via port and is returned as 409 with visible state; decision 202', async () => {
  const a = { id, status: 'expired' } as any
  const expired = harness({ resolveApproval: async () => ({ approval: a, expired: true }) })
  const response = await expired.h.resolveApproval({ request: request(`agent/approvals/${id}/resolve`, { decision: 'approved', expectedArgumentsHash: 'a'.repeat(64) }), params: { id } })
  assert.equal(response.status, 409); assert.equal((await response.json()).data.status, 'expired')
  const approved = harness({ resolveApproval: async () => ({ approval: a, expired: false }) })
  assert.equal((await approved.h.resolveApproval({ request: request(`agent/approvals/${id}/resolve`, { decision: 'approved', expectedArgumentsHash: 'a'.repeat(64) }), params: { id } })).status, 202)
})
test('agent: parsers reject malformed UUID/body/unknown fields/cursors/header conflicts and bigint overflow', () => {
  for (const value of ['x', id + 'x', null, 1]) assert.throws(() => uuid(value), AgentCoreError)
  for (const value of [[], null, {}, { clientMessageId: id, content: 'ok', config: {} }, { clientMessageId: id, content: ' ' }, { clientMessageId: id, content: '\0' }]) assert.throws(() => messageInput(value), AgentCoreError)
  for (const value of ['\uD800', '\uDC00', 'x'.repeat(32001)]) assert.throws(() => storageString(value, 32000), AgentCoreError)
  assert.equal(storageString('你好😀', 100), '你好😀')
  assert.throws(() => createSessionInput({ clientRequestId: '', agentDefinitionId: id, definitionVersion: 1 }), AgentCoreError)
  assert.throws(() => approvalInput({ decision: 'yes', expectedArgumentsHash: 'a'.repeat(64) }), AgentCoreError)
  assert.throws(() => emptyInput({ turnId: id }), AgentCoreError)
  for (const q of ['limit=0', 'limit=101', 'limit=01', 'limit=1&limit=2', 'cursor=1e3', 'cursor=01', 'cursor=9223372036854775808', 'other=1']) assert.throws(() => pageQuery(new URL(`https://muse.test/?${q}`), 'items'), AgentCoreError)
  assert.equal(eventCursor(id, '9007199254740993', `${id}:9007199254740993`), '9007199254740993')
  for (const header of ['1', `${other}:1`, `${id}:01`, `${id}:1:2`]) assert.throws(() => eventCursor(id, undefined, header), AgentCoreError)
  assert.throws(() => eventCursor(id, '2', `${id}:1`), { code: 'CONFLICT' })
})
test('agent: bounded body counts streamed bytes, checks JSON object at parser boundary and cancels oversized input', async () => {
  await assert.rejects(boundedBody(request(undefined, {}, 'POST', { 'content-length': '40001' })), { code: 'INVALID_INPUT' })
  await assert.rejects(boundedBody(request(undefined, {}, 'POST', { 'content-type': 'text/plain' })), { code: 'INVALID_INPUT' })
  await assert.rejects(boundedBody(request(undefined, 'x'.repeat(40001))), { code: 'INVALID_INPUT' })
  const malformed = new Request('https://muse.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
  await assert.rejects(boundedBody(malformed), { code: 'INVALID_INPUT' })
  const abort = new AbortController(); abort.abort()
  await assert.rejects(boundedBody(request(undefined, {}, 'POST', {}, abort.signal)), { code: 'INVALID_INPUT' })
})
const budget = { maxModelCalls: 2, maxToolCalls: 2, maxMediaJobs: 0, maxMediaOutputs: 0, maxInputTokens: '100', maxOutputTokens: '100', maxEstimatedCost: null, maxConcurrentMediaJobs: 0, timeoutMs: 30000 }
const definition = { id, version: 1, instructions: 'Help the user.', tool_allowlist: ['list_models@v1'], model_policy: { modelConfigId: id, modelRevisionId: other }, budget_policy: budget }
const model = { id, language_protocol: 'openai_chat', plugin_id: 'openai-language', plugin_version: '1.0.0', plugin_source: 'builtin', vendor_model_id: 'gpt-test', max_output_tokens: 100,
  temperature: '0.5', reasoning_effort: null, latest_revision_id: other, revision_id: other, revision: 3, provider_id: 'openai', revision_plugin_id: 'openai-language', revision_plugin_version: '1.0.0', revision_vendor_model_id: 'gpt-test' }
test('agent: definition uses explicit safe model revision and relative server budget; snapshots cannot copy provider URLs/credentials/private JSON', async () => {
  let sql = ''
  const client = { query: async (q: string) => { sql = q; return { rows: [{ ...model, base_url: 'https://private.invalid', credential: 'SECRET', defaults: { secret: 'SECRET' } }] } } } as unknown as AgentCoreClient
  const snapshot = await validateAgentDefinition(client, definition)
  assert.equal(snapshot.timeoutMs, 30000); assert.equal(snapshot.config.modelRevisionId, other)
  assert.equal('deadlineAt' in snapshot.budget, false)
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|private.invalid|defaults|credential/)
  assert.doesNotMatch(sql, /base_url|credential|capabilities|defaults/)
  assert.match(sql, /r.id=\$2 AND r.model_id=m.id/)
  for (const invalid of [{ ...budget, deadlineAt: '2000-01-01' }, { ...budget, timeoutMs: 0 }, { ...budget, timeoutMs: 300001 }, { ...budget, maxToolCalls: -1 }]) assert.throws(() => definitionBudget(invalid), AgentCoreError)
})
test('agent: unsupported, disabled/unavailable, wrong revision model and invalid definition fail closed before admission', async () => {
  for (const row of [null, { ...model, language_protocol: 'openai_responses' }, { ...model, plugin_version: '9.0.0' }, { ...model, plugin_source: 'installed' }, { ...model, latest_revision_id: id },
    { ...model, revision_plugin_id: 'other' }, { ...model, vendor_model_id: 'https://secret.invalid' }, { ...model, language_protocol: 'anthropic_messages' },
    { ...model, language_protocol: 'anthropic_messages', plugin_id: 'anthropic-language', revision_plugin_id: 'anthropic-language', reasoning_effort: 'high' }]) {
    const client = { query: async () => ({ rows: row ? [row] : [] }) } as unknown as AgentCoreClient
    await assert.rejects(validateAgentDefinition(client, definition), { code: 'UNAVAILABLE' })
  }
})
function event(cursor: `${bigint}`) {
  return { schemaVersion: 1 as const, eventId: id, sessionId: id, turnId: id, type: 'turn.updated' as const,
    createdAt: actor.createdAt, cursor, itemSequence: null, entityRevision: '1' as const, payload: { turn } }
}
test('agent: SSE validates cursor before opening, replays session-bound IDs and abort removes subscription timers without cancellation', async () => {
  const ac = new AbortController(); let polls = 0
  const first = { ...emptyPage, highWater: '1' as const, events: [event('1')] }
  const response = agentReplay({ sessionId: id, cursor: '0', first, signal: ac.signal, pollMs: 1, heartbeatMs: 2, lifetimeMs: 1000,
    poll: async cursor => { polls++; assert.equal(cursor, '1'); return { ...emptyPage, highWater: '1' } } })
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform')
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  assert.match(decoder.decode((await reader.read()).value), /event: ready/)
  const data = decoder.decode((await reader.read()).value)
  assert.match(data, new RegExp(`id: ${id}:1`)); assert.match(data, /event: turn.updated\ndata: /)
  const heartbeat = decoder.decode((await reader.read()).value); assert.match(heartbeat, /event: heartbeat/)
  ac.abort(); await reader.read()
  const previous = polls; await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(polls, previous)
})
test('agent: SSE finite close, retention/gap and bounded backlog resync do not silently advance cursor', async () => {
  for (const first of [{ ...emptyPage, resyncRequired: true }, { ...emptyPage, highWater: '2' as const, events: [event('2')] }]) {
    const response = agentReplay({ sessionId: id, cursor: '0', first, signal: new AbortController().signal, poll: async () => emptyPage, lifetimeMs: 50 })
    const text = await response.text(); assert.match(text, /event: resync.required/); assert.match(text, new RegExp(`id: ${id}:0`))
  }
  const backlog = agentReplay({ sessionId: id, cursor: '0', first: { ...emptyPage, highWater: '2', events: [event('1'), event('2')] },
    signal: new AbortController().signal, maxEvents: 1, poll: async () => emptyPage, lifetimeMs: 50 })
  const text = await backlog.text(); assert.match(text, /"reason":"backlog"/); assert.doesNotMatch(text, new RegExp(`id: ${id}:2`))
  const finite = agentReplay({ sessionId: id, cursor: '0', first: emptyPage, signal: new AbortController().signal, poll: async () => emptyPage, lifetimeMs: 5, pollMs: 1 })
  assert.match(await finite.text(), /event: ready/)
})
test('agent: SSE handler rejects Last-Event-ID/query conflict and ahead cursor before returning stream; restored cursor goes to read port', async () => {
  let calls = 0
  const ac = new AbortController()
  const { h } = harness({ events: async (_o, _i, cursor) => { calls++; if (cursor === '9') throw new AgentCoreError('CURSOR_AHEAD'); assert.equal(cursor, '5'); return { ...emptyPage, highWater: '5' } } })
  const conflict = await h.events({ request: request(`agent/sessions/${id}/events?cursor=2`, null, 'GET', { 'last-event-id': `${id}:1` }), params: { id } })
  assert.equal(conflict.status, 409); assert.equal(calls, 0)
  assert.equal((await h.events({ request: request(`agent/sessions/${id}/events?cursor=9`, null, 'GET'), params: { id } })).status, 409)
  const response = await h.events({ request: request(`agent/sessions/${id}/events`, null, 'GET', { 'last-event-id': `${id}:5` }, ac.signal), params: { id } })
  assert.equal(response.status, 200); ac.abort(); await response.body!.cancel()
})
