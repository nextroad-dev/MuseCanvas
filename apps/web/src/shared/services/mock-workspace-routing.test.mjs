import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { loadTs } from './mock-workspace-test-loader.mjs'

function makeAgentMockRecorder(calls, rejectGroup = null, error = new Error('mock failure')) {
  const methods = [
    'listSessions',
    'createSession',
    'getSnapshot',
    'listItems',
    'sendMessage',
    'steerTurn',
    'getTurn',
    'cancelTurn',
    'resolveApproval',
  ]
  return Object.fromEntries(
    methods.map((method) => [
      method,
      async (...args) => {
        calls.push(['agent', method, args])
        if (rejectGroup === 'agent') throw error
        return { demo: true }
      },
    ]),
  )
}

test('client API redirects only workspace methods and never falls through on mock rejection', async () => {
  const live = []
  const mocked = []
  const error = Error('unsupported demo input')
  const workspace = Object.fromEntries(Object.entries({
    models: ['list'], jobs: ['list', 'detail', 'cancel', 'retry', 'remove'], library: ['list', 'download', 'remove'],
  }).map(([group, names]) => [group, Object.fromEntries(names.map((method) => [method, async (...args) => {
    mocked.push([group, method, args])
    return { demo: true }
  }]))]))
  const endpoints = {
    session: '/session',
    models: '/models',
    media: { object: '/media/object', upload: '/media/upload' },
    generationUploads: { create: '/uploads' },
    agent: {
      sessions: '/api/agent/sessions',
      session: (id) => `/api/agent/sessions/${id}`,
      messages: (id) => `/api/agent/sessions/${id}/messages`,
      items: (id) => `/api/agent/sessions/${id}/items`,
      events: (id) => `/api/agent/sessions/${id}/events`,
      turn: (id) => `/api/agent/turns/${id}`,
      cancel: (id) => `/api/agent/turns/${id}/cancel`,
      steer: (id) => `/api/agent/turns/${id}/steer`,
      resolveApproval: (id) => `/api/agent/approvals/${id}/resolve`,
    },
  }
  const imports = {
    '@musecanvas/contracts': { API_ENDPOINTS: endpoints },
    './api': { apiFetch: async (...args) => { live.push(args); return { live: true } } },
    '../lib/workspace-mode': { WORKSPACE_MODE: 'mock' },
    './mock-workspace-api': { mockWorkspaceApi: workspace },
    './mock-agent-api': {
      mockAgentApi: makeAgentMockRecorder(mocked),
    },
  }
  const { clientApi } = loadTs(new URL('./client-api.ts', import.meta.url), imports)
  await clientApi.models.list()
  for (const method of ['list', 'detail', 'cancel', 'retry', 'remove']) await clientApi.jobs[method]('id')
  for (const method of ['list', 'download', 'remove']) await clientApi.library[method]('id')
  assert.equal(mocked.length, 9)
  assert.equal(live.length, 0)
  await clientApi.session.get()
  await clientApi.generationUploads.create({ mimeType: 'image/png', sizeBytes: 10 })
  assert.equal(live.length, 2)
  assert.equal(live[0][0], '/session')
  assert.equal(live[1][0], '/uploads')

  // Verify clientApi.agent.* routes cleanly to mock in WORKSPACE_MODE === 'mock'
  await clientApi.agent.listSessions({ limit: 10 })
  await clientApi.agent.createSession({ clientRequestId: 'r1', agentDefinitionId: 'd1', definitionVersion: 1 })
  await clientApi.agent.getSnapshot('s1', { limit: 20 })
  await clientApi.agent.listItems('s1', { cursor: '0', limit: 20 })
  await clientApi.agent.sendMessage('s1', { clientMessageId: 'm1', content: 'hi' })
  await clientApi.agent.steerTurn('t1', { clientMessageId: 'm2', content: 'steer' })
  await clientApi.agent.getTurn('t1')
  await clientApi.agent.cancelTurn('t1')
  await clientApi.agent.resolveApproval('a1', { decision: 'approved', expectedArgumentsHash: 'a'.repeat(64) })
  assert.equal(mocked.length, 18)
  assert.equal(live.length, 2)

  // Verify mock rejection never falls through to live apiFetch for agent methods
  const failingImports = {
    ...imports,
    './mock-agent-api': {
      mockAgentApi: makeAgentMockRecorder(mocked, 'agent', error),
    },
  }
  const failingMockClient = loadTs(new URL('./client-api.ts', import.meta.url), failingImports).clientApi
  await assert.rejects(failingMockClient.agent.createSession({ clientRequestId: 'r1', agentDefinitionId: 'd1', definitionVersion: 1 }), error)
  assert.equal(live.length, 2)

  const liveClient = loadTs(new URL('./client-api.ts', import.meta.url), {
    ...imports, '../lib/workspace-mode': { WORKSPACE_MODE: 'live' },
  }).clientApi
  await liveClient.models.list()
  assert.equal(mocked.length, 19)
  assert.equal(live.length, 3)

  // Verify live mode routing & exact backend body constraints for clientApi.agent.*
  await liveClient.agent.listSessions({ limit: 20, cursor: 's0' })
  await liveClient.agent.createSession({ clientRequestId: 'req-1', agentDefinitionId: 'def-1', definitionVersion: 1 })
  await liveClient.agent.getSnapshot('s1', { limit: 50 })
  await liveClient.agent.listItems('s1', { cursor: '5', limit: 30 })
  await liveClient.agent.sendMessage('s1', { clientMessageId: 'msg-1', content: 'hello' })
  await liveClient.agent.steerTurn('t1', { clientMessageId: 'msg-2', content: 'adjust' })
  await liveClient.agent.getTurn('t1')
  await liveClient.agent.cancelTurn('t1')
  await liveClient.agent.resolveApproval('a1', { decision: 'approved', expectedArgumentsHash: 'b'.repeat(64) })

  assert.equal(live.length, 12)
  const createCall = live[4]
  assert.equal(createCall[0], '/api/agent/sessions')
  assert.equal(createCall[1].method, 'POST')
  assert.equal(createCall[1].headers, undefined)

  const cancelCall = live[10]
  assert.equal(cancelCall[0], '/api/agent/turns/t1/cancel')
  assert.equal(cancelCall[1].method, 'POST')
  assert.deepEqual(cancelCall[1].body, {})
})

test('mockAgentApi executes seeded + full approval lifecycle locally without network', async () => {
  const prompts = JSON.parse(readFileSync(new URL('../../../public/showcase/showcase.json', import.meta.url), 'utf8'))
  const showcase = loadTs(new URL('../lib/showcase.ts', import.meta.url), {
    '../../../public/showcase/showcase.json': { default: prompts },
  })
  const data = loadTs(new URL('./mock-workspace-data.ts', import.meta.url), { '../lib/showcase': showcase })
  const api = loadTs(new URL('./api.ts', import.meta.url), { '@musecanvas/contracts': {} })
  const {
    MOCK_AGENT_DEFINITION_ID,
    MOCK_AGENT_EXECUTE_MS,
    MOCK_AGENT_PLAN_MS,
    MOCK_SEED_SESSION_ID,
    createMockAgentApi,
    mockAgentApi,
  } = loadTs(new URL('./mock-agent-api.ts', import.meta.url), {
    './api': api,
    './mock-workspace-data': data,
    '../lib/showcase': showcase,
  })

  // SSR facade never creates visitor-shared state
  assert.throws(() => mockAgentApi.listSessions(), { code: 'MOCK_BROWSER_ONLY' })

  let clock = 1_000_000
  const mem = new Map()
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  const agent = createMockAgentApi({ now: () => clock, storage })

  const list = await agent.listSessions()
  assert.equal(list.sessions.length, 1)
  assert.equal(list.sessions[0].id, MOCK_SEED_SESSION_ID)

  const created = await agent.createSession({
    clientRequestId: 'req-demo-1',
    agentDefinitionId: MOCK_AGENT_DEFINITION_ID,
    definitionVersion: 1,
  })
  const idempotent = await agent.createSession({
    clientRequestId: 'req-demo-1',
    agentDefinitionId: MOCK_AGENT_DEFINITION_ID,
    definitionVersion: 1,
  })
  assert.equal(idempotent.id, created.id)

  const accepted = await agent.sendMessage(created.id, {
    clientMessageId: '00000000-0000-4000-8000-000000000901',
    content: '生成一张温暖的极简木屋摄影',
  })
  assert.equal(accepted.turn.status, 'queued')

  clock += MOCK_AGENT_PLAN_MS
  const waitingSnap = await agent.getSnapshot(created.id)
  assert.equal(waitingSnap.activeTurn.status, 'waiting_approval')
  assert.equal(waitingSnap.approvals.length, 1)
  assert.match(waitingSnap.approvals[0].argumentsHash, /^[0-9a-f]{64}$/)

  await agent.steerTurn(waitingSnap.activeTurn.id, {
    clientMessageId: '00000000-0000-4000-8000-000000000902',
    content: '光线更柔和一些',
  })

  const approval = waitingSnap.approvals[0]
  const resolved = await agent.resolveApproval(approval.id, {
    decision: 'approved',
    expectedArgumentsHash: approval.argumentsHash,
  })
  assert.equal(resolved.status, 'approved')

  clock += MOCK_AGENT_EXECUTE_MS
  const doneSnap = await agent.getSnapshot(created.id)
  assert.equal(doneSnap.activeTurn, null)
  const artifact = doneSnap.items.find((item) => item.type === 'artifact_reference')
  assert.ok(artifact)
  assert.match(String(artifact.payload.url), /^\/showcase\//)

  // Verify persistence across reload, pagination, rejection, cancellation, and mock canvases
  const restored = createMockAgentApi({ now: () => clock, storage })
  const restoredSnap = await restored.getSnapshot(created.id)
  assert.equal(restoredSnap.items.length, doneSnap.items.length)

  const page1 = await restored.listItems(created.id, { cursor: '0', limit: 2 })
  assert.equal(page1.items.length, 2)
  assert.equal(page1.hasMore, true)
  const page2 = await restored.listItems(created.id, { cursor: page1.nextCursor, limit: 20 })
  assert.equal(page2.hasMore, false)

  // Rejection flow
  await restored.sendMessage(created.id, {
    clientMessageId: '00000000-0000-4000-8000-000000000903',
    content: '再来一张室内草图',
  })
  clock += MOCK_AGENT_PLAN_MS
  const waitingReject = await restored.getSnapshot(created.id)
  const rejApproval = waitingReject.approvals[0]
  await assert.rejects(
    restored.resolveApproval(rejApproval.id, { decision: 'rejected', expectedArgumentsHash: 'f'.repeat(64) }),
    { code: 'CONFLICT' },
  )
  const rejected = await restored.resolveApproval(rejApproval.id, {
    decision: 'rejected',
    expectedArgumentsHash: rejApproval.argumentsHash,
  })
  assert.equal(rejected.status, 'rejected')
  assert.equal((await restored.getTurn(waitingReject.activeTurn.id)).status, 'completed')

  // Cancel flow
  const cancelAccepted = await restored.sendMessage(created.id, {
    clientMessageId: '00000000-0000-4000-8000-000000000904',
    content: '取消测试轮次',
  })
  const cancelled = await restored.cancelTurn(cancelAccepted.turn.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await restored.getSnapshot(created.id)).activeTurn, null)
})
