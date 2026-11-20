import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import type pg from 'pg'
import { loadMigrations } from '../../packages/database/src/migrations/loader'
import { runMigrations } from '../../packages/database/src/migrations/runner'
import { db } from '../../packages/database/src/index'
import { getLatestModelConfigRevision } from '../../packages/database/src/repositories/model-config-revisions'
import {
  acquireModelCapacity,
  createProviderRun,
  getLatestProviderRunForJob,
} from '../../packages/database/src/repositories/provider-runs'
import { upsertModel } from '../../apps/api/src/modules/models/handlers'
import type { Actor } from '../../apps/api/src/auth/security'

const url = process.env.MUSECANVAS_MODEL_RETRY_PG_URL
const require = createRequire(new URL('../../packages/database/package.json', import.meta.url))

// Real PostgreSQL regression for the three audited P1 fixes, one subtest each:
// BIZ-002 — swapping a model's credential must append a new revision and never
//           rewind latest_revision_id to an older matching digest
//           (apps/api/src/modules/models/handlers.ts snapshotRevisionForRow:
//           only the newest revision may be reused, older states append).
// BIZ-003 — the model row, its audit entry and its revision snapshot are one
//           save transaction; a failing snapshot rolls everything back and the
//           handler answers MODEL_REVISION_UNAVAILABLE (savePresetModel catch).
// DAT-001 — a manual retry resets generation_jobs.attempt to 0, so the new
//           cycle's first submission must number above every historical
//           provider_runs row (UNIQUE(job_id, attempt), migrations/0017) and
//           re-delivery of one client_token stays a single submit row.
// The fixture owns a fresh database; no inherited DATABASE_URL, env files,
// workers or network providers. Everything it creates is dropped on exit.
test('isolated PostgreSQL: model revision credential swaps, snapshot rollback and retry run numbering', { timeout: 180_000 }, async t => {
  assert.ok(url, 'set MUSECANVAS_MODEL_RETRY_PG_URL=postgresql://fixture:fixture-only@127.0.0.1:5432/postgres')
  const target = new URL(url)
  assert.ok(target.protocol === 'postgres:' || target.protocol === 'postgresql:', 'fixture URL must use postgres or postgresql')
  assert.equal(target.hostname, '127.0.0.1', 'fixtures are loopback-only')
  assert.equal(target.username, 'fixture', 'fixtures use the dedicated fixture role')
  assert.equal(target.password, 'fixture-only', 'fixtures use the fixture-only password')
  assert.equal(target.pathname, '/postgres', 'admin connection must target the fixture postgres database')
  assert.equal(target.search, '', 'fixture URL must not carry a query string')
  assert.equal(target.hash, '', 'fixture URL must not carry a fragment')
  const { Pool } = require('pg') as typeof import('pg')
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const name = `model_retry_${randomUUID().replaceAll('-', '')}`
  assert.match(name, /^model_retry_[a-f0-9]{32}$/)
  const previousDb = process.env.DATABASE_URL
  let pool: pg.Pool | undefined
  let created = false
  let appPoolSeeded = false
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    created = true
    target.pathname = `/${name}`
    // The API save path owns its pool (db() reads DATABASE_URL lazily), so point
    // the singleton at this run's database before any handler call.
    process.env.DATABASE_URL = target.toString()
    db()
    appPoolSeeded = true
    pool = new Pool({ connectionString: target.toString(), max: 6, connectionTimeoutMillis: 5000 })
    const fixturePool = pool
    const migration = await runMigrations({ pool: fixturePool })
    assert.ok(migration.latest, 'the fixture database must be fully migrated')
    const expected = loadMigrations().map(entry => entry.version)
    const recorded = (await fixturePool.query('SELECT version FROM schema_migrations ORDER BY version')).rows
      .map(row => String(row.version))
    assert.deepEqual(recorded, expected, 'a freshly migrated fixture database must match the bundled migrations exactly')

    const tx = async <T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
      const client = await fixturePool.connect()
      try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result }
      catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    const one = async (sql: string, args: unknown[] = []): Promise<Record<string, unknown>> => {
      const row = (await fixturePool.query(sql, args)).rows[0]
      assert.ok(row, `expected one row from: ${sql.slice(0, 72)}`)
      return row
    }
    let actorSeq = 0
    const makeAdmin = async (): Promise<Actor> => {
      const id = randomUUID()
      const email = `model-retry-${++actorSeq}-${id}@example.invalid`
      await fixturePool.query("INSERT INTO users(id,email,role) VALUES($1,$2,'admin')", [id, email])
      return { id, email, role: 'admin', status: 'active', createdAt: new Date().toISOString() }
    }
    // provider_id/schema_id match the openai-image@1.1.0 manifest contract
    // (packages/providers/src/plugins/openai-image): provider 'openai',
    // schema 'legacy-api-key-v1', NULL base_url resolves to the fixed default.
    // A real persisted row is required: snapshotRevisionForRow reads the
    // credential's stored schema_version for the snapshot identity.
    const makeCredential = async (ownerId: string, schemaVersion: number): Promise<string> => {
      const id = randomUUID()
      await fixturePool.query(
        "INSERT INTO provider_credentials(id,display_name,adapter,provider_id,schema_id,schema_version,base_url,api_key_encrypted,enabled,created_by) VALUES($1,$2,'openai','openai','legacy-api-key-v1',$3,NULL,'synthetic-only-not-a-secret',true,$4)",
        [id, `Fixture credential schema v${schemaVersion}`, schemaVersion, ownerId],
      )
      return id
    }
    type ResponsePayload = { status: number; body: { success: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } } }
    const payloadOf = async (response: Response): Promise<ResponsePayload> =>
      ({ status: response.status, body: await response.json() as ResponsePayload['body'] })
    const revisionsOf = async (modelId: string) =>
      (await fixturePool.query('SELECT id,revision,credential_id,credential_schema_version,snapshot_digest FROM model_config_revisions WHERE model_id=$1 ORDER BY revision', [modelId]))
        .rows.map(row => ({
          id: String(row.id),
          revision: Number(row.revision),
          credentialId: row.credential_id === null ? null : String(row.credential_id),
          credentialSchemaVersion: row.credential_schema_version === null ? null : Number(row.credential_schema_version),
          digest: String(row.snapshot_digest),
        }))

    await t.test('BIZ-002: credential swaps append revisions; re-saving an older state never rewinds latest', async () => {
      const actor = await makeAdmin()
      const credentialA = await makeCredential(actor.id, 1)
      const credentialB = await makeCredential(actor.id, 2)

      const first = await payloadOf(await upsertModel(actor, { presetId: 'openai-gpt-image-2', providerCredentialId: credentialA }))
      assert.equal(first.status, 200, JSON.stringify(first.body))
      const modelId = String(first.body.data!.id)
      assert.equal(first.body.data!.revision, 1, JSON.stringify(first.body))
      const r1 = (await revisionsOf(modelId))[0]!
      assert.equal(r1.revision, 1)
      assert.equal(r1.credentialId, credentialA)
      assert.equal(r1.credentialSchemaVersion, 1, 'the revision pins the stored credential schema version')

      // Rebinding to credential B is a different execution identity: the digest
      // includes credentialId and credentialSchemaVersion, so this save must
      // append instead of reusing revision 1.
      const second = await payloadOf(await upsertModel(actor, { providerCredentialId: credentialB }, modelId))
      assert.equal(second.status, 200, JSON.stringify(second.body))
      assert.equal(second.body.data!.revision, 2, JSON.stringify(second.body))
      const afterB = await revisionsOf(modelId)
      assert.equal(afterB.length, 2)
      const r2 = afterB[1]!
      assert.equal(r2.credentialId, credentialB, 'latest revision identity carries the new credential')
      assert.equal(r2.credentialSchemaVersion, 2)
      assert.notEqual(r2.digest, r1.digest, 'credentialId and credentialSchemaVersion belong to the snapshot digest')
      assert.equal(String((await one('SELECT latest_revision_id FROM model_configs WHERE id=$1', [modelId])).latest_revision_id), r2.id)

      // Switching back to A recomputes revision 1's digest. Reusing it would
      // move latest_revision_id backwards while the Worker fallback
      // (getLatestModelConfigRevision = MAX revision) still returns revision 2,
      // so the save must append revision 3.
      const third = await payloadOf(await upsertModel(actor, { providerCredentialId: credentialA }, modelId))
      assert.equal(third.status, 200, JSON.stringify(third.body))
      assert.equal(third.body.data!.revision, 3, 'an older matching state appends a new revision')
      const afterA = await revisionsOf(modelId)
      assert.equal(afterA.length, 3)
      const r3 = afterA[2]!
      assert.equal(r3.digest, r1.digest, 'state A re-pins revision 1\'s identity digest')
      assert.notEqual(r3.id, r1.id, 'the append is a new immutable row, not a rewrite of revision 1')
      assert.equal(r3.credentialId, credentialA)
      const workerFallback = await getLatestModelConfigRevision(fixturePool, modelId)
      assert.equal(workerFallback!.revision, 3)
      assert.equal(workerFallback!.id, r3.id)
      const modelRow = await one('SELECT latest_revision_id,provider_credential_id FROM model_configs WHERE id=$1', [modelId])
      assert.equal(String(modelRow.latest_revision_id), r3.id, 'latest_revision_id must not rewind to revision 1')
      assert.equal(String(modelRow.provider_credential_id), credentialA)
    })

    await t.test('BIZ-003: a failing revision snapshot rolls the model row and its audit back', async sub => {
      const actor = await makeAdmin()
      const credentialA = await makeCredential(actor.id, 1)
      const credentialB = await makeCredential(actor.id, 2)
      const seeded = await payloadOf(await upsertModel(actor, { presetId: 'openai-gpt-image-2', providerCredentialId: credentialA }))
      assert.equal(seeded.status, 200, JSON.stringify(seeded.body))
      const modelId = String(seeded.body.data!.id)
      const stateOf = () => one(
        `SELECT md5(to_jsonb(t)::text) AS fingerprint,
          (SELECT count(*) FROM audit_logs WHERE target_id=t.id::text) AS audits,
          (SELECT count(*) FROM model_config_revisions WHERE model_id=t.id) AS revisions,
          t.latest_revision_id
         FROM model_configs t WHERE t.id=$1`,
        [modelId],
      )
      const before = await stateOf()

      // Deterministic in-transaction revision failure. A single-threaded test
      // cannot violate UNIQUE(model_id, revision) by pre-seeding a row:
      // createModelConfigRevision derives the next number as MAX(revision)+1
      // under the model-row FOR UPDATE lock, so a pre-seeded row only raises
      // the computed maximum. A BEFORE INSERT trigger that raises reproduces
      // the observable failure the fix guards: the revision write failing
      // inside the save transaction after the model row and audit row were
      // staged.
      sub.mock.method(console, 'error', () => {})
      try {
        await fixturePool.query(`CREATE OR REPLACE FUNCTION model_retry_fixture_revision_guard() RETURNS trigger AS $fn$
          BEGIN RAISE EXCEPTION 'model_retry_fixture: revision insert forbidden'; END
        $fn$ LANGUAGE plpgsql`)
        await fixturePool.query('CREATE TRIGGER model_retry_fixture_block_revision BEFORE INSERT ON model_config_revisions FOR EACH ROW EXECUTE FUNCTION model_retry_fixture_revision_guard()')
        const rejected = await payloadOf(await upsertModel(actor, { providerCredentialId: credentialB }, modelId))
        assert.equal(rejected.status, 500)
        assert.equal(rejected.body.success, false)
        assert.equal(rejected.body.error?.code, 'MODEL_REVISION_UNAVAILABLE')
        assert.equal(rejected.body.error?.message, '模型版本快照创建失败，请重试')

        const after = await stateOf()
        assert.equal(after.fingerprint, before.fingerprint, 'the staged model row write must roll back with the snapshot')
        assert.equal(String(after.audits), String(before.audits), 'no audit row may survive a failed save')
        assert.equal(String(after.revisions), String(before.revisions), 'no partial revision may commit')
        assert.equal(String(after.latest_revision_id), String(before.latest_revision_id))
        assert.equal(
          (await fixturePool.query('SELECT count(*) AS count FROM model_config_revisions WHERE model_id=$1 AND credential_id=$2', [modelId, credentialB])).rows[0].count,
          '0',
          'the rejected credential binding must leave no revision',
        )
      } finally {
        await fixturePool.query('DROP TRIGGER IF EXISTS model_retry_fixture_block_revision ON model_config_revisions')
        await fixturePool.query('DROP FUNCTION IF EXISTS model_retry_fixture_revision_guard()')
      }

      // The rollback left the model exactly as committed, so the same save
      // succeeds once the transient snapshot failure is gone.
      const retried = await payloadOf(await upsertModel(actor, { providerCredentialId: credentialB }, modelId))
      assert.equal(retried.status, 200, JSON.stringify(retried.body))
      assert.equal(retried.body.data!.revision, 2)
    })

    await t.test('DAT-001: retry numbering clears the historical run key and re-delivery dedupes on client_token', async () => {
      const actor = await makeAdmin()
      const modelId = String((await one(
        "INSERT INTO model_configs(display_name,adapter,vendor_model_id,model_kind,sizes,max_count,concurrency_limit,enabled,created_by) VALUES('Fixture retry model','openai','gpt-image-2','image','[]',1,1,true,$1) RETURNING id",
        [actor.id],
      )).id)
      const jobId = String((await one(
        "INSERT INTO generation_jobs(created_by,model_id,model_name,adapter,vendor_model_id,size,count,idempotency_key,status,attempt) VALUES($1,$2,'Fixture retry model','openai','gpt-image-2','1024x1024',1,$3,'failed',2) RETURNING id",
        [actor.id, modelId, `retry:${randomUUID()}`],
      )).id)
      const historical = await createProviderRun(fixturePool, {
        jobId, attempt: 1, providerId: 'openai', pluginId: 'openai-image',
        clientToken: `fixture-history:${randomUUID()}`, operationState: 'failed',
      })
      assert.equal(historical.attempt, 1)

      // The manual-retry write (apps/api/src/modules/jobs/handlers.ts
      // retryJob): the cycle budget restarts at 0 while provider_runs keeps
      // every historical row.
      await fixturePool.query(
        "UPDATE generation_jobs SET status='queued',phase=$3,attempt=0,progress=0,cancel_requested_at=NULL,error_code=NULL,provider_error=NULL,provider_reference_id=NULL,started_at=NULL,completed_at=NULL,updated_at=now() WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL",
        [jobId, actor.id, 'image_generating'],
      )
      const queued = await one('SELECT status,attempt FROM generation_jobs WHERE id=$1', [jobId])
      assert.equal(queued.status, 'queued')
      assert.equal(Number(queued.attempt), 0)

      // Worker numbering (apps/worker/src/jobs/index.ts): the budget counts
      // from the cycle's own attempt; the submission sequence continues above
      // every run the job already owns.
      const cycleAttempt = Number(queued.attempt) || 1
      assert.equal(cycleAttempt, 1)
      const existingRun = await getLatestProviderRunForJob(fixturePool, jobId)
      assert.equal(existingRun!.attempt, 1)

      // The pre-fix bug: numbering the first retry submission from the reset
      // budget reuses the previous cycle's attempt 1 and collides with
      // UNIQUE(job_id, attempt) from migrations/0017. ON CONFLICT (client_token)
      // does not cover that key, so the violation surfaces as 23505.
      let collided: { code?: string; constraint?: string } | undefined
      try {
        await tx(client => acquireModelCapacity(client, {
          modelId, jobId, providerId: 'openai', pluginId: 'openai-image',
          attempt: cycleAttempt, clientToken: `fixture-cycle-one:${randomUUID()}`,
        }))
      } catch (error) {
        collided = error as { code?: string; constraint?: string }
      }
      assert.ok(collided, 'the pre-fix numbering must collide with the historical run')
      assert.equal(collided.code, '23505')
      assert.equal(collided.constraint, 'provider_runs_job_id_attempt_key')

      // The fixed sequence numbers above the historical run, so capacity
      // acquisition and the provider run insert succeed.
      const runAttempt = Math.max(cycleAttempt, existingRun!.attempt + 1)
      assert.equal(runAttempt, 2)
      const submitToken = `fixture-cycle-two:${randomUUID()}`
      const acquired = await tx(client => acquireModelCapacity(client, {
        modelId, jobId, providerId: 'openai', pluginId: 'openai-image',
        attempt: runAttempt, clientToken: submitToken,
      }))
      assert.equal(acquired.acquired, true)
      assert.equal(acquired.run!.attempt, 2)
      const stored = await one(
        'SELECT operation_state,capacity_state,capacity_reservation_id,capacity_reserved_at FROM provider_runs WHERE job_id=$1 AND attempt=2',
        [jobId],
      )
      assert.equal(stored.operation_state, 'submitting')
      assert.equal(stored.capacity_state, 'reserved')
      assert.equal(String(stored.capacity_reservation_id), `cap-${submitToken}`)
      assert.ok(stored.capacity_reserved_at, 'capacity reservation is stamped at acquisition')

      // Re-delivering the same client_token must not produce a duplicate submit
      // row: ON CONFLICT (client_token) DO UPDATE keeps exactly one row no
      // matter which number the re-delivery computed.
      const latest = await getLatestProviderRunForJob(fixturePool, jobId)
      const reDeliveryAttempt = Math.max(cycleAttempt, latest!.attempt + 1)
      assert.equal(reDeliveryAttempt, 3)
      const reDelivered = await createProviderRun(fixturePool, {
        jobId, attempt: reDeliveryAttempt, providerId: 'openai', pluginId: 'openai-image', clientToken: submitToken,
      })
      assert.equal(reDelivered.id, acquired.run!.id, 'the client token owns one run row')
      assert.equal(reDelivered.attempt, 2)
      const attempts = (await fixturePool.query('SELECT attempt FROM provider_runs WHERE job_id=$1 ORDER BY attempt', [jobId]))
        .rows.map(row => Number(row.attempt))
      assert.deepEqual(attempts, [1, 2], 'exactly the historical run and one new submission exist')
      // Submission numbering never spends the cycle budget column.
      assert.equal(Number((await one('SELECT attempt FROM generation_jobs WHERE id=$1', [jobId])).attempt), 0)
    })
  } finally {
    await pool?.end()
    if (appPoolSeeded) await db().end().catch(() => { /* cleanup must not mask the original failure */ })
    try {
      if (created) {
        // Same pg-pool race as the other fixtures: end() resolves before the
        // client sockets close, so wait for the server to see the disconnects
        // and drop without FORCE instead of injecting a FATAL into a closing
        // socket (Node 22 reports that as late asynchronous activity).
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const active = (await admin.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [name])).rows[0]
          if (active?.count === '0') break
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        // The validated generated name is the only allowed destructive target.
        await admin.query(`DROP DATABASE "${name}"`)
      }
    } finally {
      await admin.end()
      if (previousDb === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDb
    }
  }
})
