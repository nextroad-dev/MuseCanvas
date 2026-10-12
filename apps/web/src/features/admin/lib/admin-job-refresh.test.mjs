import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { ADMIN_JOB_REFRESH_MS, shouldPollAdminJobs } from './admin-job-refresh.ts'

test('job polling is 15 seconds and requires explicit enablement, visible document and latest batch', () => {
  assert.equal(ADMIN_JOB_REFRESH_MS, 15000)
  assert.equal(shouldPollAdminJobs(true, true, 1), true)
  for (const [enabled, visible, batch] of [[false, true, 1], [true, false, 1], [true, true, 2], [true, true, 5]]) {
    assert.equal(shouldPollAdminJobs(enabled, visible, batch), false)
  }
})

test('failed background job refresh preserves successful data and updated timestamp', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const key = ['admin', 'jobs', { limit: 50 }]
  const data = { items: [{ id: 'task' }], total: 1, hasMore: false }
  try {
    await client.fetchQuery({ queryKey: key, queryFn: async () => data })
    const successfulAt = client.getQueryState(key).dataUpdatedAt
    assert.ok(successfulAt > 0)
    await assert.rejects(client.fetchQuery({ queryKey: key, queryFn: async () => { throw new Error('refresh failure') } }), /refresh failure/)
    assert.strictEqual(client.getQueryData(key), data)
    assert.equal(client.getQueryState(key).dataUpdatedAt, successfulAt)
  } finally {
    client.clear()
  }
})
