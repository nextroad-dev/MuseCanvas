import assert from 'node:assert/strict'
import test from 'node:test'
import { agentApi } from './client-api.ts'
import { API_ENDPOINTS } from '@musecanvas/contracts'

const input = () => ({
  modelId: '11111111-1111-4111-8111-111111111111',
  assetId: '22222222-2222-4222-8222-222222222222',
  selection: { x: 1, y: 2, width: 32, height: 32 },
  idempotencyKey: 'context-test',
})
const sessionId = '33333333-3333-4333-8333-333333333333'
const turnId = '44444444-4444-4444-8444-444444444444'

test('preparation serializes new-work and accepted-turn context as multipart metadata', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ success: true, data: { preparationVersion: 1 } }), { status: 202 })
  })
  for (const context of [{}, { sessionId }, { sessionId, turnId }]) {
    const response = await agentApi.prepareImageEdit({ ...input(), ...context })
    assert.equal(response.preparationVersion, 1)
    const { url, init } = calls.at(-1)
    assert.ok(String(url).endsWith(API_ENDPOINTS.images.prepareEdit))
    assert.equal(init.method, 'POST')
    assert.equal(init.credentials, 'include')
    assert.ok(init.body instanceof FormData)
    assert.equal(init.headers['Content-Type'], undefined)
    assert.equal(init.body.get('sessionId'), context.sessionId ?? null)
    assert.equal(init.body.get('turnId'), context.turnId ?? null)
    assert.equal(init.body.get('assetId'), input().assetId)
    assert.deepEqual(JSON.parse(init.body.get('region')), input().selection)
    assert.deepEqual([...init.body.keys()].sort(), ['modelId', 'assetId', 'region', 'idempotencyKey', ...Object.keys(context)].sort())
  }
  assert.equal(calls.length, 3)
})

test('a turn without its session is rejected before any preparation request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { assert.fail('unexpected network request') })
  assert.throws(() => agentApi.prepareImageEdit({ ...input(), turnId }), /所属会话/)
  assert.equal(fetch.mock.callCount(), 0)
})
