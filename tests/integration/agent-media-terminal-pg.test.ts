import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import type pg from 'pg'
import { AgentCoreRepository } from '../../packages/database/src/repositories/agent-core'
import { runMigrations, type MigrateOptions } from '../../packages/database/src/migrations/runner'

const url = process.env.MUSECANVAS_AGENT_MEDIA_TERMINAL_PG_URL

// Source/typecheck only in this fixture lane: DO NOT execute without explicit
// authorization. Runtime use requires this dedicated opt-in URL, a fresh owned
// database and no inherited DATABASE_URL, loaded .env, Worker, Redis or Provider.
// Every SQL batch below is a raw fixture that mirrors expected consumer steps; it
// is NOT evidence that the future Agent media producer/consumer is implemented
// or correct.
test('isolated PostgreSQL: Agent media terminal/dedupe/owner/outbox fault matrix', { skip: !url, timeout: 180_000 }, async t => {
  const target = new URL(url!)
  assert.ok(target.protocol === 'postgres:' || target.protocol === 'postgresql:', 'fixture URL must use postgres or postgresql')
  assert.equal(target.hostname, '127.0.0.1', 'fixtures are loopback-only')
  assert.equal(target.username, 'fixture', 'fixtures use the dedicated fixture role')
  assert.equal(target.pathname, '/postgres', 'admin connection must target the fixture postgres database')
  const require = createRequire(new URL('../../packages/database/package.json', import.meta.url))
  const { Pool } = require('pg') as typeof import('pg')
  const admin = new Pool({ connectionString: url!, max: 1, connectionTimeoutMillis: 5000 })
  const name = `agent_media_terminal_${randomUUID().replaceAll('-', '')}`
  assert.match(name, /^agent_media_terminal_[a-f0-9]{32}$/)
  let pool: pg.Pool | undefined
  let created = false

  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    created = true
    target.pathname = `/${name}`
    pool = new Pool({ connectionString: target.toString(), max: 6, connectionTimeoutMillis: 5000, statement_timeout: 5000, lock_timeout: 3000 })
    const fixturePool = pool
    assert.deepEqual((await fixturePool.query('SELECT current_database() AS database,current_user AS actor')).rows[0], { database: name, actor: 'fixture' })
    const migration = await runMigrations({ pool: fixturePool } satisfies MigrateOptions)
    const latest = migration.latest
    assert.ok(latest && latest >= '0043', `Agent media fixture requires migrations through 0043, got ${latest}`)
    assert.deepEqual((await runMigrations({ pool: fixturePool })).applied, [])

    type FixtureClient = Pick<pg.PoolClient, 'query'>
    type Scope = { ownerId: string; sessionId: string; turnId: string; roundId: string; toolId: string; jobIds: string[] }
    type Outcome = 'duplicate' | 'waiting' | 'completed' | 'already'

    const tx = async <T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
      const client = await fixturePool.connect()
      try {
        await client.query('BEGIN')
        const value = await work(client)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    }
    const core = new AgentCoreRepository(tx, async () => { throw new Error('fixture does not admit definitions') })
    const turnPayload = async (client: FixtureClient, scope: Scope) => {
      const turn = (await client.query<{
        id: string; session_id: string; status: string; revision: string; input_revision: string
        cancel_requested_at: Date | null; terminal_at: Date | null; deadline_at: Date; engine_version: string; error: Record<string, unknown> | null
      }>(`SELECT id,session_id,status,revision::text,input_revision::text,cancel_requested_at,terminal_at,deadline_at,engine_version,error
        FROM agent_turns WHERE id=$1 AND session_id=$2 AND EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=$2 AND s.owner_id=$3)`, [scope.turnId, scope.sessionId, scope.ownerId])).rows[0]
      if (!turn) throw new Error('fixture turn disappeared')
      return { turn: {
        id: turn.id, sessionId: turn.session_id, status: turn.status, revision: turn.revision, inputRevision: turn.input_revision,
        cancelRequestedAt: turn.cancel_requested_at?.toISOString() ?? null, terminalAt: turn.terminal_at?.toISOString() ?? null,
        deadlineAt: turn.deadline_at.toISOString(), engineVersion: turn.engine_version, error: turn.error,
      } }
    }
    const oneId = async (sql: string, args: unknown[] = []): Promise<string> => {
      const row = (await fixturePool.query<{ id: string }>(sql, args)).rows[0]
      assert.ok(row)
      return row.id
    }
    const owner = (label: string) => oneId('INSERT INTO users(email) VALUES($1) RETURNING id', [`${label}-${randomUUID()}@example.invalid`])
    const definition = await oneId("INSERT INTO agent_definitions(name,version,model_policy,instructions,tool_allowlist,budget_policy) VALUES('agent-media-terminal-fixture',1,'{}','fixture','[]','{}') RETURNING id")
    const ownerA = await owner('agent-media-a')
    const model = await oneId("INSERT INTO model_configs(display_name,adapter,vendor_model_id,sizes,max_count,concurrency_limit,created_by) VALUES('agent-media-fixture','openai','fixture','[]',1,2,$1) RETURNING id", [ownerA])

    async function makeJob(ownerId: string, status: 'running' | 'succeeded' | 'failed' | 'canceled' = 'running'): Promise<string> {
      return oneId(`INSERT INTO generation_jobs(created_by,model_id,model_name,adapter,vendor_model_id,size,count,idempotency_key,status,completed_at)
        VALUES($1,$2,'fixture','openai','fixture','1024x1024',1,$3,$4::job_status,CASE WHEN $4 IN ('succeeded','failed','canceled') THEN clock_timestamp() ELSE NULL END) RETURNING id`,
      [ownerId, model, `agent-media-${randomUUID()}`, status])
    }

    async function makeScope(ownerId: string, jobCount = 1, jobStatus: 'running' | 'succeeded' | 'failed' | 'canceled' = 'running'): Promise<Scope> {
      const sessionId = await oneId('INSERT INTO agent_sessions(owner_id,agent_definition_id,definition_version) VALUES($1,$2,1) RETURNING id', [ownerId, definition])
      const turnId = await oneId(`INSERT INTO agent_turns(session_id,client_idempotency_key,request_digest,status,config_snapshot,budget_snapshot,engine_version,deadline_at)
        VALUES($1,$2,$3,'waiting_tools','{}','{}','agent-core-v1',clock_timestamp()+interval '5 minutes') RETURNING id`,
      [sessionId, randomUUID(), 'a'.repeat(64)])
      await fixturePool.query('UPDATE agent_sessions SET active_turn_id=$2 WHERE id=$1 AND owner_id=$3', [sessionId, turnId, ownerId])
      const roundId = await oneId(`INSERT INTO agent_model_rounds(session_id,turn_id,position,request_digest,input_revision,status,model_reference_id)
        VALUES($1,$2,1,$3,1,'recorded','fixture') RETURNING id`, [sessionId, turnId, 'b'.repeat(64)])
      const toolId = await oneId(`INSERT INTO agent_tool_calls(session_id,turn_id,round_id,position,provider_call_id,tool_name,tool_schema_version,arguments,arguments_hash,status,idempotency_key)
        VALUES($1,$2,$3,0,$4,'generate_image',1,'{}',$5,'waiting_external',$4) RETURNING id`,
      [sessionId, turnId, roundId, `call-${randomUUID()}`, 'c'.repeat(64)])
      const jobIds: string[] = []
      for (let position = 0; position < jobCount; position += 1) {
        const jobId = await makeJob(ownerId, jobStatus)
        await fixturePool.query(`INSERT INTO agent_tool_job_links(tool_call_id,session_id,turn_id,owner_id,media_job_id,position,dependency_role)
          VALUES($1,$2,$3,$4,$5,$6,'output')`, [toolId, sessionId, turnId, ownerId, jobId, position])
        jobIds.push(jobId)
      }
      return { ownerId, sessionId, turnId, roundId, toolId, jobIds }
    }

    async function inspect(scope: Scope, consumer: string) {
      const row = (await fixturePool.query<{
        turn_status: string; turn_revision: string; terminal_at: Date | null; active_turn_id: string | null
        next_item_sequence: string; next_event_cursor: string; tool_status: string; tool_updated_at: Date
        items: number; events: number; consumed: number; outbox: number
      }>(`SELECT t.status AS turn_status,t.revision::text AS turn_revision,t.terminal_at,s.active_turn_id,
        s.next_item_sequence::text AS next_item_sequence,s.next_event_cursor::text AS next_event_cursor,
        tc.status AS tool_status,tc.updated_at AS tool_updated_at,
        (SELECT count(*)::int FROM agent_items i WHERE i.session_id=s.id) AS items,
        (SELECT count(*)::int FROM agent_session_events e WHERE e.session_id=s.id) AS events,
        (SELECT count(*)::int FROM agent_consumed_events ce WHERE ce.consumer_name=$2) AS consumed,
        (SELECT count(*)::int FROM outbox_events o WHERE o.aggregate_id=t.id) AS outbox
        FROM agent_turns t JOIN agent_sessions s ON s.id=t.session_id JOIN agent_tool_calls tc ON tc.id=$3
        WHERE t.id=$1`, [scope.turnId, consumer, scope.toolId])).rows[0]
      assert.ok(row)
      return row
    }

    // Raw fixture for the expected event-consumer steps: dedupe, aggregate linked
    // job terminal state, one tool result, one turn transition/event, one wake.
    // The real consumer must perform these in one transaction and ACK only after
    // commit; this helper proves schema interactions, not that implementation.
    const consumeCompletion = async (client: FixtureClient, scope: Scope, consumer: string, eventId: string): Promise<Outcome> => {
      const claimed = await client.query('INSERT INTO agent_consumed_events(consumer_name,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [consumer, eventId])
      if (claimed.rowCount === 0) return 'duplicate'
      const unfinished = await client.query(`SELECT 1 FROM agent_tool_job_links l LEFT JOIN generation_jobs j ON j.id=l.media_job_id
        WHERE l.tool_call_id=$1 AND (j.id IS NULL OR j.status NOT IN ('succeeded','failed','canceled')) LIMIT 1`, [scope.toolId])
      if (unfinished.rowCount) return 'waiting'
      await client.query('SELECT next_item_sequence,next_event_cursor FROM agent_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE', [scope.sessionId, scope.ownerId])
      await client.query('SELECT status,revision FROM agent_turns WHERE id=$1 AND session_id=$2 FOR UPDATE', [scope.turnId, scope.sessionId])
      const tool = (await client.query<{ status: string }>('SELECT status FROM agent_tool_calls WHERE id=$1 AND turn_id=$2 AND session_id=$3 FOR UPDATE',
        [scope.toolId, scope.turnId, scope.sessionId])).rows[0]
      if (!tool) throw new Error('fixture tool disappeared')
      if (tool.status === 'completed') return 'already'
      if (tool.status !== 'waiting_external') throw new Error(`fixture tool status is ${tool.status}`)
      const sequence = (await client.query<{ sequence: string }>(`UPDATE agent_sessions SET next_item_sequence=next_item_sequence+1,updated_at=clock_timestamp()
        WHERE id=$1 AND owner_id=$2 RETURNING (next_item_sequence-1)::text AS sequence`, [scope.sessionId, scope.ownerId])).rows[0]!.sequence
      await client.query('UPDATE agent_tool_calls SET status=$2,result=$3::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND status=$4 AND turn_id=$5 AND session_id=$6',
        [scope.toolId, 'completed', JSON.stringify({ eventId }), 'waiting_external', scope.turnId, scope.sessionId])
      await client.query(`INSERT INTO agent_items(session_id,turn_id,sequence,item_type,tool_call_id,payload,content_digest)
        VALUES($1,$2,$3,'tool_result',$4,$5::jsonb,$6)`,
      [scope.sessionId, scope.turnId, sequence, scope.toolId, JSON.stringify({ eventId, status: 'completed', content: 'Agent tool completed' }), 'd'.repeat(64)])
      const revision = (await client.query<{ revision: string }>(`UPDATE agent_turns SET status='queued',revision=revision+1,updated_at=clock_timestamp()
        WHERE id=$1 AND session_id=$2 AND status='waiting_tools'
          AND EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=$2 AND s.owner_id=$3) RETURNING revision::text AS revision`,
        [scope.turnId, scope.sessionId, scope.ownerId])).rows[0]?.revision
      if (!revision) throw new Error('fixture turn was not waiting_tools')
      const cursor = (await client.query<{ cursor: string }>(`UPDATE agent_sessions SET next_event_cursor=next_event_cursor+1,updated_at=clock_timestamp()
        WHERE id=$1 AND owner_id=$2 RETURNING (next_event_cursor-1)::text AS cursor`, [scope.sessionId, scope.ownerId])).rows[0]!.cursor
      const toolEvent = (await client.query<{ id: string; turn_id: string; tool_name: string; status: string }>(
        'SELECT id,turn_id,tool_name,status FROM agent_tool_calls WHERE id=$1 AND turn_id=$2 AND session_id=$3',
        [scope.toolId, scope.turnId, scope.sessionId])).rows[0]
      if (!toolEvent) throw new Error('fixture tool disappeared after completion')
      await client.query(`INSERT INTO agent_session_events(session_id,turn_id,cursor,entity_revision,item_sequence,event_type,payload)
        VALUES($1,$2,$3,$4,$5,'tool.updated',$6::jsonb)`,
      [scope.sessionId, scope.turnId, cursor, revision, sequence, JSON.stringify({ tool: {
        id: toolEvent.id, turnId: toolEvent.turn_id, toolName: toolEvent.tool_name, status: toolEvent.status, revision,
      } })])
      await client.query(`INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key)
        VALUES('agent.turn.wake',$1,$2::jsonb,$3) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [scope.turnId, JSON.stringify({ schemaVersion: 1, sessionId: scope.sessionId, turnId: scope.turnId, revision }), `agent:${scope.turnId}:${revision}`])
      return 'completed'
    }

    await t.test('waits for every linked job, records one final tool result, and dedupes per stable consumer', async () => {
      const scope = await makeScope(ownerA, 2)
      const consumer = `fixture-consumer-${randomUUID()}`
      const first = randomUUID()
      assert.equal(await tx(client => consumeCompletion(client, scope, consumer, first)), 'waiting')
      assert.equal(await tx(client => consumeCompletion(client, scope, consumer, first)), 'duplicate')
      let stored = await inspect(scope, consumer)
      assert.equal(stored.turn_status, 'waiting_tools'); assert.equal(stored.tool_status, 'waiting_external')
      assert.equal(stored.items, 0); assert.equal(stored.events, 0); assert.equal(stored.outbox, 0); assert.equal(stored.consumed, 1)

      await tx(async client => {
        await client.query("UPDATE generation_jobs SET status='succeeded',completed_at=clock_timestamp() WHERE id=$1", [scope.jobIds[0]])
        await client.query("UPDATE generation_jobs SET status='failed',completed_at=clock_timestamp(),error_code='fixture' WHERE id=$1", [scope.jobIds[1]])
      })
      const completion = randomUUID()
      assert.equal(await tx(client => consumeCompletion(client, scope, consumer, completion)), 'completed')
      stored = await inspect(scope, consumer)
      assert.equal(stored.turn_status, 'queued'); assert.equal(stored.turn_revision, '2')
      assert.equal(stored.tool_status, 'completed'); assert.equal(stored.items, 1); assert.equal(stored.events, 1)
      assert.equal(stored.outbox, 1); assert.equal(stored.consumed, 2); assert.equal(stored.next_item_sequence, '2'); assert.equal(stored.next_event_cursor, '2')
      const wake = (await fixturePool.query<{ payload: { revision: string; sessionId: string; turnId: string } }>("SELECT payload FROM outbox_events WHERE aggregate_id=$1 AND event_type='agent.turn.wake'", [scope.turnId])).rows[0]!.payload
      assert.deepEqual(wake, { schemaVersion: 1, sessionId: scope.sessionId, turnId: scope.turnId, revision: '2' })
      const projected = await core.events(scope.ownerId, scope.sessionId, '0', 10)
      assert.equal(projected.events.length, 1)
      const projectedEvent = projected.events[0]!
      assert.equal(projectedEvent.type, 'tool.updated')
      if (projectedEvent.type !== 'tool.updated') assert.fail('fixture expected tool.updated')
      assert.deepEqual(projectedEvent.payload.tool, { id: scope.toolId, turnId: scope.turnId, toolName: 'generate_image', status: 'completed', revision: '2' })
      assert.equal(projectedEvent.entityRevision, '2')
      const projectedItems = await core.items(scope.ownerId, scope.sessionId, '0', 10)
      assert.equal(projectedItems.items.length, 1)
      assert.equal(projectedItems.items[0]!.payload.content, 'Agent tool completed')

      const beforeReplay = await inspect(scope, consumer)
      assert.equal(await tx(client => consumeCompletion(client, scope, consumer, completion)), 'duplicate')
      assert.deepEqual(await inspect(scope, consumer), beforeReplay)

      // The dedupe key is scoped by consumer name, so an unstable consumer name
      // would insert a new marker. The terminal check still prevents a second
      // result/item/wake, but production must use a deployment-stable name.
      const renamedConsumer = `fixture-consumer-${randomUUID()}`
      const beforeRename = await inspect(scope, renamedConsumer)
      assert.equal(await tx(client => consumeCompletion(client, scope, renamedConsumer, completion)), 'already')
      const afterRename = await inspect(scope, renamedConsumer)
      assert.equal(afterRename.consumed, 1)
      assert.deepEqual({ ...afterRename, consumed: 0 }, { ...beforeRename, consumed: 0 })
      assert.equal((await fixturePool.query('SELECT count(*)::int n FROM agent_items WHERE tool_call_id=$1', [scope.toolId])).rows[0].n, 1)
      assert.equal((await fixturePool.query('SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1', [scope.turnId])).rows[0].n, 1)
    })

    await t.test('failed batch leaves no consumed marker or terminal mutation; replay commits exactly once', async () => {
      const scope = await makeScope(ownerA, 1, 'succeeded')
      const consumer = `fixture-consumer-${randomUUID()}`
      const eventId = randomUUID()
      const before = await inspect(scope, consumer)
      await assert.rejects(tx(async client => {
        assert.equal(await consumeCompletion(client, scope, consumer, eventId), 'completed')
        await client.query('SELECT 1/0')
      }), { code: '22012' })
      assert.deepEqual(await inspect(scope, consumer), before)

      assert.equal(await tx(client => consumeCompletion(client, scope, consumer, eventId)), 'completed')
      const committed = await inspect(scope, consumer)
      assert.equal(committed.turn_status, 'queued'); assert.equal(committed.turn_revision, '2'); assert.equal(committed.tool_status, 'completed')
      assert.equal(committed.items, 1); assert.equal(committed.events, 1); assert.equal(committed.outbox, 1); assert.equal(committed.consumed, 1)
      assert.equal(committed.active_turn_id, scope.turnId)

      const stable = await inspect(scope, consumer)
      assert.equal(await tx(client => consumeCompletion(client, scope, consumer, eventId)), 'duplicate')
      assert.deepEqual(await inspect(scope, consumer), stable)
    })

    await t.test('owner/link composite constraints reject cross-owner and mismatched batches without partial rows', async () => {
      const ownerB = await owner('agent-media-b')
      const scopeA = await makeScope(ownerA, 0)
      const scopeB = await makeScope(ownerB, 0)
      const jobA = await makeJob(ownerA)
      const jobB = await makeJob(ownerB)
      const linkSql = `INSERT INTO agent_tool_job_links(tool_call_id,session_id,turn_id,owner_id,media_job_id,position,dependency_role)
        VALUES($1,$2,$3,$4,$5,$6,'output')`
      const countA = () => fixturePool.query<{ n: number }>('SELECT count(*)::int n FROM agent_tool_job_links WHERE tool_call_id=$1', [scopeA.toolId])

      await assert.rejects(fixturePool.query(linkSql, [scopeA.toolId, scopeA.sessionId, scopeA.turnId, ownerA, jobB, 0]), { code: '23503' })
      await assert.rejects(fixturePool.query(linkSql, [scopeA.toolId, scopeB.sessionId, scopeB.turnId, ownerB, jobB, 0]), { code: '23503' })
      await assert.rejects(fixturePool.query(linkSql, [scopeB.toolId, scopeB.sessionId, scopeB.turnId, ownerA, jobA, 0]), { code: '23503' })
      assert.equal((await countA()).rows[0]!.n, 0)

      // One statement with one valid and one foreign-owner row must insert neither.
      const secondJobA = await makeJob(ownerA)
      const secondJobB = await makeJob(ownerB)
      await assert.rejects(fixturePool.query(`INSERT INTO agent_tool_job_links(tool_call_id,session_id,turn_id,owner_id,media_job_id,position,dependency_role)
        VALUES($1,$2,$3,$4,$5,0,'output'),($1,$2,$3,$4,$6,1,'output')`,
      [scopeA.toolId, scopeA.sessionId, scopeA.turnId, ownerA, secondJobA, secondJobB]), { code: '23503' })
      assert.equal((await countA()).rows[0]!.n, 0)

      const thirdJobA = await makeJob(ownerA)
      await fixturePool.query(linkSql, [scopeA.toolId, scopeA.sessionId, scopeA.turnId, ownerA, secondJobA, 0])
      const duplicate = await fixturePool.query(`${linkSql} ON CONFLICT(tool_call_id,media_job_id) DO NOTHING`, [scopeA.toolId, scopeA.sessionId, scopeA.turnId, ownerA, secondJobA, 1])
      assert.equal(duplicate.rowCount, 0)
      await assert.rejects(fixturePool.query(linkSql, [scopeA.toolId, scopeA.sessionId, scopeA.turnId, ownerA, thirdJobA, 0]), { code: '23505' })
      await fixturePool.query(linkSql, [scopeA.toolId, scopeA.sessionId, scopeA.turnId, ownerA, thirdJobA, 1])
      const links = (await fixturePool.query<{ owner_id: string; media_job_id: string; position: number }>(
        'SELECT owner_id,media_job_id,position FROM agent_tool_job_links WHERE tool_call_id=$1 ORDER BY position', [scopeA.toolId])).rows
      assert.deepEqual(links.map(row => ({ ownerId: row.owner_id, jobId: row.media_job_id, position: row.position })), [
        { ownerId: ownerA, jobId: secondJobA, position: 0 },
        { ownerId: ownerA, jobId: thirdJobA, position: 1 },
      ])
      const scopedForB = await fixturePool.query(`SELECT count(*)::int n FROM agent_tool_job_links l JOIN agent_sessions s ON s.id=l.session_id
        WHERE l.tool_call_id=$1 AND s.owner_id=$2`, [scopeA.toolId, ownerB])
      assert.equal(scopedForB.rows[0]!.n, 0)
    })

    await t.test('terminal media job Outbox insert rolls back with the job and dedupes on the same key', async () => {
      const scope = await makeScope(ownerA, 1)
      const jobId = scope.jobIds[0]!
      const dedupeKey = `media:${jobId}:fixture-attempt:failed`
      const payload = JSON.stringify({ schemaVersion: 1, jobId })
      const outboxSql = `INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key)
        VALUES('media.job.completed',$1,$2::jsonb,$3) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`

      await assert.rejects(tx(async client => {
        const done = await client.query("UPDATE generation_jobs SET status='failed',error_code='fixture',completed_at=clock_timestamp() WHERE id=$1 AND status='running'", [jobId])
        assert.equal(done.rowCount, 1)
        await client.query(outboxSql, [jobId, payload, dedupeKey])
        await client.query('SELECT 1/0')
      }), { code: '22012' })
      const rolledBack = (await fixturePool.query<{ status: string; error_code: string | null; completed_at: Date | null }>('SELECT status,error_code,completed_at FROM generation_jobs WHERE id=$1', [jobId])).rows[0]!
      assert.deepEqual(rolledBack, { status: 'running', error_code: null, completed_at: null })
      assert.equal((await fixturePool.query('SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1', [jobId])).rows[0].n, 0)

      await tx(async client => {
        await client.query("UPDATE generation_jobs SET status='failed',error_code='fixture',completed_at=clock_timestamp() WHERE id=$1 AND status='running'", [jobId])
        await client.query(outboxSql, [jobId, payload, dedupeKey])
      })
      assert.equal((await fixturePool.query('SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1', [jobId])).rows[0].n, 1)
      await tx(client => client.query(outboxSql, [jobId, payload, dedupeKey]).then(() => undefined))
      assert.equal((await fixturePool.query('SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1', [jobId])).rows[0].n, 1)
      const event = (await fixturePool.query<{ event_type: string; payload: { schemaVersion: number; jobId: string } }>(
        'SELECT event_type,payload FROM outbox_events WHERE aggregate_id=$1', [jobId])).rows[0]!
      assert.equal(event.event_type, 'media.job.completed'); assert.deepEqual(event.payload, { schemaVersion: 1, jobId })
    })

    await t.test('terminal turn and active pointer clear are one rollback unit', async () => {
      const scope = await makeScope(ownerA, 1, 'succeeded')
      await fixturePool.query("UPDATE agent_tool_calls SET status='failed',error=$2::jsonb WHERE id=$1", [scope.toolId, JSON.stringify({ code: 'fixture' })])
      const before = await inspect(scope, 'fixture-terminal-turn')
      await assert.rejects(tx(async client => {
        const terminal = await client.query(`UPDATE agent_turns SET status='failed',terminal_at=clock_timestamp(),error=$3::jsonb
          WHERE id=$1 AND session_id=$2 AND status='waiting_tools'
            AND EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=$2 AND s.owner_id=$4)`,
        [scope.turnId, scope.sessionId, JSON.stringify({ code: 'fixture' }), scope.ownerId])
        assert.equal(terminal.rowCount, 1)
        const payload = await turnPayload(client, scope)
        const cursor = (await client.query<{ cursor: string }>(`UPDATE agent_sessions SET next_event_cursor=next_event_cursor+1,updated_at=clock_timestamp()
          WHERE id=$1 AND owner_id=$2 RETURNING (next_event_cursor-1)::text AS cursor`, [scope.sessionId, scope.ownerId])).rows[0]!.cursor
        await client.query(`INSERT INTO agent_session_events(session_id,turn_id,cursor,entity_revision,event_type,payload)
          VALUES($1,$2,$3,$4,'turn.updated',$5::jsonb)`, [scope.sessionId, scope.turnId, cursor, payload.turn.revision, JSON.stringify(payload)])
        await client.query('UPDATE agent_sessions SET active_turn_id=NULL,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2', [scope.sessionId, scope.ownerId])
        await client.query('SELECT 1/0')
      }), { code: '22012' })
      assert.deepEqual(await inspect(scope, 'fixture-terminal-turn'), before)

      await tx(async client => {
        const terminal = await client.query(`UPDATE agent_turns SET status='failed',terminal_at=clock_timestamp(),error=$3::jsonb
          WHERE id=$1 AND session_id=$2 AND status='waiting_tools'
            AND EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=$2 AND s.owner_id=$4)`,
        [scope.turnId, scope.sessionId, JSON.stringify({ code: 'fixture' }), scope.ownerId])
        assert.equal(terminal.rowCount, 1)
        const payload = await turnPayload(client, scope)
        const cursor = (await client.query<{ cursor: string }>(`UPDATE agent_sessions SET next_event_cursor=next_event_cursor+1,updated_at=clock_timestamp()
          WHERE id=$1 AND owner_id=$2 RETURNING (next_event_cursor-1)::text AS cursor`, [scope.sessionId, scope.ownerId])).rows[0]!.cursor
        await client.query(`INSERT INTO agent_session_events(session_id,turn_id,cursor,entity_revision,event_type,payload)
          VALUES($1,$2,$3,$4,'turn.updated',$5::jsonb)`, [scope.sessionId, scope.turnId, cursor, payload.turn.revision, JSON.stringify(payload)])
        await client.query('UPDATE agent_sessions SET active_turn_id=NULL,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2', [scope.sessionId, scope.ownerId])
      })
      const after = await inspect(scope, 'fixture-terminal-turn')
      assert.equal(after.turn_status, 'failed'); assert.ok(after.terminal_at); assert.equal(after.active_turn_id, null)
      assert.equal(after.events, 1); assert.equal(after.next_event_cursor, '2')
      const projected = await core.events(scope.ownerId, scope.sessionId, '0', 10)
      assert.equal(projected.events.length, 1)
      const projectedEvent = projected.events[0]!
      assert.equal(projectedEvent.type, 'turn.updated')
      if (projectedEvent.type !== 'turn.updated') assert.fail('fixture expected turn.updated')
      assert.equal(projectedEvent.entityRevision, '1')
      assert.equal(projectedEvent.itemSequence, null)
      assert.equal(projectedEvent.payload.turn.id, scope.turnId)
      assert.equal(projectedEvent.payload.turn.sessionId, scope.sessionId)
      assert.equal(projectedEvent.payload.turn.status, 'failed')
      assert.equal(projectedEvent.payload.turn.revision, '1')
      assert.equal(projectedEvent.payload.turn.inputRevision, '0')
      assert.equal(projectedEvent.payload.turn.engineVersion, 'agent-core-v1')
      assert.ok(projectedEvent.payload.turn.deadlineAt)
      assert.ok(projectedEvent.payload.turn.terminalAt)
      assert.equal(projectedEvent.payload.turn.error?.code, 'TOOL_FAILED')
      await assert.rejects(fixturePool.query("UPDATE agent_turns SET status='queued',terminal_at=NULL WHERE id=$1", [scope.turnId]), /cannot reopen/)
    })
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`) }
    finally { await admin.end() }
  }
})
