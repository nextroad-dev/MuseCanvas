import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import * as reactQuery from '@tanstack/react-query'
import ts from 'typescript'
import { queryKeys } from './query-keys.ts'

// Execute the real modules, substituting only hook context and the network boundary.
function loadModule(file, dependencies) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const exports = {}
  runInThisContext(`(function(require, exports) { ${outputText}\n})`)((name) => {
    if (name in dependencies) return dependencies[name]
    throw new Error(`Unexpected import: ${name}`)
  }, exports)
  return exports
}
const api = loadModule('../services/api.ts', { '@musecanvas/contracts': {} })
function loadLibrary(client, list, remove) {
  return loadModule('./useLibrary.ts', {
    '@tanstack/react-query': client ? {
      ...reactQuery,
      useQueryClient: () => client,
      useQuery: (options) => options,
      useMutation: (options) => new reactQuery.MutationObserver(client, options),
    } : reactQuery,
    './query-keys': { queryKeys },
    '@/shared/services/client-api': { clientApi: { library: { detail: list, list, remove } } },
    '@/shared/services/api': api,
  })
}
const { findCachedAsset } = loadLibrary()

test('asset lookup ignores detail caches and finds later pages of filtered lists', () => {
  const client = new reactQuery.QueryClient()
  const target = { id: 'target', prompt: 'from list' }
  client.setQueryData(queryKeys.library.detail('other'), { id: 'other' })
  client.setQueryData(queryKeys.library.detail('target'), { id: 'target', prompt: 'detail' })
  client.setQueryData(queryKeys.library.list({ kind: 'video' }), {
    pages: [{ items: [{ id: 'first' }] }, { items: [target] }],
    pageParams: [undefined, 'cursor'],
  })
  assert.deepEqual(findCachedAsset(client, 'target'), target)
  assert.equal(findCachedAsset(client, 'other'), null)
  assert.equal(findCachedAsset(client, 'missing'), null)
})

test('asset lookup skips absent/malformed lists and pages without throwing', () => {
  const client = new reactQuery.QueryClient()
  client.getQueryCache().build(client, { queryKey: queryKeys.library.list({ q: 'pending' }) })
  client.setQueryData(queryKeys.library.list({ q: 'wrong shape' }), { id: 'detail-like' })
  client.setQueryData(queryKeys.library.list({ q: 'wrong pages' }), { pages: {} })
  const target = { id: 'target' }
  client.setQueryData(queryKeys.library.list(), {
    pages: [null, {}, { items: null }, { items: {} }, { items: [null, target] }],
    pageParams: [],
  })
  assert.deepEqual(findCachedAsset(client, 'target'), target)
  assert.equal(findCachedAsset(client, 'missing'), null)
})

test('asset detail cache hit resolves through QueryClient without a network request', async () => {
  const client = new reactQuery.QueryClient()
  const target = { id: 'target' }
  client.setQueryData(queryKeys.library.list(), { pages: [{ items: [target] }], pageParams: [] })
  const { useAssetDetail } = loadLibrary(client, () => assert.fail('unexpected network request'))
  const options = useAssetDetail('target')
  assert.deepEqual(options.queryKey, queryKeys.library.detail('target'))
  assert.equal(options.enabled, true)
  assert.deepEqual(await client.fetchQuery({ ...options, retry: false }), target)
})

test('asset detail cache miss reads the owner-scoped detail endpoint', async () => {
  const client = new reactQuery.QueryClient()
  const target = { id: 'target' }
  const calls = []
  const { useAssetDetail } = loadLibrary(client, async (id) => {
    calls.push(id)
    return target
  })
  assert.deepEqual(await client.fetchQuery({ ...useAssetDetail('target'), retry: false }), target)
  assert.deepEqual(calls, ['target'])
})

test('asset detail propagates the detail endpoint not-found response unchanged', async () => {
  const client = new reactQuery.QueryClient()
  const missing = new api.ApiError(404, 'NOT_FOUND', 'asset not found')
  const { useAssetDetail } = loadLibrary(client, async () => { throw missing })
  await assert.rejects(client.fetchQuery({ ...useAssetDetail('missing'), retry: false }), (error) => error === missing)
})

function seedDeleteCaches(client) {
  client.setQueryData(queryKeys.library.list(), { pages: [{ items: [] }], pageParams: [] })
  client.setQueryData(queryKeys.jobs.root, [])
}

function assertDeleteCachesInvalidated(client) {
  assert.equal(client.getQueryState(queryKeys.library.list()).isInvalidated, true)
  assert.equal(client.getQueryState(queryKeys.jobs.root).isInvalidated, true)
}

test('batch delete continues past a removed sibling output to an unrelated asset', async () => {
  const client = new reactQuery.QueryClient()
  seedDeleteCaches(client)
  const remaining = new Map([['output-1', 'job-1'], ['output-2', 'job-1'], ['output-3', 'job-2']])
  const calls = []
  const { useBatchDeleteAssets } = loadLibrary(client, undefined, async (id) => {
    calls.push(id)
    const jobId = remaining.get(id)
    if (!jobId) throw new api.ApiError(404, 'NOT_FOUND', 'already removed')
    for (const [assetId, parentJobId] of remaining) {
      if (parentJobId === jobId) remaining.delete(assetId)
    }
  })
  const ids = ['output-1', 'output-2', 'output-3']
  assert.deepEqual(await useBatchDeleteAssets().mutate(ids), ids)
  assert.deepEqual(calls, ids)
  assert.equal(remaining.size, 0)
  assertDeleteCachesInvalidated(client)
})

for (const failure of [
  new api.ApiError(404, 'HTTP_404', 'missing'),
  new api.ApiError(410, 'NOT_FOUND', 'missing'),
]) {
  test(`batch delete accepts missing assets (${failure.status}/${failure.code})`, async () => {
    const client = new reactQuery.QueryClient()
    const calls = []
    const { useBatchDeleteAssets } = loadLibrary(client, undefined, async (id) => {
      calls.push(id)
      if (id === 'missing') throw failure
    })
    const ids = ['missing', 'remaining']
    assert.deepEqual(await useBatchDeleteAssets().mutate(ids), ids)
    assert.deepEqual(calls, ids)
  })
}

for (const failure of [
  new api.ApiError(403, 'FORBIDDEN', 'forbidden'),
  new api.ApiError(500, 'INTERNAL_ERROR', 'server failure'),
  new api.ApiError(0, 'NETWORK_ERROR', 'network failure'),
  new Error('unexpected failure'),
]) {
  test(`batch delete propagates ${failure.message} and invalidates partial deletions`, async () => {
    const client = new reactQuery.QueryClient()
    seedDeleteCaches(client)
    const calls = []
    const { useBatchDeleteAssets } = loadLibrary(client, undefined, async (id) => {
      calls.push(id)
      if (id === 'failed') throw failure
    })
    await assert.rejects(
      useBatchDeleteAssets().mutate(['deleted', 'failed', 'not-attempted']),
      (error) => error === failure,
    )
    assert.deepEqual(calls, ['deleted', 'failed'])
    assertDeleteCachesInvalidated(client)
  })
}
