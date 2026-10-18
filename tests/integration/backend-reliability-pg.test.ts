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
  const { redis } = await import('../../apps/worker/src/shared/infra')
  const pool = new Pool({ connectionString: target.toString(), max: 6, connectionTimeoutMillis: 5000, statement_timeout: 60_000 })
  const report: Record<string, unknown> = { engine: 'PostgreSQL 17', fixture: true }
  try {
    const migration = await runMigrations({ pool })
    assert.equal(migration.latest, '0039')
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
      await pool.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) SELECT 'fixture',$1,'{}' FROM generate_series(1,200)", [job])
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
        const event = (await pool.query("INSERT INTO outbox_events(event_type,aggregate_id,payload,dispatch_token,dispatch_lease_expires_at) VALUES('fixture',$1,'{}',$2,now()+interval '1 minute') RETURNING id", [job, randomUUID()])).rows[0].id
        await dispatchOutbox(pool)
        assert.equal(sent.length, 200, 'an active claim cannot be stolen')
        await pool.query("UPDATE outbox_events SET dispatch_lease_expires_at=now()-interval '1 second' WHERE id=$1", [event])
        await dispatchOutbox(pool)
        assert.equal(sent.at(-1), event)
      } finally { send.mock.restore() }
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
      await mkdir(new URL('../../.runtime/', import.meta.url), { recursive: true })
      await writeFile(new URL('../../.runtime/backend-benchmark.json', import.meta.url), JSON.stringify(report, null, 2))
    })
    await t.test('all new schema changes have executable reverse SQL', async () => {
      const migrations = ['0035_outbox_dispatch_leases.sql', '0036_assets_owner_pagination_index.sql', '0037_outbox_pending_dispatch_index.sql', '0038_remove_redundant_revision_index.sql', '0039_remove_redundant_run_index.sql']
      for (const filename of [...migrations].reverse()) await pool.query(await readFile(new URL(`../../packages/database/rollback/${filename}`, import.meta.url), 'utf8'))
      const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='outbox_events' AND column_name IN ('dispatch_token','dispatch_lease_expires_at')")
      assert.equal(columns.rows.length, 0)
      for (const filename of migrations) await pool.query(await readFile(new URL(`../../packages/database/migrations/${filename}`, import.meta.url), 'utf8'))
      assert.ok((await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid='assets_owner_active_created_idx'::regclass")).rows[0].indisvalid)
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
