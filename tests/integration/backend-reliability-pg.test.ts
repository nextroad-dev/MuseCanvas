import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { runMigrations } from '../../packages/database/src/migrations/runner'
import { acquireWorkerLease, releaseWorkerLease, renewWorkerLease, updateProviderRunState } from '../../packages/database/src/repositories/provider-runs'
import { pruneOutbox } from '../../scripts/prune-outbox'

const url = process.env.MUSECANVAS_OPTIMIZATION_PG_URL
const require = createRequire(new URL('../../packages/database/package.json', import.meta.url))

// Never connect using inherited DATABASE_URL/REDIS_URL or read .env. Only an
// explicit loopback fixture can opt in; each run owns a new database.
test('isolated PostgreSQL: migrations, leases, rollback, microseconds and index plans', { skip: !url, timeout: 180_000 }, async t => {
  const target = new URL(url!)
  assert.equal(target.hostname, '127.0.0.1')
  assert.equal(target.username, 'fixture')
  assert.equal(target.pathname, '/postgres')
  const { Pool } = require('pg') as typeof import('pg')
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const name = `optimization_${randomUUID().replaceAll('-', '')}`
  assert.match(name, /^optimization_[a-f0-9]{32}$/)
  await admin.query(`CREATE DATABASE "${name}"`)
  target.pathname = `/${name}`
  const previousDb = process.env.DATABASE_URL
  const previousRedis = process.env.REDIS_URL
  process.env.DATABASE_URL = target.toString()
  process.env.REDIS_URL = 'redis://127.0.0.1:1/15'
  // Override inherited connection configuration before Worker clients exist.
  const { dispatchOutbox } = await import('../../apps/worker/src/queue/index')
  const { assertWorkerSchema, WorkerSchemaRequiredError } = await import('../../apps/worker/src/shared/schema-preflight')
  const { redis } = await import('../../apps/worker/src/shared/infra')
  const pool = new Pool({ connectionString: target.toString(), max: 6, connectionTimeoutMillis: 5000, statement_timeout: 60_000 })
  const report: Record<string, unknown> = { engine: 'PostgreSQL 17', fixture: true }
  try {
    const migration = await runMigrations({ pool })
    assert.equal(migration.latest, '0043')
    await assertWorkerSchema(pool)
    assert.deepEqual((await runMigrations({ pool })).applied, [])
    const owners = (await pool.query("INSERT INTO users(email) SELECT 'fixture-'||g||'@example.invalid' FROM generate_series(1,100) g RETURNING id")).rows.map(row => String(row.id))
    const actor = owners[0]!
    const model = (await pool.query("INSERT INTO model_configs(display_name,adapter,vendor_model_id,sizes,max_count,concurrency_limit,created_by) VALUES('fixture','openai','fixture','[]',1,2,$1) RETURNING id", [actor])).rows[0].id
    const job = (await pool.query("INSERT INTO generation_jobs(created_by,model_id,model_name,adapter,vendor_model_id,size,count,idempotency_key,status) VALUES($1,$2,'fixture','openai','fixture','1024x1024',1,'fixture','running') RETURNING id", [actor, model])).rows[0].id

    await t.test('real transaction rejects a missing bind, rolls back, then accepts the corrected bind', async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query("UPDATE users SET email='temporary@example.invalid' WHERE id=$1", [actor])
        await assert.rejects(client.query("UPDATE media_uploads SET status='deleted' WHERE created_by=$1"))
        await assert.rejects(client.query('SELECT 1'), { code: '25P02' })
        await client.query('ROLLBACK')
        assert.equal((await client.query('SELECT email FROM users WHERE id=$1', [actor])).rows[0].email, 'fixture-1@example.invalid')
        await client.query('BEGIN')
        await client.query("UPDATE media_uploads SET status='deleted' WHERE created_by=$1", [actor])
        await client.query("UPDATE users SET email='committed@example.invalid' WHERE id=$1", [actor])
        await client.query('COMMIT')
        assert.equal((await client.query('SELECT email FROM users WHERE id=$1', [actor])).rows[0].email, 'committed@example.invalid')
      } finally { await client.query('ROLLBACK'); client.release() }
    })

    await t.test('two dispatchers claim disjoint rows and recover an expired claim', async () => {
      await pool.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) SELECT 'generation.requested',$1,'{}' FROM generate_series(1,200)", [job])
      const sent: string[] = []
      const send = t.mock.method(redis, 'xAdd', async (_key: string, _id: string, payload: { eventId: string }) => {
        sent.push(payload.eventId)
        await new Promise(resolve => setTimeout(resolve, 2))
        return '1-0'
      })
      try {
        await Promise.all([dispatchOutbox(pool), dispatchOutbox(pool)])
        assert.equal(sent.length, 200)
        assert.equal(new Set(sent).size, 200)
        assert.equal((await pool.query('SELECT count(*)::int n FROM outbox_events WHERE dispatched_at IS NOT NULL')).rows[0].n, 200)
        const event = (await pool.query("INSERT INTO outbox_events(event_type,aggregate_id,payload,dispatch_token,dispatch_lease_expires_at) VALUES('generation.retry',$1,'{}',$2,now()+interval '1 minute') RETURNING id", [job, randomUUID()])).rows[0].id
        await dispatchOutbox(pool)
        assert.equal(sent.length, 200, 'an active claim cannot be stolen')
        await pool.query("UPDATE outbox_events SET dispatch_lease_expires_at=now()-interval '1 second' WHERE id=$1", [event])
        await dispatchOutbox(pool)
        assert.equal(sent.at(-1), event)
      } finally { send.mock.restore() }
    })

    await t.test('unknown and malformed events are durably quarantined and cannot starve the next real command', async () => {
      const unknown = (await pool.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) SELECT 'fixture.unknown',$1,'{}' FROM generate_series(1,100) RETURNING id", [job])).rows
      const malformed = (await pool.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('generation.requested',$1,'[]') RETURNING id", [job])).rows[0].id
      const valid = (await pool.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('generation.requested',$1,'{}') RETURNING id", [job])).rows[0].id
      const sent: string[] = []
      const send = t.mock.method(redis, 'xAdd', async (_key: string, _id: string, payload: { eventId: string }) => { sent.push(payload.eventId); return '1-0' })
      const log = t.mock.method(console, 'warn', () => {})
      try {
        await dispatchOutbox(pool)
        await dispatchOutbox(pool)
        await dispatchOutbox(pool)
        assert.deepEqual(sent, [valid])
        const quarantined = (await pool.query('SELECT id,dispatched_at,dispatch_token,dispatch_lease_expires_at,quarantined_at,quarantine_code FROM outbox_events WHERE id=ANY($1::uuid[])', [[...unknown.map(row => row.id), malformed]])).rows
        assert.equal(quarantined.length, 101)
        for (const row of quarantined) {
          assert.ok(row.quarantined_at)
          assert.equal(row.dispatched_at, null)
          assert.equal(row.dispatch_token, null)
          assert.equal(row.dispatch_lease_expires_at, null)
          assert.equal(row.quarantine_code, row.id === malformed ? 'INVALID_PAYLOAD' : 'UNKNOWN_EVENT_TYPE')
        }
      } finally { send.mock.restore(); log.mock.restore() }
    })

    await t.test('expired provider ownership cannot renew, mutate state or release its replacement', async () => {
      const run = (await pool.query("INSERT INTO provider_runs(job_id,plugin_id,client_token) VALUES($1,'fixture','fixture') RETURNING id", [job])).rows[0].id
      assert.ok(await acquireWorkerLease(pool, { runId: run, leaseToken: 'old', leaseDurationSeconds: 60 }))
      await pool.query("UPDATE provider_runs SET worker_lease_expires_at=now()-interval '1 second' WHERE id=$1", [run])
      assert.equal(await renewWorkerLease(pool, { runId: run, leaseToken: 'old' }), false)
      assert.ok(await acquireWorkerLease(pool, { runId: run, leaseToken: 'new' }))
      assert.equal(await updateProviderRunState(pool, { runId: run, expectedStateRevision: 1, leaseToken: 'old', operationState: 'failed' }), null)
      assert.ok(await updateProviderRunState(pool, { runId: run, expectedStateRevision: 1, leaseToken: 'new', operationState: 'waiting' }))
      assert.equal(await releaseWorkerLease(pool, run, 'old'), false)
      assert.equal(await renewWorkerLease(pool, { runId: run, leaseToken: 'new' }), true)
    })

    await t.test('Agent 0041/0042/0043 DDL can be rerun against the migrated schema', async () => {
      for (let pass = 0; pass < 2; pass++) {
        for (const filename of ['0041_agent_core.sql', '0042_agent_ledgers_outbox_quarantine.sql', '0043_agent_control_plane.sql']) {
          await pool.query(await readFile(new URL(`../../packages/database/migrations/${filename}`, import.meta.url), 'utf8'))
        }
      }
    })

    await t.test('Agent 0043 receipt, retention, approval and owner-scope DDL is present', async () => {
      assert.equal((await pool.query("SELECT to_regclass('agent_session_requests') relation, to_regclass('agent_message_receipts') message_relation")).rows[0].relation, 'agent_session_requests')
      assert.equal((await pool.query("SELECT to_regclass('agent_message_receipts') relation")).rows[0].relation, 'agent_message_receipts')
      const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='agent_sessions' AND column_name='event_retention_floor'")
      assert.equal(columns.rows.length, 1)
      const indexes = await pool.query("SELECT indexname FROM pg_indexes WHERE indexname LIKE 'agent_%receipt%_idx'")
      assert.ok(indexes.rows.length >= 1)
      const quarantineIndex = (await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='outbox_pending_dispatch_v2_idx'")).rows[0]
      assert.match(quarantineIndex.indexdef, /dispatched_at IS NULL/)
      assert.match(quarantineIndex.indexdef, /quarantined_at IS NULL/)

    })

    await t.test('Agent definition scope, immutable versions, active-turn uniqueness and bigint fences', async () => {
      const digest = 'a'.repeat(64)
      const definition = (await pool.query("INSERT INTO agent_definitions(name,version,model_policy,instructions,tool_allowlist,budget_policy) VALUES('core-fixture',1,'{}','original','[]','{}') RETURNING id")).rows[0].id
      await assert.rejects(pool.query("INSERT INTO agent_definitions(name,version,model_policy,instructions,tool_allowlist,budget_policy) VALUES('core-fixture',1,'{}','duplicate','[]','{}')"), { code: '23505' })
      await assert.rejects(pool.query("UPDATE agent_definitions SET instructions='changed' WHERE id=$1", [definition]), /immutable/)
      await pool.query("UPDATE agent_definitions SET status='retired' WHERE id=$1", [definition])
      await assert.rejects(pool.query('DELETE FROM agent_definitions WHERE id=$1', [definition]), /immutable/)
      const scopedDefinition = (await pool.query("INSERT INTO agent_definitions(owner_id,name,version,model_policy,instructions,tool_allowlist,budget_policy) VALUES($1,'private-fixture',1,'{}','private','[]','{}') RETURNING id", [actor])).rows[0].id
      await assert.rejects(pool.query('INSERT INTO agent_sessions(owner_id,agent_definition_id,definition_version) VALUES($1,$2,1)', [owners[1], scopedDefinition]), /owner scope/)
      await assert.rejects(pool.query('INSERT INTO agent_sessions(owner_id,agent_definition_id,definition_version) VALUES($1,$2,2)', [actor, definition]))
      const makeSession = async (owner = actor) => (await pool.query('INSERT INTO agent_sessions(owner_id,agent_definition_id,definition_version) VALUES($1,$2,1) RETURNING id', [owner, definition])).rows[0].id as string
      const makeTurn = async (session: string, key = randomUUID()) => (await pool.query("INSERT INTO agent_turns(session_id,client_idempotency_key,request_digest,status,config_snapshot,budget_snapshot,engine_version,deadline_at) VALUES($1,$2,$3,'queued','{}','{}','agent-core-v1',now()+interval '1 hour') RETURNING id", [session, key, digest])).rows[0].id as string
      const session = await makeSession()
      const competition = await Promise.allSettled([makeTurn(session), makeTurn(session)])
      assert.equal(competition.filter(result => result.status === 'fulfilled').length, 1)
      const loser = competition.find(result => result.status === 'rejected') as PromiseRejectedResult
      assert.equal(loser.reason.code, '23505')
      const turn = (competition.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<string>).value
      const otherSession = await makeSession(owners[1])
      const otherTurn = await makeTurn(otherSession)
      await assert.rejects(pool.query('UPDATE agent_sessions SET active_turn_id=$1 WHERE id=$2', [otherTurn, session]), { code: '23503' })
      await pool.query('UPDATE agent_sessions SET active_turn_id=$1 WHERE id=$2', [turn, session])
      await pool.query("UPDATE agent_turns SET status='running',lease_owner='old',lease_until=now()+interval '1 minute',fencing_token=1 WHERE id=$1", [turn])
      await pool.query("UPDATE agent_turns SET lease_until=now()+interval '2 minutes' WHERE id=$1", [turn])
      assert.equal((await pool.query('SELECT fencing_token::text FROM agent_turns WHERE id=$1', [turn])).rows[0].fencing_token, '1')
      await pool.query("UPDATE agent_turns SET lease_until=now()-interval '1 second' WHERE id=$1", [turn])
      await assert.rejects(pool.query("UPDATE agent_turns SET lease_owner='new',lease_until=now()+interval '1 minute' WHERE id=$1", [turn]), /next fencing token/)
      await pool.query("UPDATE agent_turns SET lease_owner='new',lease_until=now()+interval '1 minute',fencing_token=2 WHERE id=$1", [turn])
      await assert.rejects(pool.query('UPDATE agent_turns SET fencing_token=1 WHERE id=$1', [turn]), /nonmonotonic/)
      await assert.rejects(pool.query('UPDATE agent_turns SET config_snapshot=$1::jsonb WHERE id=$2', [{ changed: true }, turn]), /immutable/)
      await pool.query('UPDATE agent_turns SET lease_owner=NULL,lease_until=NULL WHERE id=$1', [turn])
      await pool.query("UPDATE agent_turns SET status='completed',terminal_at=now() WHERE id=$1", [turn])
      await assert.rejects(pool.query("UPDATE agent_turns SET status='queued',terminal_at=NULL WHERE id=$1", [turn]), /cannot reopen/)

      const makeRound = async (turnId: string, sessionId: string, position: number) => (await pool.query("INSERT INTO agent_model_rounds(session_id,turn_id,position,request_digest,input_revision,status,model_reference_id) VALUES($1,$2,$3,$4,0,'recorded','fixture') RETURNING id", [sessionId, turnId, position, digest])).rows[0].id
      const round = await makeRound(turn, session, 1)
      const round2 = await makeRound(turn, session, 2)
      const otherRound = await makeRound(otherTurn, otherSession, 1)
      const makeTool = async (roundId: string, call: string) => (await pool.query("INSERT INTO agent_tool_calls(session_id,turn_id,round_id,position,provider_call_id,tool_name,tool_schema_version,arguments,arguments_hash,status,idempotency_key) VALUES($1,$2,$3,0,$4,'generate_image',1,'{}',$5,'recorded',$4) RETURNING id", [session, turn, roundId, call, digest])).rows[0].id
      await assert.rejects(makeTool(otherRound, 'cross-round'), { code: '23503' })
      const tool = await makeTool(round, 'call-1')
      await assert.rejects(makeTool(round2, 'call-1'), { code: '23505' })
      await assert.rejects(pool.query('UPDATE agent_tool_calls SET arguments_hash=$1 WHERE id=$2', ['b'.repeat(64), tool]), /immutable/)
      await pool.query("UPDATE agent_tool_calls SET status='completed',result='{}' WHERE id=$1", [tool])
      await assert.rejects(pool.query('UPDATE agent_tool_calls SET result=$1::jsonb WHERE id=$2', [{ changed: true }, tool]), /already final/)
      const itemSql = "INSERT INTO agent_items(session_id,turn_id,sequence,item_type,tool_call_id,payload,content_digest) VALUES($1,$2,$3,'tool_result',$4,'{}',$5)"
      await assert.rejects(pool.query(itemSql, [otherSession, otherTurn, 1, tool, digest]), { code: '23503' })
      await pool.query(itemSql, [session, turn, 1, tool, digest])
      await assert.rejects(pool.query(itemSql, [session, turn, 2, tool, digest]), { code: '23505' })
      await pool.query("INSERT INTO agent_session_events(session_id,turn_id,cursor,event_type,payload) VALUES($1,$2,9007199254740993,'turn.updated','{}')", [session, turn])
      assert.equal((await pool.query('SELECT cursor::text FROM agent_session_events WHERE session_id=$1', [session])).rows[0].cursor, '9007199254740993')
      await pool.query('UPDATE agent_sessions SET next_event_cursor=9007199254740994 WHERE id=$1', [session])
      await assert.rejects(pool.query('UPDATE agent_sessions SET next_event_cursor=1 WHERE id=$1', [session]), /nonmonotonic/)

      const foreignJob = (await pool.query("INSERT INTO generation_jobs(created_by,model_id,model_name,adapter,vendor_model_id,size,count,idempotency_key) VALUES($1,$2,'fixture','openai','fixture','1024x1024',1,'foreign-agent-job') RETURNING id", [owners[1], model])).rows[0].id
      const linkSql = "INSERT INTO agent_tool_job_links(tool_call_id,session_id,turn_id,owner_id,media_job_id,position,dependency_role) VALUES($1,$2,$3,$4,$5,0,'output')"
      await assert.rejects(pool.query(linkSql, [tool, session, turn, actor, foreignJob]), { code: '23503' })
      await pool.query(linkSql, [tool, session, turn, actor, job])
      const foreignCanvas = (await pool.query("INSERT INTO canvas_documents(created_by,title) VALUES($1,'foreign') RETURNING id", [owners[1]])).rows[0].id
      await assert.rejects(pool.query('UPDATE agent_sessions SET default_canvas_id=$1 WHERE id=$2', [foreignCanvas, session]), { code: '23503' })
      const reserveSql = "INSERT INTO agent_budget_reservations(session_id,turn_id,tool_call_id,round_id,quota,reserved_amount,currency,pricing_revision,status,idempotency_key) VALUES($1,$2,$3,$4,'estimated_cost',0.1,'USD','pricing-1','reserved',$5) RETURNING id"
      await assert.rejects(pool.query(reserveSql, [session, turn, tool, round2, 'wrong-round']), { code: '23503' })
      const reservation = (await pool.query(reserveSql, [session, turn, tool, round, 'reservation-1'])).rows[0].id
      const approvalSql = "INSERT INTO agent_approvals(session_id,turn_id,tool_call_id,arguments_hash,model_revision,pricing_revision,reservation_id,status,expires_at) VALUES($1,$2,$3,$4,'model-1',$5,$6,'pending',now()+interval '1 minute')"
      await assert.rejects(pool.query(approvalSql, [session, turn, tool, 'b'.repeat(64), 'pricing-1', reservation]), { code: '23503' })
      await assert.rejects(pool.query(approvalSql, [session, turn, tool, digest, 'pricing-2', reservation]), { code: '23503' })
      await pool.query(approvalSql, [session, turn, tool, digest, 'pricing-1', reservation])
      const usageSql = "INSERT INTO agent_usage_entries(session_id,turn_id,reservation_id,settlement_key,usage_kind,amount,currency) VALUES($1,$2,$3,'settle-1','actual',0.1,'USD')"
      await pool.query(usageSql, [session, turn, reservation])
      await assert.rejects(pool.query(usageSql, [session, turn, reservation]), { code: '23505' })
      const event = randomUUID()
      await pool.query("INSERT INTO agent_consumed_events(consumer_name,event_id) VALUES('fixture',$1)", [event])
      await assert.rejects(pool.query("INSERT INTO agent_consumed_events(consumer_name,event_id) VALUES('fixture',$1)", [event]), { code: '23505' })
      await pool.query('INSERT INTO agent_legacy_links(owner_id,client_request_key,request_digest,engine_version,agent_session_id,agent_turn_id) VALUES($1,$2,$3,$4,$5,$6)', [actor, 'request-1', digest, 'agent-core-v1', session, turn])
      await assert.rejects(pool.query('UPDATE agent_legacy_links SET request_digest=$1 WHERE owner_id=$2', ['b'.repeat(64), actor]), /immutable/)
    })

    await t.test('published Outbox event redelivers the same eventId after failed confirmation', async () => {
      const event = (await pool.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('generation.retry',$1,'{}') RETURNING id", [job])).rows[0].id
      const query = pool.query.bind(pool)
      let fail = true
      const queryMock = t.mock.method(pool, 'query', async (sql: string, values: unknown[]) => {
        if (fail && sql.startsWith('UPDATE outbox_events SET dispatched_at=now()')) { fail = false; throw new Error('fixture-confirmation-failure') }
        return query(sql, values)
      })
      const sent: string[] = []
      const send = t.mock.method(redis, 'xAdd', async (_key: string, _id: string, payload: { eventId: string }) => { sent.push(payload.eventId); return '1-0' })
      try {
        await dispatchOutbox(pool)
        assert.equal((await query('SELECT dispatched_at FROM outbox_events WHERE id=$1', [event])).rows[0].dispatched_at, null)
        await dispatchOutbox(pool)
        assert.deepEqual(sent.filter(id => id === event), [event, event])
        assert.ok((await query('SELECT dispatched_at FROM outbox_events WHERE id=$1', [event])).rows[0].dispatched_at)
      } finally { queryMock.mock.restore(); send.mock.restore() }
    })

    await t.test('microsecond tuple pagination returns tied timestamps exactly once', async () => {
      await pool.query("INSERT INTO assets(created_by,job_id,object_key,mime_type,width,height,size_bytes,checksum,created_at) SELECT $1,$2,'micro/'||g,'image/png',1,1,1,'fixture','2026-10-18T00:00:00.123456Z' FROM generate_series(1,6) g", [actor, job])
      const ids: string[] = []
      let boundary: { id: string; stamp: string } | undefined
      for (let page = 0; page < 3; page++) {
        const rows = (await pool.query(`SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') stamp FROM assets WHERE object_key LIKE 'micro/%' ${boundary ? 'AND (created_at,id)<($1::timestamptz,$2::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT 2`, boundary ? [boundary.stamp, boundary.id] : [])).rows
        assert.equal(rows.length, 2)
        assert.equal(rows[1].stamp, '2026-10-18T00:00:00.123456Z')
        ids.push(...rows.map(row => row.id))
        boundary = rows[1] as { id: string; stamp: string }
      }
      assert.equal(new Set(ids).size, 6)
    })

    await t.test('constraint indexes retain backward scans after removing redundant ordering indexes', async () => {
      await pool.query("INSERT INTO model_config_revisions(model_id,revision,provider_id,plugin_id,snapshot_digest) SELECT $1,g,'fixture','fixture','fixture-'||g FROM generate_series(1,1000) g", [model])
      await pool.query("INSERT INTO provider_runs(job_id,attempt,plugin_id,client_token) SELECT $1,g,'fixture','fixture-'||g FROM generate_series(2,1001) g", [job])
      const plans = []
      for (const spec of [
        { table: 'model_config_revisions', parent: 'model_id', order: 'revision', value: model, redundant: 'model_config_revisions_model_idx' },
        { table: 'provider_runs', parent: 'job_id', order: 'attempt', value: job, redundant: 'provider_runs_job_idx' },
      ]) {
        await pool.query(`ANALYZE ${spec.table}`)
        const plan = (await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM ${spec.table} WHERE ${spec.parent}=$1 ORDER BY ${spec.order} DESC LIMIT 1`, [spec.value])).rows[0]['QUERY PLAN'][0]
        assert.ok(JSON.stringify(plan).includes('Backward'))
        assert.ok(JSON.stringify(plan).includes('_key'))
        assert.equal((await pool.query('SELECT to_regclass($1) AS relation', [spec.redundant])).rows[0].relation, null)
        plans.push({ table: spec.table, plan })
      }
      report.redundantIndexes = plans
    })

    await t.test('outbox cleanup defaults to dry-run and deletes only old confirmed, unleased events', async () => {
      const rows = (await pool.query(`INSERT INTO outbox_events(event_type,aggregate_id,payload,dispatched_at,dispatch_token,dispatch_lease_expires_at)
        VALUES ('prune',$1,'{}',now()-interval '40 days',NULL,NULL),
          ('prune',$1,'{}',NULL,NULL,NULL),
          ('prune',$1,'{}',now()-interval '40 days',$2,now()+interval '1 minute'),
          ('prune',$1,'{}',now()-interval '1 day',NULL,NULL) RETURNING id`, [job, randomUUID()])).rows
      assert.deepEqual(await pruneOutbox(pool, { days: 30, limit: 100, execute: false }), { eligible: 1, deleted: 0 })
      assert.equal((await pool.query("SELECT count(*)::int n FROM outbox_events WHERE event_type='prune'")).rows[0].n, 4)
      assert.deepEqual(await pruneOutbox(pool, { days: 30, limit: 100, execute: true }), { eligible: 1, deleted: 1 })
      assert.deepEqual((await pool.query("SELECT id FROM outbox_events WHERE event_type='prune' ORDER BY id")).rows.map(row => row.id), rows.slice(1).map(row => row.id).sort())
    })

    await t.test('compare representative 100k-row asset and 200k-row outbox plans', async () => {
      await pool.query("INSERT INTO assets(created_by,job_id,object_key,mime_type,width,height,size_bytes,checksum,created_at,deleted_at) SELECT ($1::uuid[])[1+(g%100)],$2,'benchmark/'||g,'image/png',1,1,1,'fixture',now()-g*interval '1 microsecond',CASE WHEN g%7=0 THEN now() END FROM generate_series(1,100000) g", [owners, job])
      await pool.query("INSERT INTO outbox_events(event_type,aggregate_id,payload,created_at,dispatched_at) SELECT 'benchmark',$1,'{}',now()-g*interval '1 second',CASE WHEN g%1000<>0 THEN now() END FROM generate_series(1,200000) g", [job])
      const sample = async (sql: string, values: unknown[]) => {
        const plans = []
        for (let i = 0; i < 3; i++) plans.push((await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values)).rows[0]['QUERY PLAN'][0])
        plans.sort((a, b) => a['Execution Time'] - b['Execution Time'])
        const median = plans[1]
        return { executionMs: median['Execution Time'], plan: median.Plan }
      }
      await pool.query('DROP INDEX outbox_pending_dispatch_v2_idx')
      for (const spec of [
        { key: 'assets', table: 'assets', index: 'assets_owner_active_created_idx', file: '0036_assets_owner_pagination_index.sql', sql: 'SELECT id FROM assets WHERE created_by=$1 AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 51', values: [actor] },
        { key: 'outbox', table: 'outbox_events', index: 'outbox_pending_created_idx', file: '0037_outbox_pending_dispatch_index.sql', sql: 'SELECT id FROM outbox_events WHERE dispatched_at IS NULL AND (dispatch_lease_expires_at IS NULL OR dispatch_lease_expires_at<=now()) ORDER BY created_at LIMIT 100', values: [] },
      ]) {
        // This database was created above and is owned by this test. No business
        // schema, production URL or pre-existing table is ever modified.
        await pool.query(`DROP INDEX CONCURRENTLY ${spec.index}`)
        await pool.query(`ANALYZE ${spec.table}`)
        const before = await sample(spec.sql, spec.values)
        await pool.query(await readFile(new URL(`../../packages/database/migrations/${spec.file}`, import.meta.url), 'utf8'))
        const after = await sample(spec.sql, spec.values)
        assert.ok(JSON.stringify(after.plan).includes(spec.index))
        report[spec.key] = { before, after }
        t.diagnostic(`${spec.key} synthetic warm median execution: ${before.executionMs}ms -> ${after.executionMs}ms`)
      }
      await pool.query('CREATE INDEX outbox_pending_dispatch_v2_idx ON outbox_events(created_at) WHERE dispatched_at IS NULL AND quarantined_at IS NULL')
      await mkdir(new URL('../../.runtime/', import.meta.url), { recursive: true })
      await writeFile(new URL('../../.runtime/backend-benchmark.json', import.meta.url), JSON.stringify(report, null, 2))
    })
    await t.test('Agent admission and model-admin audit do not deadlock; actor status changes remain serialized (opt-in PG)', async () => {
      const { AgentCoreRepository } = await import('../../packages/database/src/repositories/agent-core')
      const definition = (await pool.query("INSERT INTO agent_definitions(name,version,model_policy,instructions,tool_allowlist,budget_policy) VALUES('p4-lock-fixture',1,'{}','fixture','[]','{}') RETURNING id")).rows[0].id
      const admission = await pool.connect(), admin = await pool.connect()
      const admissionPid = (await admission.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
      const adminPid = (await admin.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
      const pending: Promise<unknown>[] = []
      const track = <T>(work: Promise<T>) => { pending.push(work); void work.catch(() => {}); return work }
      let mode: 'model' | 'actor' = 'model'
      let entered!: () => void, release!: () => void
      let ready = new Promise<void>(resolve => { entered = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      const waitForBlock = async (blocked: number, blocker: number) => {
        const until = Date.now() + 4000
        while (Date.now() < until) {
          const result = await pool.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [blocked, blocker])
          if (result.rows[0].blocked) return
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.fail('expected PostgreSQL lock wait was not observed')
      }
      const core = new AgentCoreRepository(async work => {
        try {
          await admission.query('BEGIN')
          await admission.query("SET LOCAL statement_timeout='5s'")
          const result = await work(admission)
          await admission.query('COMMIT'); return result
        } catch (error) { await admission.query('ROLLBACK'); throw error }
      }, async client => {
        entered() // Repository already owns the actor lock before model admission validation.
        if (mode === 'model') await client.query('SELECT id FROM model_configs WHERE id=$1 FOR SHARE', [model])
        else await gate
        return { config: {}, budget: { maxModelCalls: 4, maxToolCalls: 10, maxMediaJobs: 0, maxMediaOutputs: 0,
          maxInputTokens: '1000', maxOutputTokens: '1000', maxEstimatedCost: null, maxConcurrentMediaJobs: 0 }, timeoutMs: 30000 }
      })
      try {
        await admin.query('BEGIN')
        await admin.query("SET LOCAL statement_timeout='5s'")
        await admin.query('SELECT id FROM model_configs WHERE id=$1 FOR UPDATE', [model])
        const created = track(core.createSession(actor, { clientRequestId: 'p4-model-lock', agentDefinitionId: definition, definitionVersion: 1 }))
        await ready
        await waitForBlock(admissionPid, adminPid)
        // Admission waits for the model while admin acquires the user's FK key-share lock.
        await admin.query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,summary) VALUES($1,'fixture','model',$2,'{}')", [actor, model])
        await admin.query('COMMIT')
        assert.equal((await created).ownerId, actor)

        mode = 'actor'
        ready = new Promise<void>(resolve => { entered = resolve })
        const serialized = track(core.createSession(actor, { clientRequestId: 'p4-actor-lock', agentDefinitionId: definition, definitionVersion: 1 }))
        await ready
        await admin.query('BEGIN')
        await admin.query("SET LOCAL statement_timeout='5s'")
        const disabled = track(admin.query("UPDATE users SET status='disabled' WHERE id=$1 RETURNING status", [actor]))
        await waitForBlock(adminPid, admissionPid)
        assert.equal((await admission.query('SELECT status FROM users WHERE id=$1', [actor])).rows[0].status, 'active')
        release()
        assert.equal((await serialized).ownerId, actor)
        assert.equal((await disabled).rows[0].status, 'disabled')
        await admin.query('ROLLBACK')
        assert.equal((await pool.query('SELECT status FROM users WHERE id=$1', [actor])).rows[0].status, 'active')
      } finally {
        release()
        await admin.query('ROLLBACK')
        await Promise.allSettled(pending)
        await admission.query('ROLLBACK')
        admission.release(); admin.release()
      }
    })

    await t.test('Agent local cancellation retains waiting dependencies and wakes a future Runner (opt-in PG)', async () => {
      const { AgentCoreRepository } = await import('../../packages/database/src/repositories/agent-core')
      const definition = (await pool.query("INSERT INTO agent_definitions(name,version,model_policy,instructions,tool_allowlist,budget_policy) VALUES('p4-cancel-fixture',1,'{}','fixture','[]','{}') RETURNING id")).rows[0].id
      let validations = 0
      const core = new AgentCoreRepository(async (work, readOnly = false) => {
        const client = await pool.connect()
        try { await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN'); const result = await work(client); await client.query('COMMIT'); return result }
        catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      }, async () => {
        validations++
        return { config: {}, budget: { maxModelCalls: 4, maxToolCalls: 10, maxMediaJobs: 0, maxMediaOutputs: 0, maxInputTokens: '1000', maxOutputTokens: '1000', maxEstimatedCost: null, maxConcurrentMediaJobs: 0 }, timeoutMs: 30000 }
      })
      const cases = [
        { key: 'waiting-approval', turnStatus: 'waiting_approval', toolStatus: 'waiting_approval', approvalStatus: 'pending', reservationStatus: 'reserved', lease: false },
        { key: 'waiting-tools', turnStatus: 'waiting_tools', toolStatus: 'recorded', approvalStatus: null, reservationStatus: 'reserved', lease: false },
        { key: 'waiting-tools-lease', turnStatus: 'waiting_tools', toolStatus: 'executing', approvalStatus: null, reservationStatus: 'reserved', lease: true },
        { key: 'reserved-only', turnStatus: 'queued', toolStatus: null, approvalStatus: null, reservationStatus: 'reserved', lease: false },
        { key: 'unknown-reservation', turnStatus: 'queued', toolStatus: 'completed', approvalStatus: null, reservationStatus: 'unknown', lease: false },
      ] as const
      for (const item of cases) {
        const session = await core.createSession(actor, { clientRequestId: `p4-cancel-${item.key}`, agentDefinitionId: definition, definitionVersion: 1 })
        const message = await core.message(actor, session.id, { clientMessageId: randomUUID(), content: item.key })
        await pool.query("UPDATE agent_turns SET status=$1,lease_owner=$3,lease_until=CASE WHEN $3::text IS NULL THEN NULL ELSE clock_timestamp()+interval '1 minute' END,fencing_token=$4 WHERE id=$2",
          [item.turnStatus, message.turn.id, item.lease ? 'p4-cancel-fixture' : null, item.lease ? 1 : 0])
        const hash = 'a'.repeat(64)
        const round = (await pool.query("INSERT INTO agent_model_rounds(session_id,turn_id,position,request_digest,input_revision,status,model_reference_id) VALUES($1,$2,1,$3,1,'recorded','fixture') RETURNING id", [session.id, message.turn.id, hash])).rows[0].id
        const tool = item.toolStatus ? (await pool.query("INSERT INTO agent_tool_calls(session_id,turn_id,round_id,position,provider_call_id,tool_name,tool_schema_version,arguments,arguments_hash,status,idempotency_key) VALUES($1,$2,$3,0,$4,'fixture',1,'{}',$5,$6,$4) RETURNING id",
          [session.id, message.turn.id, round, `p4-cancel-${item.key}`, hash, item.toolStatus])).rows[0].id : null
        const reservation = (await pool.query("INSERT INTO agent_budget_reservations(session_id,turn_id,tool_call_id,round_id,quota,reserved_amount,currency,pricing_revision,status,settled_at,idempotency_key) VALUES($1,$2,$3,$4,'estimated_cost',0.1,'USD','p4-pricing',$5,CASE WHEN $5='unknown' THEN clock_timestamp() ELSE NULL END,$6) RETURNING id",
          [session.id, message.turn.id, tool, round, item.reservationStatus, `p4-reservation-${item.key}`])).rows[0].id
        if (item.approvalStatus) await pool.query("INSERT INTO agent_approvals(session_id,turn_id,tool_call_id,arguments_hash,model_revision,pricing_revision,reservation_id,status,expires_at) VALUES($1,$2,$3,$4,'fixture','p4-pricing',$5,'pending',clock_timestamp()+interval '1 minute')", [session.id, message.turn.id, tool, hash, reservation])
        const readState = async () => (await pool.query(`SELECT t.status,t.terminal_at,t.lease_owner,t.lease_until,t.fencing_token::text,s.active_turn_id,
          to_jsonb(tc) AS tool,to_jsonb(a) AS approval,to_jsonb(r) AS reservation
          FROM agent_turns t JOIN agent_sessions s ON s.id=t.session_id LEFT JOIN agent_tool_calls tc ON tc.turn_id=t.id
          LEFT JOIN agent_approvals a ON a.turn_id=t.id JOIN agent_budget_reservations r ON r.turn_id=t.id WHERE t.id=$1`, [message.turn.id])).rows[0]
        const before = await readState()
        const cancelled = await core.cancel(actor, message.turn.id)
        assert.equal(cancelled.status, item.turnStatus); assert.ok(cancelled.cancelRequestedAt); assert.equal(cancelled.revision, '2')
        assert.deepEqual(await readState(), before, `${item.key}: status/active/leases and dependencies must remain untouched`)
        assert.equal(before.active_turn_id, message.turn.id)
        const wakes = (await pool.query("SELECT payload FROM outbox_events WHERE aggregate_id=$1 AND event_type='agent.turn.wake'", [message.turn.id])).rows
        assert.equal(wakes.length, 2)
        assert.ok(wakes.some(row => row.payload.turnId === message.turn.id && row.payload.revision === '2'))
        const events = await core.events(actor, session.id, '2', 10)
        assert.equal(events.events.length, 1); assert.equal(events.events[0]!.type, 'turn.updated')
        assert.deepEqual(await core.cancel(actor, message.turn.id), cancelled)
        assert.equal((await pool.query('SELECT count(*)::int n FROM agent_usage_entries WHERE turn_id=$1', [message.turn.id])).rows[0].n, 0)
      }
      assert.equal(validations, cases.length * 2)
    })

    await t.test('P4 PG admission receipts, steering, cancellation and snapshot/cursor isolation (opt-in only)', async () => {
      const { AgentCoreRepository } = await import('../../packages/database/src/repositories/agent-core')
      const coreModelRevision = randomUUID()
      const coreDefinition = (await pool.query("INSERT INTO agent_definitions(name,version,model_policy,instructions,tool_allowlist,budget_policy) VALUES('p4-opt-in',1,'{}','fixture','[]','{}') RETURNING id")).rows[0].id
      let validations = 0
      const core = new AgentCoreRepository(async (work, readOnly = false) => {
        const client = await pool.connect()
        try {
          await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
          const result = await work(client)
          await client.query('COMMIT'); return result
        } catch (error) { await client.query('ROLLBACK'); throw error }
        finally { client.release() }
      }, async () => {
        validations++
        return { config: { modelRevisionId: coreModelRevision }, budget: { maxModelCalls: 4, maxToolCalls: 10, maxMediaJobs: 0,
          maxMediaOutputs: 0, maxInputTokens: '1000', maxOutputTokens: '1000', maxEstimatedCost: null, maxConcurrentMediaJobs: 0 }, timeoutMs: 30000 }
      })
      const input = { clientRequestId: 'p4-same-session', agentDefinitionId: coreDefinition, definitionVersion: 1 }
      const [session, replay] = await Promise.all([core.createSession(actor, input), core.createSession(actor, input)])
      assert.deepEqual(session, replay); assert.equal(validations, 1)
      await assert.rejects(core.createSession(actor, { ...input, definitionVersion: 2 }), { code: 'CONFLICT' })
      await assert.rejects(core.snapshot(owners[1]!, session.id, 10), { code: 'NOT_FOUND' })
      assert.ok((await core.listSessions(actor, 100)).sessions.some(x => x.id === session.id))
      const clientMessageId = randomUUID()
      const [message, duplicate] = await Promise.all([
        core.message(actor, session.id, { clientMessageId, content: 'first' }),
        core.message(actor, session.id, { clientMessageId, content: 'first' }),
      ])
      assert.deepEqual(message, duplicate)
      await assert.rejects(core.message(actor, session.id, { clientMessageId, content: 'altered' }), { code: 'CONFLICT' })
      assert.equal((await pool.query('SELECT count(*)::int n FROM agent_items WHERE session_id=$1', [session.id])).rows[0].n, 1)
      assert.equal((await pool.query("SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1 AND event_type='agent.turn.wake'", [message.turn.id])).rows[0].n, 1)
      const deadline = (await pool.query("SELECT deadline_at>created_at AS positive,deadline_at<=created_at+interval '31 seconds' AS bounded FROM agent_turns WHERE id=$1", [message.turn.id])).rows[0]
      assert.equal(deadline.positive, true); assert.equal(deadline.bounded, true)
      const steerId = randomUUID()
      const steered = await core.steer(actor, message.turn.id, { clientMessageId: steerId, content: 'steering' })
      assert.equal(steered.acceptedInputRevision, '2')
      const beforeCancel = await core.snapshot(actor, session.id, 1)
      assert.equal(beforeCancel.itemsHasMore, true); assert.equal(beforeCancel.nextItemsCursor, '1')
      assert.equal(beforeCancel.lastItemSequence, '2'); assert.equal(beforeCancel.eventCursor, '4')
      assert.equal((await core.items(actor, session.id, '1', 10)).items[0]!.payload.content, 'steering')
      const firstEvents = await core.events(actor, session.id, '0', 1)
      assert.equal(firstEvents.events[0]!.cursor, '1'); assert.equal(firstEvents.hasMore, true)
      assert.equal(firstEvents.highWater, beforeCancel.eventCursor)
      await assert.rejects(core.events(owners[1]!, session.id, '9223372036854775807', 10), { code: 'NOT_FOUND' })
      await assert.rejects(core.events(actor, session.id, '5', 10), { code: 'CURSOR_AHEAD' })
      const cancelled = await core.cancel(actor, message.turn.id)
      assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(await core.cancel(actor, message.turn.id), cancelled)
      assert.equal((await core.snapshot(actor, session.id, 10)).session.activeTurnId, null)
      assert.deepEqual(await core.message(actor, session.id, { clientMessageId: steerId, content: 'steering' }, false), steered)
      assert.deepEqual(await core.message(actor, session.id, { clientMessageId, content: 'first' }, false), message)
      assert.equal((await pool.query('SELECT count(*)::int n FROM agent_items WHERE session_id=$1', [session.id])).rows[0].n, 2)
      await pool.query("UPDATE agent_definitions SET status='retired' WHERE id=$1", [coreDefinition])
      assert.deepEqual(await core.createSession(actor, input, false), session)
      await assert.rejects(core.message(actor, session.id, { clientMessageId: randomUUID(), content: 'new after retired' }), { code: 'UNAVAILABLE' })
      const prune = await pool.connect()
      try {
        await prune.query('BEGIN')
        await prune.query('SELECT id FROM agent_sessions WHERE id=$1 FOR UPDATE', [session.id])
        await prune.query('DELETE FROM agent_session_events WHERE session_id=$1 AND cursor<=2', [session.id])
        await prune.query('UPDATE agent_sessions SET event_retention_floor=2 WHERE id=$1', [session.id])
        await prune.query('COMMIT')
      } catch (error) { await prune.query('ROLLBACK'); throw error } finally { prune.release() }
      assert.equal((await core.events(actor, session.id, '0', 10)).resyncRequired, true)
      assert.equal((await core.events(actor, session.id, '2', 10)).resyncRequired, false)
      await pool.query('DELETE FROM agent_session_events WHERE session_id=$1 AND cursor=3', [session.id])
      assert.equal((await core.events(actor, session.id, '2', 10)).resyncRequired, true)

      const activeDefinition = (await pool.query("INSERT INTO agent_definitions(name,version,model_policy,instructions,tool_allowlist,budget_policy) VALUES('p4-running',1,'{}','fixture','[]','{}') RETURNING id")).rows[0].id
      const another = await core.createSession(actor, { clientRequestId: 'p4-running', agentDefinitionId: activeDefinition, definitionVersion: 1 })
      const running = await core.message(actor, another.id, { clientMessageId: randomUUID(), content: 'running' })
      await pool.query("UPDATE agent_turns SET status='running',lease_owner='p4-fixture',lease_until=clock_timestamp()+interval '1 minute',fencing_token=1 WHERE id=$1", [running.turn.id])
      assert.equal((await core.cancel(actor, running.turn.id)).status, 'running')
      const lease = (await pool.query('SELECT lease_owner,fencing_token::text,cancel_requested_at FROM agent_turns WHERE id=$1', [running.turn.id])).rows[0]
      assert.equal(lease.lease_owner, 'p4-fixture'); assert.equal(lease.fencing_token, '1'); assert.ok(lease.cancel_requested_at)
      await assert.rejects(core.steer(actor, running.turn.id, { clientMessageId: randomUUID(), content: 'cannot accept after cancel' }), { code: 'CONFLICT' })

      const { canvasAgentRequestDigest } = await import('../../packages/database/src/repositories/canvas-agent')
      const approvalsSession = await core.createSession(actor, { clientRequestId: 'p4-approvals', agentDefinitionId: activeDefinition, definitionVersion: 1 })
      const awaiting = await core.message(actor, approvalsSession.id, { clientMessageId: randomUUID(), content: 'approval' })
      await pool.query("UPDATE agent_turns SET status='waiting_approval' WHERE id=$1", [awaiting.turn.id])
      const hash = canvasAgentRequestDigest({})
      const round = (await pool.query("INSERT INTO agent_model_rounds(session_id,turn_id,position,request_digest,input_revision,status,model_reference_id) VALUES($1,$2,1,$3,1,'recorded',$4) RETURNING id", [approvalsSession.id, awaiting.turn.id, hash, coreModelRevision])).rows[0].id
      const makeApproval = async (position: number, expired = false) => {
        const tool = (await pool.query("INSERT INTO agent_tool_calls(session_id,turn_id,round_id,position,provider_call_id,tool_name,tool_schema_version,arguments,arguments_hash,status,idempotency_key) VALUES($1,$2,$3,$4,$5,'fixture',1,'{}',$6,'waiting_approval',$5) RETURNING id", [approvalsSession.id, awaiting.turn.id, round, position, `p4-call-${position}`, hash])).rows[0].id
        const reservation = (await pool.query("INSERT INTO agent_budget_reservations(session_id,turn_id,tool_call_id,round_id,quota,reserved_amount,currency,pricing_revision,status,idempotency_key) VALUES($1,$2,$3,$4,'estimated_cost',0.1,'USD','p4-pricing','reserved',$5) RETURNING id", [approvalsSession.id, awaiting.turn.id, tool, round, `p4-budget-${position}`])).rows[0].id
        return (await pool.query("INSERT INTO agent_approvals(session_id,turn_id,tool_call_id,arguments_hash,model_revision,pricing_revision,reservation_id,status,expires_at) VALUES($1,$2,$3,$4,$5,'p4-pricing',$6,'pending',clock_timestamp()+$7*interval '1 second') RETURNING id", [approvalsSession.id, awaiting.turn.id, tool, hash, coreModelRevision, reservation, expired ? -1 : 60])).rows[0].id as string
      }
      const approval = await makeApproval(0), rejectedApproval = await makeApproval(1), expiredApproval = await makeApproval(2, true)
      await assert.rejects(core.resolveApproval(owners[1]!, approval, { decision: 'approved', expectedArgumentsHash: hash }), { code: 'NOT_FOUND' })
      await assert.rejects(core.resolveApproval(actor, approval, { decision: 'approved', expectedArgumentsHash: 'f'.repeat(64) }), { code: 'CONFLICT' })
      const decision = await core.resolveApproval(actor, approval, { decision: 'approved', expectedArgumentsHash: hash })
      await assert.rejects(pool.query('UPDATE agent_approvals SET decision_revision=decision_revision+1 WHERE id=$1', [approval]), /immutable agent approval decision/)

      assert.deepEqual(await core.resolveApproval(actor, approval, { decision: 'approved', expectedArgumentsHash: hash }), decision)
      await assert.rejects(core.resolveApproval(actor, approval, { decision: 'rejected', expectedArgumentsHash: hash }), { code: 'CONFLICT' })
      await core.resolveApproval(actor, rejectedApproval, { decision: 'rejected', expectedArgumentsHash: hash })
      await core.steer(actor, awaiting.turn.id, { clientMessageId: randomUUID(), content: 'steer after decision' })
      assert.deepEqual(await core.resolveApproval(actor, approval, { decision: 'approved', expectedArgumentsHash: hash }), decision)
      assert.equal((await core.getTurn(actor, awaiting.turn.id)).status, 'waiting_approval')
      const expiredDecision = await core.resolveApproval(actor, expiredApproval, { decision: 'approved', expectedArgumentsHash: hash })
      assert.equal(expiredDecision.expired, true)
      await core.steer(actor, awaiting.turn.id, { clientMessageId: randomUUID(), content: 'steer after expiry' })
      assert.deepEqual(await core.resolveApproval(actor, expiredApproval, { decision: 'approved', expectedArgumentsHash: hash }), expiredDecision)
      assert.equal((await pool.query('SELECT status FROM agent_approvals WHERE id=$1', [expiredApproval])).rows[0].status, 'expired')
      const snapshot = await core.snapshot(actor, approvalsSession.id, 10)
      assert.equal(snapshot.approvals.length, 3)
      assert.equal((await core.events(actor, approvalsSession.id, snapshot.eventCursor, 10)).events.length, 0)
      assert.equal((await pool.query("SELECT count(*)::int n FROM generation_jobs WHERE idempotency_key LIKE 'p4-%'")).rows[0].n, 0)
    })

    await t.test('all new schema changes have executable reverse SQL', async () => {
      const agentMigrations = ['0041_agent_core.sql', '0042_agent_ledgers_outbox_quarantine.sql', '0043_agent_control_plane.sql']
      for (let pass = 0; pass < 2; pass++) {
        for (const filename of [...agentMigrations].reverse()) await pool.query(await readFile(new URL(`../../packages/database/rollback/${filename}`, import.meta.url), 'utf8'))
      }
      assert.equal((await pool.query("SELECT to_regclass('agent_sessions') relation")).rows[0].relation, null)
      await assert.rejects(assertWorkerSchema(pool), WorkerSchemaRequiredError)
      const migrations = ['0035_outbox_dispatch_leases.sql', '0036_assets_owner_pagination_index.sql', '0037_outbox_pending_dispatch_index.sql', '0038_remove_redundant_revision_index.sql', '0039_remove_redundant_run_index.sql']
      for (const filename of [...migrations].reverse()) await pool.query(await readFile(new URL(`../../packages/database/rollback/${filename}`, import.meta.url), 'utf8'))
      const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='outbox_events' AND column_name IN ('dispatch_token','dispatch_lease_expires_at')")
      assert.equal(columns.rows.length, 0)
      for (const filename of migrations) await pool.query(await readFile(new URL(`../../packages/database/migrations/${filename}`, import.meta.url), 'utf8'))
      assert.ok((await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid='assets_owner_active_created_idx'::regclass")).rows[0].indisvalid)
      for (const filename of agentMigrations) await pool.query(await readFile(new URL(`../../packages/database/migrations/${filename}`, import.meta.url), 'utf8'))
      assert.ok((await pool.query("SELECT to_regclass('agent_sessions') relation")).rows[0].relation)
      await assertWorkerSchema(pool)
    })
  } finally {
    try {
      await pool.end()
      // The validated generated name is the only allowed destructive target.
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
    } finally {
      await admin.end()
      if (previousDb === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDb
      if (previousRedis === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = previousRedis
    }
  }
})
