import assert from 'node:assert/strict'
import test from 'node:test'
import type pg from 'pg'
import { CleanupJobRepository, CleanupLeaseLost, type CleanupClaim } from './cleanup-jobs'

const claim: CleanupClaim = { kind: 'account', id: 'job', token: 'token', userId: 'owner' }

test('cleanup claims are one-statement bounded SKIP LOCKED leases using the DB clock', async () => {
  const calls: string[] = []
  const pool = { async query(sql: string) {
    calls.push(sql)
    return { rows: [{ id: 'job', claim_token: 'token', user_id: 'owner' }] }
  } } as unknown as pg.Pool
  const repository = new CleanupJobRepository(pool)
  assert.deepEqual(await repository.claim('account'), claim)
  const sql = calls[0]!
  for (const token of ['WITH ready', 'LIMIT 1 FOR UPDATE SKIP LOCKED', 'gen_random_uuid()', 'clock_timestamp()', 'blocked_at IS NULL', 'next_attempt_at<=', 'lease_expires_at<=']) assert.ok(sql.includes(token), token)
})

test('renew cannot revive an expired claim; release, retry and block retain the same fence', async () => {
  const calls: Array<{ sql: string; args?: unknown[] }> = []
  const pool = { async query(sql: string, args?: unknown[]) { calls.push({ sql, args }); return { rows: [] } } } as unknown as pg.Pool
  const repository = new CleanupJobRepository(pool)
  await assert.rejects(repository.renew(claim), CleanupLeaseLost)
  await repository.release(claim, 'WAITING_AGENT_SETTLEMENT')
  await repository.retry(claim)
  await repository.block(claim, 'BLOCKED_AGENT_RETENTION_POLICY')
  for (const { sql, args } of calls) {
    assert.match(sql, /id=\$1 AND claim_token=\$2 AND completed_at IS NULL AND lease_expires_at>clock_timestamp\(\)/)
    assert.deepEqual(args?.slice(0, 2), ['job', 'token'])
  }
  assert.match(calls[2]!.sql, /LEAST\(3600/)
  assert.match(calls[3]!.sql, /blocked_at=clock_timestamp\(\)/)
})

test('fenced progress rolls back when the lease is lost before work or before completion', async () => {
  for (const loss of ['before', 'after', 'none']) {
    const calls: string[] = []
    let ran = false, released = false
    const client = { async query(sql: string) {
      calls.push(sql)
      if (sql.startsWith('SELECT id')) return { rows: loss === 'before' ? [] : [{ id: 'job' }] }
      if (sql.startsWith('UPDATE deletion_jobs')) return { rows: loss === 'after' ? [] : [{ id: 'job' }] }
      return { rows: [] }
    }, release() { released = true } }
    const repository = new CleanupJobRepository({ connect: async () => client } as unknown as pg.Pool)
    const operation = () => repository.withClaim(claim, async () => { ran = true }, true)
    if (loss === 'none') await operation()
    else await assert.rejects(operation(), CleanupLeaseLost)
    assert.equal(ran, loss !== 'before')
    assert.equal(calls.at(-1), loss === 'none' ? 'COMMIT' : 'ROLLBACK')
    assert.equal(released, true)
  }
})
