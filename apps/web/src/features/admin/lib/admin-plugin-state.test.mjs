import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { createPluginSubmissionGuard, invalidateAdminPluginCatalogs } from './admin-plugin-state.ts'

test('plugin submission rejects duplicate starts and cannot finish a newer request with a stale identity', () => {
  const guard = createPluginSubmissionGuard()
  const first = guard.begin()
  assert.equal(guard.isPending(), true)
  assert.equal(guard.begin(), null)
  // A closed/reopened dialog retains the same guard and submitted identity.
  assert.equal(guard.owns(first), true)
  assert.equal(guard.finish(first), true)
  const second = guard.begin()
  assert.notEqual(second, first)
  assert.equal(guard.owns(first), false)
  assert.equal(guard.finish(first), false)
  assert.equal(guard.isPending(), true)
  assert.equal(guard.finish(second), true)
  assert.equal(guard.isPending(), false)
})

test('plugin changes invalidate all three composed catalogs, not unrelated models or credentials', async () => {
  const client = new QueryClient()
  try {
    for (const catalog of ['plugins', 'model-presets', 'provider-templates', 'models', 'provider-credentials']) {
      client.setQueryData(['admin', catalog], [])
    }
    await invalidateAdminPluginCatalogs(client)
    for (const catalog of ['plugins', 'model-presets', 'provider-templates']) {
      assert.equal(client.getQueryState(['admin', catalog]).isInvalidated, true)
    }
    for (const catalog of ['models', 'provider-credentials']) {
      assert.equal(client.getQueryState(['admin', catalog]).isInvalidated, false)
    }
  } finally {
    client.clear()
  }
})
