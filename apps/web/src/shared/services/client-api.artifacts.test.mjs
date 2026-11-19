import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTs } from './mock-workspace-test-loader.mjs'

const { API_ENDPOINTS } = loadTs(new URL('../../../../../packages/contracts/src/endpoints.ts', import.meta.url))
const { queryKeys } = loadTs(new URL('../hooks/query-keys.ts', import.meta.url))
function setup(mode) {
  const calls = []
  const { agentApi } = loadTs(new URL('./client-api.ts', import.meta.url), {
    '@musecanvas/contracts': { API_ENDPOINTS },
    './api': { apiFetch: async (...args) => { calls.push(args); return { items: [], nextCursor: null } } },
    '../lib/workspace-mode': { WORKSPACE_MODE: mode },
    './mock-agent-api': {},
    './mock-workspace-api': {},
  })
  return { agentApi, calls }
}

test('Artifact API uses contract endpoints, opaque cursors and exact mutation DTOs', async () => {
  const { agentApi, calls } = setup('live')
  const session = 'session /a', artifact = 'text:00000000-0000-4000-8000-000000000001', thread = 'thread /a'
  const create = { clientRequestId: '00000000-0000-4000-8000-000000000002', version: 1, anchor: { kind: 'text', start: 3, end: 7, quote: 'same' }, body: '私密评论' }
  const reply = { clientRequestId: '00000000-0000-4000-8000-000000000003', body: 'reply' }
  await agentApi.listArtifacts(session, { limit: 30, cursor: 'opaque_1' })
  await agentApi.getArtifact(session, artifact)
  await agentApi.listArtifactThreads(session, artifact, { limit: 30, cursor: 'opaque_2' })
  await agentApi.createArtifactThread(session, artifact, create)
  await agentApi.resolveArtifactThread(session, artifact, thread, { resolved: true })
  await agentApi.resolveArtifactThread(session, artifact, thread, { resolved: false })
  await agentApi.replyArtifactThread(session, artifact, thread, reply)
  assert.deepEqual(calls, [
    [API_ENDPOINTS.agent.artifacts(session), { params: { limit: 30, cursor: 'opaque_1' } }],
    [API_ENDPOINTS.agent.artifact(session, artifact), { params: undefined }],
    [API_ENDPOINTS.agent.artifactThreads(session, artifact), { params: { limit: 30, cursor: 'opaque_2' } }],
    [API_ENDPOINTS.agent.artifactThreads(session, artifact), { method: 'POST', body: create }],
    [API_ENDPOINTS.agent.artifactThread(session, artifact, thread), { method: 'PATCH', body: { resolved: true } }],
    [API_ENDPOINTS.agent.artifactThread(session, artifact, thread), { method: 'PATCH', body: { resolved: false } }],
    [API_ENDPOINTS.agent.artifactThreadReplies(session, artifact, thread), { method: 'POST', body: reply }],
  ])
  assert.match(calls[1][0], /text%3A/)
  assert.match(calls[0][0], /session%20%2Fa/)
})

test('every Artifact mock API path stays local, including unsupported detail and mutations', async () => {
  const { agentApi, calls } = setup('mock')
  assert.deepEqual(await agentApi.listArtifacts('s'), { items: [], nextCursor: null })
  assert.deepEqual(await agentApi.listArtifactThreads('s', 'text:a'), { items: [], nextCursor: null })
  for (const [name, args] of [
    ['getArtifact', ['s', 'text:a']],
    ['createArtifactThread', ['s', 'text:a', {}]],
    ['resolveArtifactThread', ['s', 'text:a', 't', { resolved: true }]],
    ['replyArtifactThread', ['s', 'text:a', 't', { body: 'x' }]],
  ]) await assert.rejects(agentApi[name](...args), /本地演示/)
  assert.deepEqual(calls, [])
})

test('Artifact, thread and authorized-asset caches isolate both owner and session', () => {
  for (const name of ['artifacts', 'artifact', 'artifactThreads', 'artifactAsset']) {
    const a = queryKeys.agent[name]('owner-a', 'session-a', 'text:a')
    const b = queryKeys.agent[name]('owner-b', 'session-a', 'text:a')
    const c = queryKeys.agent[name]('owner-a', 'session-b', 'text:a')
    assert.notDeepEqual(a, b)
    assert.notDeepEqual(a, c)
  }
})
