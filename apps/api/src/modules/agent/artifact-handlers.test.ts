import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import { API_ENDPOINTS, type AgentArtifactThreadDTO } from '@musecanvas/contracts'
import { AgentCoreError, db } from '@musecanvas/database'
import { createAgentArtifactHandlers, type AgentArtifactsPort } from './artifact-handlers'
import { GET_ROUTES, PATCH_ROUTES, POST_ROUTES } from '../../router/routes'
import { matchRoute } from '../../router/match'
import { dispatchGet, dispatchPatch, dispatchPost } from '../../router/pipeline'

const id = '123e4567-e89b-12d3-a456-426614174000'
const other = '223e4567-e89b-12d3-a456-426614174000'
const aid = `text:${other}`
const actor = { id, email: 'artifact@example.invalid', status: 'active' as const, role: 'user' as const, createdAt: '2026-11-19T11:00:00.000Z' }
const thread: AgentArtifactThreadDTO = { id: other, artifactId: `text:${other}`, version: 1, anchor: { kind: 'whole' }, resolved: false, resolvedAt: null,
  createdAt: actor.createdAt, messages: [{ id, body: 'comment', createdAt: actor.createdAt }] }
const input = { clientRequestId: id, version: 1, anchor: { kind: 'whole' }, body: 'comment' }
const params = { id, artifactId: `text%3A${other}`, threadId: other }
function request(method = 'GET', body: unknown = input, query = '', headers: Record<string, string> = {}) {
  return new NextRequest(`https://muse.test/api/agent/sessions/${id}/artifacts/text%3A${other}/threads${query}`, {
    method, headers: { host: 'muse.test', origin: 'https://muse.test', 'content-type': 'application/json', ...headers },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
}
function fixture(overrides: Partial<AgentArtifactsPort> = {}, options: { enabled?: boolean; inactive?: boolean; unauthorized?: boolean; limited?: boolean } = {}) {
  const calls: string[] = []
  const unexpected = async (): Promise<never> => { calls.push('repository'); throw new Error('unexpected repository') }
  const artifacts: AgentArtifactsPort = { list: unexpected, detail: unexpected, threads: unexpected, thread: unexpected, createThread: unexpected, reply: unexpected, resolve: unexpected, ...overrides }
  const handlers = createAgentArtifactHandlers({ artifacts, enabled: () => options.enabled ?? true,
    authorize: async () => { calls.push('auth'); return options.unauthorized ? NextResponse.json({}, { status: 401 }) : { ...actor, status: options.inactive ? 'disabled' : 'active' } },
    limited: async (key, max, seconds) => { calls.push(`rate:${key}:${max}:${seconds}`); return options.limited ?? false },
  })
  return { handlers, calls }
}
test('artifact-handlers: disabled precedes origin, malformed input, authentication, rate and repository for every operation', async () => {
  const f = fixture({}, { enabled: false })
  for (const handler of Object.values(f.handlers)) assert.equal((await handler({ request: request('POST', null, '?bad=x', { origin: 'https://evil.invalid' }), params: { id: 'bad' } })).status, 404)
  assert.deepEqual(f.calls, [])
})
test('artifact-handlers: origin and actor guards precede repository and rate; writes use shared Agent rate budget', async () => {
  const csrf = fixture()
  assert.equal((await csrf.handlers.createThread({ request: request('POST', input, '', { origin: 'https://evil.invalid' }), params })).status, 403)
  assert.deepEqual(csrf.calls, [])
  for (const options of [{ inactive: true }, { unauthorized: true }]) {
    const f = fixture({}, options)
    assert.equal((await f.handlers.list({ request: request(), params })).status, options.inactive ? 403 : 401)
    assert.deepEqual(f.calls, ['auth'])
  }
  const rate = fixture({}, { limited: true })
  assert.equal((await rate.handlers.reply({ request: request('POST'), params })).status, 429)
  assert.equal(rate.calls[1], `rate:agent-core:write:${id}:30:60`)
  assert.equal((await rate.handlers.list({ request: request(), params })).status, 429)
  assert.equal(rate.calls.at(-1), `rate:agent-core:read:${id}:90:60`)
})
test('artifact-handlers: scope and encoded Artifact identity are normalized once and passed to the repository', async () => {
  const f = fixture({ createThread: async (owner, sid, artifactId, value) => {
    assert.deepEqual([owner, sid, artifactId], [id, id, aid]); assert.deepEqual(value, input); return thread
  } })
  const r = await f.handlers.createThread({ request: request('POST'), params: { id: id.toUpperCase(), artifactId: params.artifactId.toUpperCase() } })
  assert.equal(r.status, 202); assert.deepEqual((await r.json()).data, thread)
  for (const value of ['text%253A' + other, '%E0%A4%A', 'text%3A' + other + '%2Fextra']) {
    assert.equal((await f.handlers.detail({ request: request(), params: { id, artifactId: value } })).status, 400)
  }
})
test('artifact-handlers: strict headers, queries and payloads reject without repository calls', async () => {
  const invalidHeaders: Array<Record<string, string>> = [{ 'idempotency-key': id }, { 'last-event-id': `${id}:1` }]
  for (const headers of invalidHeaders) {
    const f = fixture()
    assert.equal((await f.handlers.list({ request: request('GET', undefined, '', headers), params })).status, 400)
    assert.deepEqual(f.calls, ['auth'])
  }
  for (const query of ['?owner=else', '?limit=101', '?limit=1&limit=2', '?cursor=']) {
    const f = fixture()
    assert.equal((await f.handlers.list({ request: request('GET', undefined, query), params })).status, 400)
    assert.equal(f.calls.includes('repository'), false)
  }
  for (const value of [{ ...input, version: 2 }, { ...input, body: ' ' }, { ...input, body: 'x'.repeat(8001) }, { ...input, ownerId: other }, { ...input, clientRequestId: 'not-a-uuid' }]) {
    const f = fixture()
    assert.equal((await f.handlers.createThread({ request: request('POST', value), params })).status, 400)
    assert.equal(f.calls.includes('repository'), false)
  }
  const f = fixture()
  assert.equal((await f.handlers.detail({ request: request('GET', undefined, '?limit=1'), params })).status, 400)
})
test('artifact-handlers: bounded stream parser is used before any artifact mutation', async () => {
  const f = fixture()
  const invalidContentHeaders: Array<Record<string, string>> = [{ 'content-length': '40001' }, { 'content-type': 'text/plain' }]
  for (const headers of invalidContentHeaders) {
    assert.equal((await f.handlers.createThread({ request: request('POST', input, '', headers), params })).status, 400)
  }
  assert.equal((await f.handlers.createThread({ request: request('POST', { ...input, body: 'x'.repeat(40001) }), params })).status, 400)
  assert.equal(f.calls.includes('repository'), false)
})
test('artifact-handlers: foreign scope is generic 404, conflicting request reuse 409, unexpected errors sanitized 503', async () => {
  for (const [error, status] of [[new AgentCoreError('NOT_FOUND'), 404], [new AgentCoreError('CONFLICT'), 409], [new Error('https://private.invalid/key credential'), 503]] as const) {
    const f = fixture({ detail: async () => { throw error } })
    const r = await f.handlers.detail({ request: request(), params })
    assert.equal(r.status, status); assert.doesNotMatch(await r.text(), /private|credential|key/)
  }
})
test('artifact-handlers: list, thread list, thread detail, reply and resolve return shared DTO envelopes', async () => {
  const f = fixture({ list: async (owner, sid, limit, cursor) => { assert.deepEqual([owner, sid, limit, cursor], [id, id, 2, 'opaque']); return { items: [], nextCursor: null } },
    threads: async (_owner, _sid, artifactId, limit) => { assert.equal(artifactId, aid); assert.equal(limit, 50); return { items: [thread], nextCursor: null } },
    thread: async (_owner, _sid, artifactId, threadId) => { assert.equal(artifactId, aid); assert.equal(threadId, other); return thread },
    reply: async (_owner, _sid, _aid, _tid, value) => { assert.deepEqual(value, { clientRequestId: id, body: 'reply' }); return thread },
    resolve: async (_owner, _sid, _aid, _tid, value) => ({ ...thread, resolved: value.resolved, resolvedAt: value.resolved ? actor.createdAt : null }),
  })
  assert.equal((await f.handlers.list({ request: request('GET', undefined, '?limit=2&cursor=opaque'), params })).status, 200)
  assert.equal((await f.handlers.threads({ request: request(), params })).status, 200)
  assert.equal((await f.handlers.thread({ request: request(), params })).status, 200)
  assert.equal((await f.handlers.reply({ request: request('POST', { clientRequestId: id, body: 'reply' }), params })).status, 202)
  for (const resolved of [true, false]) {
    const r = await f.handlers.resolve({ request: request('PATCH', { resolved }), params })
    assert.equal(r.status, 200); assert.equal((await r.json()).data.resolved, resolved)
  }
})
test('artifact-handlers: every shared endpoint routes encoded IDs and uppercase scope without changing legacy routes', () => {
  const upper = id.toUpperCase()
  const tests = [
    [GET_ROUTES, API_ENDPOINTS.agent.artifacts(upper)],
    [GET_ROUTES, API_ENDPOINTS.agent.artifact(upper, aid)],
    [GET_ROUTES, API_ENDPOINTS.agent.artifactThreads(upper, aid)],
    [GET_ROUTES, API_ENDPOINTS.agent.artifactThread(upper, aid, other.toUpperCase())],
    [POST_ROUTES, API_ENDPOINTS.agent.artifactThreads(upper, aid)],
    [POST_ROUTES, API_ENDPOINTS.agent.artifactThreadReplies(upper, aid, other.toUpperCase())],
    [PATCH_ROUTES, API_ENDPOINTS.agent.artifactThread(upper, aid, other.toUpperCase())],
  ] as const
  for (const [routes, path] of tests) {
    const route = matchRoute(routes, path.replace(/^\/api\//, ''))
    assert.ok(route, path); assert.equal(route.route.access, 'public'); assert.equal(route.params.id, upper)
  }
  assert.equal(matchRoute(GET_ROUTES, `jobs/${upper}`), null)
})
test('artifact-handlers: router feature-off applies before DB/Origin for GET, POST and PATCH Artifact paths', async t => {
  const before = process.env.AGENT_CORE_ENABLED
  process.env.AGENT_CORE_ENABLED = 'false'
  t.after(() => { if (before === undefined) delete process.env.AGENT_CORE_ENABLED; else process.env.AGENT_CORE_ENABLED = before })
  const pool = db()
  const query = t.mock.method(pool, 'query', () => { throw new Error('DB forbidden') })
  const connect = t.mock.method(pool, 'connect', () => { throw new Error('DB forbidden') })
  for (const dispatch of [dispatchGet, dispatchPost, dispatchPatch]) {
    const path = API_ENDPOINTS.agent.artifactThread(id, aid, other).replace(/^\/api\//, '')
    assert.equal((await dispatch(request('POST', null, '', { origin: 'https://evil.invalid' }), path)).status, 404)
  }
  assert.equal(query.mock.callCount(), 0); assert.equal(connect.mock.callCount(), 0)
})
