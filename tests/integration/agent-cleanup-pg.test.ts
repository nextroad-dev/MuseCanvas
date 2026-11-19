import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runMigrations, type MigrateOptions } from '../../packages/database/src/migrations/runner'
import { CleanupJobRepository, CleanupLeaseLost } from '../../packages/database/src/repositories/cleanup-jobs'
import { accountCleanupReadiness } from '../../apps/worker/src/maintenance/account-readiness'

const url = process.env.MUSECANVAS_AGENT_CLEANUP_PG_URL

test('isolated PostgreSQL: cleanup claims, rollback and account convergence guards', { skip: !url, timeout: 180_000 }, async t => {
  const target = new URL(url!)
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol))
  assert.equal(target.hostname, '127.0.0.1')
  assert.equal(target.username, 'fixture')
  assert.equal(target.pathname, '/postgres')
  const require = createRequire(new URL('../../packages/database/package.json', import.meta.url))
  type Pool = MigrateOptions['pool']
  const { Pool } = require('pg') as { Pool: new (config: { connectionString: string; max: number; connectionTimeoutMillis: number; statement_timeout?: number; lock_timeout?: number }) => Pool }
  const admin = new Pool({ connectionString: url!, max: 1, connectionTimeoutMillis: 5000 })
  const name = `agent_cleanup_${randomUUID().replaceAll('-', '')}`
  assert.match(name, /^agent_cleanup_[a-f0-9]{32}$/)
  let pool: Pool | undefined, created = false
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    created = true
    target.pathname = `/${name}`
    pool = new Pool({ connectionString: target.toString(), max: 6, connectionTimeoutMillis: 5000, statement_timeout: 5000, lock_timeout: 3000 })
    const fixture = pool
    assert.ok((await runMigrations({ pool: fixture })).latest! >= '0046')
    assert.deepEqual((await runMigrations({ pool: fixture })).applied, [])
    const repository = new CleanupJobRepository(fixture)
    async function owner() {
      return String((await fixture.query("INSERT INTO users(email,deleted_at,deletion_requested_at) VALUES($1,now(),now()) RETURNING id", [`cleanup-${randomUUID()}@example.invalid`])).rows[0]!.id)
    }
    const ownerId = await owner()
    await fixture.query('INSERT INTO deletion_jobs(user_id) VALUES($1)', [ownerId])
    await t.test('concurrent claimers never share a lease; expiry replaces token and fences the old worker', async () => {
      const claims = await Promise.all([repository.claim('account'), repository.claim('account')])
      assert.equal(claims.filter(Boolean).length, 1)
      const first = claims.find(Boolean)!
      await fixture.query("UPDATE deletion_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id])
      const second = (await repository.claim('account'))!
      assert.equal(second.id, first.id)
      assert.notEqual(second.token, first.token)
      await assert.rejects(repository.renew(first), CleanupLeaseLost)
      await assert.rejects(repository.withClaim(first, async () => assert.fail('stale callback')), CleanupLeaseLost)
      const before = (await fixture.query('SELECT session_version FROM users WHERE id=$1', [ownerId])).rows[0]!.session_version
      await assert.rejects(repository.withClaim(second, async client => {
        await client.query('UPDATE users SET session_version=session_version+1 WHERE id=$1', [ownerId])
        await client.query("UPDATE deletion_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [second.id])
      }, true), CleanupLeaseLost)
      assert.equal((await fixture.query('SELECT session_version FROM users WHERE id=$1', [ownerId])).rows[0]!.session_version, before)
      assert.equal(await repository.withClaim(second, client => accountCleanupReadiness(client, ownerId)), null)
      await repository.withClaim(second, async () => {}, true)
      const final = (await fixture.query('SELECT completed_at,claim_token FROM deletion_jobs WHERE id=$1', [second.id])).rows[0]!
      assert.ok(final.completed_at)
      assert.equal(final.claim_token, null)
    })
    await t.test('asset object jobs also serialize claims and reject expired completion', async () => {
      const model = (await fixture.query("INSERT INTO model_configs(display_name,adapter,vendor_model_id,sizes,max_count,concurrency_limit,created_by) VALUES('fixture','openai','fixture','[]',1,2,$1) RETURNING id", [ownerId])).rows[0]!
      const job = (await fixture.query("INSERT INTO generation_jobs(created_by,model_id,model_name,adapter,vendor_model_id,size,count,idempotency_key,status) VALUES($1,$2,'fixture','openai','fixture','1024x1024',1,$3,'succeeded') RETURNING id", [ownerId, model.id, randomUUID()])).rows[0]!
      const asset = (await fixture.query("INSERT INTO assets(created_by,job_id,object_key,mime_type,width,height,size_bytes,checksum) VALUES($1,$2,$3,'image/png',1,1,1,'fixture') RETURNING id", [ownerId, job.id, randomUUID()])).rows[0]!
      await fixture.query('INSERT INTO asset_deletion_jobs(asset_id,object_key) VALUES($1,$2)', [asset.id, 'fixture/object'])
      const claims = await Promise.all([repository.claim('asset'), repository.claim('asset')])
      assert.equal(claims.filter(Boolean).length, 1)
      const first = claims.find(Boolean)!
      await fixture.query("UPDATE asset_deletion_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id])
      const next = (await repository.claim('asset'))!
      await assert.rejects(repository.withClaim(first, async () => {}, true), CleanupLeaseLost)
      await repository.withClaim(next, async () => {}, true)
      assert.ok((await fixture.query('SELECT completed_at FROM asset_deletion_jobs WHERE id=$1', [next.id])).rows[0]!.completed_at)
    })
    await t.test('private/system definitions survive explicit policy blocking; other owners stay untouched', async () => {
      const deletedOwner = await owner()
      const otherOwner = await owner()
      const definition = (await fixture.query("INSERT INTO agent_definitions(owner_id,name,version,model_policy,instructions,tool_allowlist,budget_policy) VALUES($1,$2,1,'{}','private-content','[]','{}') RETURNING id", [deletedOwner, randomUUID()])).rows[0]!
      const system = (await fixture.query("INSERT INTO agent_definitions(name,version,model_policy,instructions,tool_allowlist,budget_policy) VALUES($1,1,'{}','system-content','[]','{}') RETURNING id", [randomUUID()])).rows[0]!
      await fixture.query('INSERT INTO deletion_jobs(user_id) VALUES($1)', [deletedOwner])
      const claim = (await repository.claim('account'))!
      assert.equal(await repository.withClaim(claim, client => accountCleanupReadiness(client, deletedOwner)), 'BLOCKED_AGENT_RETENTION_POLICY')
      await repository.block(claim, 'BLOCKED_AGENT_RETENTION_POLICY')
      assert.equal(await repository.claim('account'), null)
      assert.deepEqual((await fixture.query('SELECT instructions FROM agent_definitions WHERE id=ANY($1::uuid[]) ORDER BY instructions', [[definition.id, system.id]])).rows.map(row => row.instructions), ['private-content', 'system-content'])
      assert.equal((await fixture.query('SELECT count(*)::int n FROM deletion_jobs WHERE user_id=$1', [otherOwner])).rows[0]!.n, 0)
    })
    await t.test('active turns receive durable cancellation once and cannot be mistaken for erased content', async () => {
      const deletedOwner = await owner()
      const definition = (await fixture.query("INSERT INTO agent_definitions(name,version,model_policy,instructions,tool_allowlist,budget_policy) VALUES($1,1,'{}','','[]','{}') RETURNING id", [randomUUID()])).rows[0]!
      const session = (await fixture.query('INSERT INTO agent_sessions(owner_id,agent_definition_id,definition_version) VALUES($1,$2,1) RETURNING id', [deletedOwner, definition.id])).rows[0]!
      const turn = (await fixture.query("INSERT INTO agent_turns(session_id,client_idempotency_key,request_digest,status,config_snapshot,budget_snapshot,engine_version,deadline_at) VALUES($1,$2,$3,'queued','{}','{}','agent-core-v1',now()+interval '5 minutes') RETURNING id", [session.id, randomUUID(), 'a'.repeat(64)])).rows[0]!
      await fixture.query('INSERT INTO deletion_jobs(user_id) VALUES($1)', [deletedOwner])
      const claim = (await repository.claim('account'))!
      for (let i = 0; i < 2; i += 1) assert.equal(await repository.withClaim(claim, client => accountCleanupReadiness(client, deletedOwner)), 'WAITING_AGENT_SETTLEMENT')
      const state = (await fixture.query('SELECT status,cancel_requested_at,revision FROM agent_turns WHERE id=$1', [turn.id])).rows[0]!
      assert.equal(state.status, 'queued')
      assert.ok(state.cancel_requested_at)
      assert.equal(String(state.revision), '2')
      assert.equal((await fixture.query("SELECT count(*)::int n FROM outbox_events WHERE dedupe_key=$1", [`account-deletion-cancel:${turn.id}`])).rows[0]!.n, 1)
      await repository.release(claim, 'WAITING_AGENT_SETTLEMENT')
    })
  } finally {
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
    await admin.end()
  }
})
