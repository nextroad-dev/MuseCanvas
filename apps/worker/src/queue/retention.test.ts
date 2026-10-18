import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePruneArgs, pruneOutbox, type PruneOutboxClient } from '../../../../scripts/prune-outbox'

test('history pruning defaults to dry-run and validates bounded integers and explicit modes', () => {
  assert.deepEqual(parsePruneArgs([]), { days: 30, limit: 1000, execute: false })
  assert.deepEqual(parsePruneArgs(['--days=14', '--limit=250', '--execute']), { days: 14, limit: 250, execute: true })
  for (const args of [['--days=0'], ['--days=1.5'], ['--limit=10001'], ['--limit=NaN'], ['--limit=-1'], ['--execute', '--dry-run'], ['--limit=1', '--limit=2'], ['--delete']]) {
    assert.throws(() => parsePruneArgs(args), /INVALID_OUTBOX_RETENTION/)
  }
})

test('dry-run only counts its bounded eligible batch; execution uses one fenced atomic delete', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const client: PruneOutboxClient = { query: async (sql, values) => {
    queries.push({ sql, values }); return { rows: [{ count: 4 }] }
  } }
  assert.deepEqual(await pruneOutbox(client, parsePruneArgs([])), { eligible: 4, deleted: 0 })
  assert.doesNotMatch(queries[0].sql, /DELETE|FOR UPDATE/i)
  assert.deepEqual(await pruneOutbox(client, parsePruneArgs(['--execute'])), { eligible: 4, deleted: 4 })
  assert.equal(queries.length, 2)
  assert.match(queries[1].sql, /FOR UPDATE SKIP LOCKED/)
  assert.match(queries[1].sql, /DELETE FROM outbox_events/)
  for (const query of queries) {
    assert.match(query.sql, /dispatched_at < now\(\)/)
    assert.match(query.sql, /dispatch_token IS NULL/)
    assert.match(query.sql, /dispatch_lease_expires_at <= now\(\)/)
    assert.match(query.sql, /LIMIT \$2/)
    assert.deepEqual(query.values, [30, 1000])
  }
  await assert.rejects(pruneOutbox(client, { days: 30, limit: Infinity, execute: true }), /INVALID_OUTBOX_RETENTION_OPTIONS/)
  assert.equal(queries.length, 2)
})
