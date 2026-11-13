import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import ts from 'typescript'
import * as jobStatus from './job-status.ts'
import { queryKeys } from '../hooks/query-keys.ts'

// Compile the actual module; only resolve its extensionless TS imports for Node.
const source = readFileSync(new URL('./created-job-cache.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
const exports = {}
runInThisContext(`(function(require, exports) { ${outputText}\n})`)((name) => {
  if (name === './job-status') return jobStatus
  if (name === '../hooks/query-keys') return { queryKeys }
  throw new Error(`Unexpected import: ${name}`)
}, exports)
const { cacheCreatedJob } = exports

test('created job updates DTO items, preserves metadata and seeds only its detail', async () => {
  const client = new QueryClient()
  const existing = { id: 'old', status: 'succeeded' }
  const created = { id: 'new', status: 'queued' }
  const key = queryKeys.jobs.list()
  const page = { items: [existing], total: 42, hasMore: true }
  client.setQueryData(key, page)
  client.setQueryData(queryKeys.jobs.detail('old'), existing)
  client.setQueryData(queryKeys.library.detail('asset'), { id: 'asset' })
  await cacheCreatedJob(client, created)
  assert.deepEqual(client.getQueryData(key), { ...page, items: [created, existing] })
  assert.deepEqual(client.getQueryData(queryKeys.jobs.detail('new')), created)
  assert.deepEqual(client.getQueryData(queryKeys.jobs.detail('old')), existing)
  assert.deepEqual(client.getQueryData(queryKeys.library.detail('asset')), { id: 'asset' })
  await cacheCreatedJob(client, { ...created, prompt: 'updated' })
  assert.deepEqual(client.getQueryData(key), {
    ...page, items: [{ ...created, prompt: 'updated' }, existing],
  })
})

test('created job respects exact/active status filters and per-query limits', async () => {
  const client = new QueryClient()
  const old = { id: 'old', status: 'running' }
  const created = { id: 'new', status: 'retry_wait' }
  const active = queryKeys.jobs.list({ status: 'active', limit: 1 })
  const exact = queryKeys.jobs.list({ status: 'retry_wait', limit: 2 })
  const excluded = queryKeys.jobs.list({ status: 'succeeded' })
  const page = { items: [old], total: 8, hasMore: false }
  for (const key of [active, exact, excluded]) client.setQueryData(key, page)
  await cacheCreatedJob(client, created)
  assert.deepEqual(client.getQueryData(active), { ...page, items: [created] })
  assert.deepEqual(client.getQueryData(exact), { ...page, items: [created, old] })
  assert.deepEqual(client.getQueryData(excluded), page)
})

test('default and limit100 lists stay within the 50-job server window', async () => {
  const client = new QueryClient()
  const key = queryKeys.jobs.list()
  const items = Array.from({ length: 50 }, (_, index) => ({ id: `old-${index}` }))
  client.setQueryData(key, { items, total: 50, hasMore: false })
  const largeKey = queryKeys.jobs.list({ limit: 100 })
  client.setQueryData(largeKey, { items, total: 50, hasMore: false })
  const pendingKey = queryKeys.jobs.list({ status: 'active' })
  client.getQueryCache().build(client, { queryKey: pendingKey })
  const created = { id: 'new', status: 'queued' }
  await cacheCreatedJob(client, created)
  assert.deepEqual(client.getQueryData(key), {
    items: [created, ...items.slice(0, 49)], total: 50, hasMore: false,
  })
  assert.deepEqual(client.getQueryData(largeKey), client.getQueryData(key))
  assert.equal(client.getQueryData(pendingKey), undefined)
})

test('mounted initial list fetch stays fetching and delivers its result after cache seeding', async () => {
  const client = new QueryClient()
  const key = queryKeys.jobs.list()
  let respond
  let fetches = 0
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: () => {
      fetches += 1
      return new Promise((resolve) => { respond = resolve })
    },
  })
  const states = []
  const unsubscribe = observer.subscribe((result) => {
    states.push([result.status, result.fetchStatus])
  })
  try {
    assert.equal(observer.getCurrentResult().fetchStatus, 'fetching')
    const created = { id: 'new', status: 'queued' }
    await cacheCreatedJob(client, created)
    assert.equal(observer.getCurrentResult().fetchStatus, 'fetching')
    const page = { items: [created], total: 1, hasMore: false }
    const completed = new Promise((resolve) => {
      const stop = observer.subscribe((result) => {
        if (result.isSuccess) { stop(); resolve(result) }
      })
    })
    respond(page)
    const result = await completed
    assert.equal(result.status, 'success')
    assert.equal(result.fetchStatus, 'idle')
    assert.deepEqual(result.data, page)
    assert.deepEqual(client.getQueryData(key), page)
    assert.equal(fetches, 1)
    assert.equal(states.some(([status, fetchStatus]) => status === 'pending' && fetchStatus === 'idle'), false)
  } finally {
    unsubscribe()
    client.clear()
  }
})

test('in-flight old list response is canceled before the created job is cached', async () => {
  const client = new QueryClient()
  const key = queryKeys.jobs.list()
  const page = { items: [], total: 0, hasMore: false }
  client.setQueryData(key, page)
  let respond
  const pending = client.fetchQuery({
    queryKey: key,
    queryFn: () => new Promise((resolve) => { respond = resolve }),
  }).catch(() => undefined)
  const created = { id: 'new', status: 'queued' }
  await cacheCreatedJob(client, created)
  respond(page)
  await pending
  assert.deepEqual(client.getQueryData(key), { ...page, items: [created] })
})
