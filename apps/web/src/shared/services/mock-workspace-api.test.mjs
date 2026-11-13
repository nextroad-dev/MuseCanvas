import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { loadMock } from './mock-workspace-test-loader.mjs'

const { createMockWorkspaceApi, mockWorkspaceApi, MOCK_MODEL, MOCK_WORKSPACE_STORAGE_KEY, SHOWCASE_ITEMS } = loadMock()
const request = (extra = {}) => ({ modelId: MOCK_MODEL.id, prompt: 'Test flower', parameters: { count: 2 }, ...extra })
const storage = () => {
  const values = new Map()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('all artwork is verified local and models/DTO results cannot mutate factory state', async () => {
  for (const item of SHOWCASE_ITEMS) assert.ok(existsSync(new URL(`../../../public${item.src}`, import.meta.url)))
  const api = createMockWorkspaceApi()
  const models = await api.models.list()
  models[0].sizes.length = 0
  assert.equal((await api.models.list())[0].sizes.length, 5)
  const assets = await api.library.list()
  assert.equal(assets.total, 5)
  assert.ok(assets.items.every((asset) => asset.prompt.includes('非真实生成') && asset.mimeType === 'image/webp'))
  assert.equal((await api.library.download(assets.items[0].id)).url, assets.items[0].url)
})

test('fake-clock lifecycle is bounded, idempotent and exposes exactly one set of sample assets', async () => {
  let clock = 100_000
  const api = createMockWorkspaceApi({ now: () => clock })
  const body = request({ idempotencyKey: 'same' })
  const created = await api.generations.create(body)
  body.prompt = 'external mutation'
  assert.equal(created.status, 'queued')
  assert.equal((await api.library.list()).total, 5)
  clock += 1_000
  assert.equal((await api.jobs.detail(created.id)).status, 'running')
  assert.equal((await api.jobs.list({ status: 'active' })).total, 1)
  clock += 3_000
  const completed = await api.jobs.detail(created.id)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.outputs.length, 2)
  assert.equal((await api.library.list()).total, 7)
  assert.equal((await api.generations.create(request({ idempotencyKey: 'same' }))).id, created.id)
  assert.equal((await api.generations.create({ parameters: { size: '1200x1200', count: 2 }, prompt: 'Test flower', idempotencyKey: 'same', modelId: MOCK_MODEL.id })).id, created.id)
  assert.equal((await api.library.list()).total, 7)
  assert.equal((await api.jobs.list({ status: 'active' })).total, 0)
  await assert.rejects(api.generations.create(request({ prompt: 'different', idempotencyKey: 'same' })), { code: 'IDEMPOTENCY_CONFLICT' })
  await assert.rejects(api.jobs.cancel(created.id), { code: 'JOB_NOT_ACTIVE' })
  await api.library.remove(completed.outputs[0].assetId)
  assert.equal((await api.library.list()).total, 5)
  await assert.rejects(api.jobs.detail(created.id), { code: 'NOT_FOUND' })
  await assert.rejects(api.generations.create(request({ idempotencyKey: 'same' })), { code: 'IDEMPOTENCY_CONFLICT' })
})

test('cancel, retry and remove preserve terminal rules and isolate factories', async () => {
  let clock = 10_000
  const api = createMockWorkspaceApi({ now: () => clock })
  const created = await api.generations.create(request())
  await api.jobs.cancel(created.id)
  clock += 10_000
  assert.equal((await api.jobs.detail(created.id)).status, 'canceled')
  assert.equal((await api.library.list()).total, 5)
  assert.equal((await api.jobs.retry(created.id)).status, 'queued')
  await assert.rejects(api.jobs.retry(created.id), { code: 'JOB_NOT_RETRYABLE' })
  clock += 4_000
  assert.equal((await api.jobs.detail(created.id)).outputs.length, 2)
  await api.jobs.remove(created.id)
  assert.equal((await api.library.list()).total, 5)
  assert.equal((await api.jobs.list()).total, 0)
  assert.equal((await createMockWorkspaceApi().jobs.list()).total, 0)
})

test('search, kind, eligibility and cursor pagination are deterministic and validated', async () => {
  const api = createMockWorkspaceApi()
  const first = await api.library.list({ limit: 2 })
  const second = await api.library.list({ limit: 2, cursor: first.nextCursor })
  const third = await api.library.list({ limit: 2, cursor: second.nextCursor })
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map((asset) => asset.id)).size, 5)
  assert.equal(third.hasMore, false)
  assert.equal((await api.library.list({ kind: 'video' })).total, 0)
  assert.equal((await api.library.list({ eligible: true })).total, 0) // WebP isn't a supported PNG/JPEG reference.
  assert.equal((await api.library.list({ q: 'not-present-xyz' })).total, 0)
  const found = await api.library.list({ q: first.items[0].inputPrompt.toUpperCase() })
  assert.ok(found.items.some((asset) => asset.id === first.items[0].id))
  for (const limit of [0, -1, 101, 1.5, NaN]) await assert.rejects(api.library.list({ limit }), { code: 'INVALID_LIMIT' })
  await assert.rejects(api.library.list({ cursor: 'invalid' }), { code: 'INVALID_CURSOR' })
  await api.library.remove(first.items[0].id)
  await assert.rejects(api.library.download(first.items[0].id), { code: 'NOT_FOUND' })
})

test('versioned storage survives reload, deletion, denied/quota/corrupt storage safely', async () => {
  let clock = 100_000
  const persisted = storage()
  const api = createMockWorkspaceApi({ now: () => clock, storage: persisted })
  const created = await api.generations.create(request())
  await api.library.remove('mock-sample-1')
  clock += 4_000
  const restored = createMockWorkspaceApi({ now: () => clock, storage: persisted })
  assert.equal((await restored.jobs.detail(created.id)).status, 'succeeded')
  assert.equal((await restored.library.list()).total, 6)
  for (const invalid of ['{', '{"version":2}', JSON.stringify({ version: 1, nextId: 2, entries: [{ id: 'mock-job-1', at: 2, request: request({ modelId: 'video' }) }], removedSeeds: [] })]) {
    persisted.setItem(MOCK_WORKSPACE_STORAGE_KEY, invalid)
    assert.equal((await createMockWorkspaceApi({ storage: persisted }).jobs.list()).total, 0)
  }
  const denied = createMockWorkspaceApi({ storage: { getItem() { throw Error('denied') }, setItem() { throw Error('quota') } } })
  assert.equal((await denied.generations.create(request())).status, 'queued')
  assert.equal((await denied.jobs.list()).total, 1)
})

test('unsupported requests reject locally and SSR facade never creates shared state', async () => {
  const api = createMockWorkspaceApi()
  for (const body of [request({ modelId: 'video' }), request({ inputs: [{ uploadId: 'upload', role: 'reference', position: 0 }] }), request({ parameters: { count: 5 } }), request({ parameters: { duration: 10 } })]) {
    await assert.rejects(api.generations.create(body))
  }
  assert.equal((await api.jobs.list()).total, 0)
  assert.throws(() => mockWorkspaceApi.jobs.list(), { code: 'MOCK_BROWSER_ONLY' })
})
