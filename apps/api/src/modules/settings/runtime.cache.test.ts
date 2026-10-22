import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { db } from '@musecanvas/database'
import { invalidateRuntimeSettings, resolveSiteSettings, resolveStorageSettings } from './runtime'

test('parallel settings callers share one load and poll revisions at most every five seconds', async () => {
  let now = 100_000, revision = 1
  const clock = mock.method(Date, 'now', () => now)
  const sqls: string[] = []
  const query = mock.method(db(), 'query', async (sql: string) => {
    sqls.push(sql)
    return { rows: sql.includes('SELECT config_revision') ? [{ config_revision: revision }] : [] }
  })
  invalidateRuntimeSettings()
  try {
    await Promise.all(Array.from({ length: 100 }, () => resolveStorageSettings()))
    assert.equal(sqls.length, 5, 'one revision query and four settings queries for the cold burst')
    await Promise.all(Array.from({ length: 100 }, () => resolveStorageSettings()))
    assert.equal(sqls.length, 5, 'no extra database work during the poll window')
    now += 5000
    await Promise.all([resolveSiteSettings(), resolveStorageSettings()])
    assert.equal(sqls.length, 6, 'unchanged revision needs only one poll')
    revision++
    now += 5000
    await resolveStorageSettings()
    assert.equal(sqls.length, 11, 'changed revision reloads the four settings groups')
  } finally { query.mock.restore(); clock.mock.restore(); invalidateRuntimeSettings() }
})

test('invalidation during an in-flight load cannot refill or return the stale snapshot', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let oldReadStarted!: () => void
  const started = new Promise<void>(resolve => { oldReadStarted = resolve })
  let revision = 1, siteReads = 0
  const query = mock.method(db(), 'query', async (sql: string) => {
    if (sql.includes('SELECT config_revision')) return { rows: [{ config_revision: revision }] }
    if (sql.includes('FROM app_settings')) {
      siteReads++
      const snapshot = revision
      if (siteReads === 1) { oldReadStarted(); await gate }
      return { rows: [{ site_name: `revision-${snapshot}`, site_url: null, revision: snapshot, updated_at: new Date(0) }] }
    }
    return { rows: [] }
  })
  invalidateRuntimeSettings()
  try {
    const before = resolveSiteSettings()
    await started
    revision = 2
    invalidateRuntimeSettings()
    const after = resolveSiteSettings()
    release()
    const results = await Promise.all([before, after])
    assert.deepEqual(results.map(site => site.siteName), ['revision-2', 'revision-2'])
    assert.equal((await resolveSiteSettings()).siteName, 'revision-2')
    assert.equal(siteReads, 2)
  } finally { release(); query.mock.restore(); invalidateRuntimeSettings() }
})
