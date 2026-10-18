import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@musecanvas/database'
import { invalidateRuntimeSettings, resolveRuntimeSettings, resolveStorageSettings } from './runtime'

test('worker settings share one refresh and perform no SQL within the five second cache', async t => {
  let time = 0
  let calls = 0
  let timeout = 1000
  t.mock.method(Date, 'now', () => time)
  t.mock.method(db(), 'query', async (sql: string) => {
    calls++
    if (sql.includes('SELECT config_revision')) return { rows: [{ config_revision: timeout }] }
    if (sql.includes('FROM runtime_settings')) return { rows: [{ provider_timeout_ms: timeout }] }
    // No template rows or storage secrets are needed for a settings-only test.
    return { rows: [] }
  })
  invalidateRuntimeSettings()
  try {
    const results = await Promise.all(Array.from({ length: 100 }, () => resolveRuntimeSettings()))
    assert.ok(results.every(result => result.providerTimeoutMs === 1000))
    const coldCalls = calls
    assert.equal(coldCalls, 4, 'revision and three settings loaders run once')
    await Promise.all(Array.from({ length: 100 }, () => resolveStorageSettings()))
    assert.equal(calls, coldCalls)
    timeout = 2000
    time = 5000
    assert.equal((await resolveRuntimeSettings()).providerTimeoutMs, 2000)
    assert.equal(calls, coldCalls * 2)
    timeout = 3000
    invalidateRuntimeSettings()
    assert.equal((await resolveRuntimeSettings()).providerTimeoutMs, 3000)
  } finally { invalidateRuntimeSettings() }
})

test('an invalidated in-flight worker refresh cannot repopulate the cache', async t => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let first = true
  let revisionCalls = 0
  t.mock.method(db(), 'query', async (sql: string) => {
    if (sql.includes('SELECT config_revision')) {
      revisionCalls++
      if (first) { first = false; await blocked }
      return { rows: [{ config_revision: revisionCalls }] }
    }
    return { rows: [] }
  })
  invalidateRuntimeSettings()
  try {
    const stale = resolveRuntimeSettings()
    invalidateRuntimeSettings()
    const current = await resolveRuntimeSettings()
    release()
    assert.equal(await stale, current, 'old waiters must also receive the current settings snapshot')
    assert.equal(await resolveRuntimeSettings(), current)
    assert.equal(revisionCalls, 2)
  } finally { release(); invalidateRuntimeSettings() }
})
