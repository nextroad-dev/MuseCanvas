import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runMigrations, type MigrateOptions } from '../../packages/database/src/migrations/runner'
import { AgentCoreRepository, agentCoreDecimal, type AgentCoreTransaction } from '../../packages/database/src/repositories/agent-core'
import { AgentRuntimeRepository, type AgentTurnLease } from '../../packages/database/src/repositories/agent-runtime'

const url = process.env.MUSECANVAS_AGENT_RUNTIME_PG_URL

// Source/typecheck only in P5a: DO NOT execute this fixture in that stage.
// Later execution requires explicit authorization and this dedicated opt-in URL.
// Never use inherited DATABASE_URL, load env files, or start any service. Match
// the existing reliability fixture: loopback fixture user, fresh owned database.
test('isolated PostgreSQL: Agent runtime leases and SQL transaction fencing', { skip: !url, timeout: 180_000 }, async t => {
  const target = new URL(url!)
  assert.equal(target.hostname, '127.0.0.1')
  assert.equal(target.username, 'fixture')
  assert.equal(target.pathname, '/postgres')
  const require = createRequire(new URL('../../packages/database/package.json', import.meta.url))
  type Pool = MigrateOptions['pool']
  const { Pool } = require('pg') as { Pool: new (config: { connectionString: string; max: number; connectionTimeoutMillis: number; statement_timeout?: number; lock_timeout?: number }) => Pool }
  const admin = new Pool({ connectionString: url!, max: 1, connectionTimeoutMillis: 5000 })
  const name = `agent_runtime_${randomUUID().replaceAll('-', '')}`
  assert.match(name, /^agent_runtime_[a-f0-9]{32}$/)
  let pool: Pool | undefined, created = false
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    created = true
    target.pathname = `/${name}`
    pool = new Pool({ connectionString: target.toString(), max: 6, connectionTimeoutMillis: 5000, statement_timeout: 5000, lock_timeout: 3000 })
    const fixturePool = pool
    const latest = (await runMigrations({ pool: fixturePool })).latest
    assert.ok(latest && latest >= '0044', `Agent runtime fixture requires migrations through 0044, got ${latest}`)
    const tx: AgentCoreTransaction = async work => {
      const c = await fixturePool.connect()
      try { await c.query('BEGIN'); const value = await work(c); await c.query('COMMIT'); return value }
      catch (error) { await c.query('ROLLBACK'); throw error }
      finally { c.release() }
    }
    const repo = new AgentRuntimeRepository(tx)
    const core = new AgentCoreRepository(tx, async () => { throw new Error('existing-turn tests must not admit') })
    async function oneId(sql: string, args: unknown[] = []): Promise<string> {
      const row = (await fixturePool.query<{ id: string }>(sql, args)).rows[0]
      assert.ok(row)
      return row.id
    }
    const ownerId = await oneId("INSERT INTO users(email) VALUES('agent-runtime@example.invalid') RETURNING id")
    const definition = await oneId("INSERT INTO agent_definitions(name,version,model_policy,instructions,tool_allowlist,budget_policy) VALUES('runtime-fixture',1,'{}','','[]','{}') RETURNING id")
    async function makeScope(engine = 'agent-core-v1') {
      const sessionId = await oneId('INSERT INTO agent_sessions(owner_id,agent_definition_id,definition_version) VALUES($1,$2,1) RETURNING id', [ownerId, definition])
      const turnId = await tx(async c => {
        const row = (await c.query<{ id: string }>(`INSERT INTO agent_turns(session_id,client_idempotency_key,request_digest,status,config_snapshot,budget_snapshot,engine_version,input_revision,deadline_at)
          VALUES($1,$2,$3,'queued','{}','{}',$4,1,clock_timestamp()+interval '5 minutes') RETURNING id`,
        [sessionId, randomUUID(), 'a'.repeat(64), engine])).rows[0]
        assert.ok(row)
        await c.query('UPDATE agent_sessions SET active_turn_id=$2,input_revision=1 WHERE id=$1', [sessionId, row.id])
        return row.id
      })
      return { ownerId, sessionId, turnId }
    }
    async function take(scope: Awaited<ReturnType<typeof makeScope>>, leaseOwner = 'worker-a'): Promise<AgentTurnLease> {
      const value = await repo.claimTurnLease({ ...scope, leaseOwner, leaseDurationMs: 60000 })
      assert.ok(value)
      return value
    }
    async function inspect(scope: Awaited<ReturnType<typeof makeScope>>) {
      return (await fixturePool.query<{ revision: string; fencing_token: string; lease_owner: string | null; status: string; cursor: string; events: string; effects: string; cancelled: boolean }>(`SELECT t.revision::text,t.fencing_token::text,t.lease_owner,t.status,s.next_event_cursor::text AS cursor,
        (SELECT count(*)::text FROM agent_session_events WHERE session_id=s.id) AS events,
        (SELECT count(*)::text FROM agent_model_rounds WHERE turn_id=t.id) AS effects,t.cancel_requested_at IS NOT NULL AS cancelled
        FROM agent_turns t JOIN agent_sessions s ON s.id=t.session_id WHERE t.id=$1`, [scope.turnId])).rows[0]!
    }
    const roundSQL = `INSERT INTO agent_model_rounds(session_id,turn_id,position,request_digest,input_revision,status,model_reference_id)
      VALUES($1,$2,1,$3,1,'recorded','fixture')`

    await t.test('concurrent first claims serialize; queued transition/event/cursor occur once', async () => {
      const scope = await makeScope()
      const results = await Promise.all(['a', 'b'].map(leaseOwner => repo.claimTurnLease({ ...scope, leaseOwner, leaseDurationMs: 60000 })))
      assert.equal(results.filter(Boolean).length, 1)
      const stored = await inspect(scope)
      assert.equal(stored.revision, '2'); assert.equal(stored.fencing_token, '1'); assert.equal(stored.events, '1'); assert.equal(stored.cursor, '2')
      const payload = (await fixturePool.query<{ payload: { turn: Record<string, unknown> } }>('SELECT payload FROM agent_session_events WHERE session_id=$1', [scope.sessionId])).rows[0]!.payload
      assert.equal(payload.turn.status, 'running'); assert.equal(payload.turn.revision, '2')
      assert.equal('leaseOwner' in payload.turn, false); assert.equal('configSnapshot' in payload.turn, false)
    })

    for (const leaseOwner of ['worker-a', 'worker-b']) {
      await t.test(`expired ${leaseOwner} reclaim fences all old writes and old release`, async () => {
        const scope = await makeScope(), old = await take(scope)
        await fixturePool.query("UPDATE agent_turns SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [scope.turnId])
        assert.equal(await repo.renewTurnLease({ ...old, leaseDurationMs: 60000 }), null)
        const replacement = await take(scope, leaseOwner)
        assert.equal(replacement.fencingToken, '2')
        assert.equal(await repo.releaseTurnLease(old), false)
        await assert.rejects(repo.withTurnLease({ ...old, expectedInputRevision: old.inputRevision }, async c => {
          await c.query(roundSQL, [scope.sessionId, scope.turnId, 'b'.repeat(64)])
        }), { code: 'LEASE_REJECTED' })
        assert.equal((await inspect(scope)).effects, '0')
        assert.equal((await inspect(scope)).lease_owner, leaseOwner)
        assert.equal((await inspect(scope)).events, '1')
        await repo.withTurnLease({ ...replacement, expectedInputRevision: replacement.inputRevision }, async c => {
          await c.query(roundSQL, [scope.sessionId, scope.turnId, 'b'.repeat(64)])
        })
        assert.equal((await inspect(scope)).effects, '1')
      })
    }

    await t.test('steering and renewal serialize without losing input or spuriously losing lease; cancellation blocks effects/renewal', async () => {
      const scope = await makeScope(), lease = await take(scope)
      const [renewed, steered] = await Promise.all([
        repo.renewTurnLease({ ...lease, leaseDurationMs: 60000 }),
        core.message(ownerId, scope.sessionId, { clientMessageId: randomUUID(), content: 'steer' }, false, scope.turnId),
      ])
      assert.ok(renewed); assert.equal(steered.acceptedInputRevision, '2')
      const current = await repo.renewTurnLease({ ...lease, leaseDurationMs: 60000 })
      assert.equal(current?.inputRevision, '2'); assert.equal(current?.fencingToken, '1')
      await assert.rejects(repo.withTurnLease({ ...lease, expectedInputRevision: lease.inputRevision }, async () => assert.fail('old input')), { code: 'LEASE_REJECTED' })
      await Promise.all([core.cancel(ownerId, scope.turnId), repo.renewTurnLease({ ...lease, leaseDurationMs: 60000 })])
      assert.equal((await inspect(scope)).cancelled, true)
      assert.equal(await repo.renewTurnLease({ ...lease, leaseDurationMs: 60000 }), null)
      assert.equal(await repo.claimTurnLease({ ...scope, leaseOwner: 'new', leaseDurationMs: 60000 }), null)
      await assert.rejects(repo.withTurnLease({ ...lease, expectedInputRevision: agentCoreDecimal('2') }, async () => assert.fail('cancel intent')), { code: 'LEASE_REJECTED' })
      assert.equal(await repo.releaseTurnLease(lease), true)
      assert.equal((await inspect(scope)).cancelled, true); assert.equal((await inspect(scope)).status, 'running')
    })

    await t.test('event insertion error rolls back lease, fence, revision and cursor together', async () => {
      const scope = await makeScope()
      await fixturePool.query("INSERT INTO agent_session_events(session_id,turn_id,cursor,entity_revision,event_type,payload) VALUES($1,$2,1,1,'turn.updated','{}')", [scope.sessionId, scope.turnId])
      const before = await inspect(scope)
      await assert.rejects(take(scope), { code: '23505' })
      assert.deepEqual(await inspect(scope), before)
    })

    await t.test('SQL error after a round insert rolls back the round and leaves the lease intact', async () => {
      const scope = await makeScope(), lease = await take(scope), before = await inspect(scope)
      await assert.rejects(repo.withTurnLease({ ...lease, expectedInputRevision: lease.inputRevision }, async c => {
        await c.query(roundSQL, [scope.sessionId, scope.turnId, 'c'.repeat(64)])
        await c.query('SELECT 1/0')
      }), { code: '22012' })
      assert.deepEqual(await inspect(scope), before)
    })

    await t.test('final DB-clock guard rolls back a round when SQL work outlasts the lease', async () => {
      const scope = await makeScope(), lease = await take(scope), before = await inspect(scope)
      await assert.rejects(repo.withTurnLease({ ...lease, expectedInputRevision: lease.inputRevision }, async c => {
        await c.query(roundSQL, [scope.sessionId, scope.turnId, 'd'.repeat(64)])
        // Deliberate fault injection; mutating the lease is forbidden for real
        // callbacks. This avoids sleeps and exercises the final expiry check.
        await c.query('UPDATE agent_turns SET lease_until=clock_timestamp() WHERE id=$1', [scope.turnId])
      }), { code: 'LEASE_REJECTED' })
      assert.deepEqual(await inspect(scope), before)
    })

    await t.test('release remains safe after archival, pointer removal and user disablement', async () => {
      const scope = await makeScope(), lease = await take(scope)
      await fixturePool.query('UPDATE agent_sessions SET archived_at=clock_timestamp(),active_turn_id=NULL WHERE id=$1', [scope.sessionId])
      await fixturePool.query("UPDATE users SET status='disabled' WHERE id=$1", [ownerId])
      try {
        assert.equal(await repo.renewTurnLease({ ...lease, leaseDurationMs: 60000 }), null)
        assert.equal(await repo.releaseTurnLease(lease), true)
        assert.equal((await inspect(scope)).status, 'running')
      } finally { await fixturePool.query("UPDATE users SET status='active' WHERE id=$1", [ownerId]) }
    })

    await t.test('cancelled intent, disabled actor and scope mismatch reject claim, renewal and effects', async () => {
      const scope = await makeScope()
      await tx(async c => { await c.query('UPDATE agent_turns SET cancel_requested_at=clock_timestamp() WHERE id=$1', [scope.turnId]) })
      assert.equal(await repo.claimTurnLease({ ...scope, leaseOwner: 'worker', leaseDurationMs: 60000 }), null)
      await tx(async c => { await c.query('UPDATE agent_turns SET cancel_requested_at=NULL WHERE id=$1', [scope.turnId]) })
      const stored = (await fixturePool.query<{ revision: string; fencing_token: string }>('SELECT revision::text,fencing_token::text FROM agent_turns WHERE id=$1', [scope.turnId])).rows[0]!
      const invalidOwner = { ...scope, ownerId: randomUUID() }
      assert.equal(await repo.claimTurnLease({ ...invalidOwner, leaseOwner: 'worker', leaseDurationMs: 60000 }), null)
      const invalidTurn = { ...scope, turnId: randomUUID() }
      assert.equal(await repo.claimTurnLease({ ...invalidTurn, leaseOwner: 'worker', leaseDurationMs: 60000 }), null)
      await fixturePool.query("UPDATE users SET status='disabled' WHERE id=$1", [ownerId])
      try { assert.equal(await repo.claimTurnLease({ ...scope, leaseOwner: 'worker', leaseDurationMs: 60000 }), null) }
      finally { await fixturePool.query("UPDATE users SET status='active' WHERE id=$1", [ownerId]) }
      const claimed = await take(scope)
      assert.equal(claimed.revision, agentCoreDecimal(String(BigInt(stored.revision) + 1n)))
      assert.equal(claimed.fencingToken, '1')
      await assert.rejects(repo.withTurnLease({ ...claimed, sessionId: randomUUID(), expectedInputRevision: claimed.inputRevision }, async () => assert.fail('mismatch')), { code: 'LEASE_REJECTED' })
      assert.equal(await repo.renewTurnLease({ ...claimed, leaseOwner: 'intruder', leaseDurationMs: 60000 }), null)
    })

    await t.test('deadline-passed and wrong engine turns stay unclaimed; boundary expiry does not renew', async () => {
      const scope = await makeScope()
      // deadline is immutable: create the expired snapshot initially, in the
      // same transaction that changes the active pointer to that new Turn.
      const expired = await tx(async c => {
        const sid = (await c.query<{ id: string }>('INSERT INTO agent_sessions(owner_id,agent_definition_id,definition_version) VALUES($1,$2,1) RETURNING id', [ownerId, definition])).rows[0]!.id
        const tid = (await c.query<{ id: string }>(`INSERT INTO agent_turns(session_id,client_idempotency_key,request_digest,status,config_snapshot,budget_snapshot,engine_version,deadline_at)
          VALUES($1,$2,$3,'queued','{}','{}','agent-core-v1',clock_timestamp()) RETURNING id`, [sid, randomUUID(), 'e'.repeat(64)])).rows[0]!.id
        await c.query('UPDATE agent_sessions SET active_turn_id=$2 WHERE id=$1', [sid, tid])
        return { ownerId, sessionId: sid, turnId: tid }
      })
      assert.equal(await repo.claimTurnLease({ ...expired, leaseOwner: 'worker', leaseDurationMs: 60000 }), null)
      assert.equal(await repo.claimTurnLease({ ...await makeScope('legacy'), leaseOwner: 'worker', leaseDurationMs: 60000 }), null)
      const lease = await take(scope)
      await fixturePool.query('UPDATE agent_turns SET lease_until=clock_timestamp() WHERE id=$1', [scope.turnId])
      // Repository invocation observes at-or-after expiry. Exact equality is
      // covered by the unit predicate tests; no claim of µs timing precision.
      assert.equal(await repo.renewTurnLease({ ...lease, leaseDurationMs: 60000 }), null)
    })
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`) }
    finally { await admin.end() }
  }
})
