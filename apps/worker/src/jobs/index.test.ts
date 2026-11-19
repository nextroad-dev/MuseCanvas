import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { inspectInputImage, validateInputImages } from '@musecanvas/providers/core/image-input'
import { encryptApiKey, NormalizedProviderError, type OperationResult } from '@musecanvas/providers'
import { resolveMediaPlugin } from '../plugins/availability'
import { classifySubmitError, isSynchronousPlugin, readInputBody, validateStoredInputImage } from './index'
import { decideCapacityDenial, decideClaimedJob, decideJobClaim, decideSubmitResult } from './process-job-decisions'
import { isNonTerminalRunState, shouldCreateNewRun } from '../provider-state'
import { db, transaction } from '@musecanvas/database'
import type pg from 'pg'
import { persistJobSuccess, persistJobFailure, persistPreRunFailure, pollProviderRun, processJob, requeueCapacityWait } from './index'
import { LifecyclePersistenceError, MAX_PRE_RUN_ATTEMPTS, reconcileCancellation, reconcileUnknownSubmission, unknownSubmissionExpired } from './lifecycle'
import { ProviderLeaseLostError } from './lease'
import { scheduleMaintenance } from '../maintenance'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

/** Exercises real processJob/poll/lease code without provider HTTP or live SQL. */
function workerFixture(t: TestContext) {
  process.env.APP_MASTER_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY ||= 'test-worker-encryption-key'
  const credential = encryptApiKey('worker-lifecycle-test-placeholder')
  const cycle = '2026-10-25 00:00:00.123456+00'
  const job: Record<string, unknown> = { id: 'job', status: 'queued', attempt: 0, prompt: 'draw', count: 1,
    optimization_mode: 'disabled', model_id: 'model', model_revision_id: 'revision', retry_cycle: cycle, created_by: 'actor' }
  let run: Record<string, unknown> | undefined
  const controls = {
    failWaitingWrite: false,
    capacityFull: false,
    preprocess: async (): Promise<void> => { /* Most tests use disabled preprocessing. */ },
    submit: async (): Promise<OperationResult> => ({ status: 'waiting', remoteId: 'remote' }),
    poll: async (): Promise<OperationResult> => ({ status: 'waiting', remoteId: 'remote' }),
    cancel: async (): Promise<OperationResult> => ({ status: 'waiting', remoteId: 'remote' }),
  }
  const statements: string[] = []
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push(sql)
    const rows = (result: Record<string, unknown>[] = []) => ({ rows: structuredClone(result), rowCount: result.length })
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return rows()
    if (sql.startsWith('SELECT *') && sql.includes('FROM generation_jobs')) return rows([job])
    if (sql.startsWith('SELECT prompt FROM generation_jobs')) return rows([job])
    if (sql.startsWith('SELECT status,deleted_at,cancel_requested_at')) return rows([job])
    if (sql.startsWith('SELECT id FROM generation_jobs')) return rows(job.status === 'running' && values[1] === job.attempt && values[2] === cycle ? [{ id: 'job' }] : [])
    if (sql.startsWith('SELECT po.*')) { await controls.preprocess(); throw new Error('PROMPT_OPTIMIZATION_TEMPORARY_ERROR') }
    if (sql.includes('FROM model_config_revisions')) return rows([{ id: 'revision', model_id: 'model', provider_id: 'provider', plugin_id: 'seedance-video', plugin_version: '1.0.0', credential_id: 'credential', normalized_config: { timeoutMs: 300_000, maxBytes: 100_000 }, created_at: new Date() }])
    if (sql.includes('FROM provider_credentials')) return rows([{ id: 'credential', enabled: true, api_key_encrypted: credential }])
    if (sql.startsWith('SELECT id, concurrency_limit')) return rows([{ id: 'model', concurrency_limit: 1 }])
    if (sql.includes('SELECT count(*)::int AS count')) return rows([{ count: controls.capacityFull ? 1 : 0 }])
    if (sql.startsWith('SELECT * FROM provider_runs')) return rows(run ? [run] : [])
    if (sql.includes('INSERT INTO provider_runs')) {
      assert.equal(run, undefined, 'a claim must create at most one provider run')
      run = { id: 'run', job_id: job.id, attempt: values[1], provider_id: values[2], plugin_id: values[3], plugin_version: values[4],
        client_token: values[5], remote_id: null, operation_state: 'submitting', state_revision: 1, capacity_state: 'reserved',
        submitted_at: new Date(), created_at: new Date(), updated_at: new Date() }
      return rows([run])
    }
    if (sql.includes('SET worker_lease_token = $2')) {
      if (!run || run.worker_lease_token) return rows()
      run.worker_lease_token = values[1]; run.worker_lease_expires_at = new Date(Date.now() + 60_000)
      return rows([run])
    }
    if (sql.includes('SET worker_lease_token = NULL')) {
      if (run && run.worker_lease_token === values[1]) { run.worker_lease_token = null; run.worker_lease_expires_at = null }
      return rows([{ id: 'run' }])
    }
    if (sql.includes('state_revision = state_revision + 1')) {
      assert.ok(run)
      assert.equal(values[1], run.state_revision, 'every write must use the current revision')
      assert.equal(values.at(-1), run.worker_lease_token, 'every write must retain lease fencing')
      const assignments = sql.split('WHERE')[0]
      if (controls.failWaitingWrite && /operation_state = \$(\d+)/.test(assignments) && values[Number(/operation_state = \$(\d+)/.exec(assignments)![1]) - 1] === 'waiting') throw new Error('WAITING_DB_WRITE_FAILED')
      for (const match of assignments.matchAll(/(\w+) = \$(\d+)/g)) run[match[1]] = values[Number(match[2]) - 1]
      run.state_revision = Number(run.state_revision) + 1
      if (assignments.includes("capacity_state = 'released'")) run.capacity_state = 'released'
      if (assignments.includes('completed_at = now()')) run.completed_at = new Date()
      return rows([run])
    }
    if (sql.startsWith('UPDATE generation_jobs')) {
      if (sql.includes('attempt=GREATEST')) {
        job.status = 'queued'
        job.attempt = Math.max(Number(job.attempt) - 1, 0)
        return rows([{ id: 'job', requeue_cycle: '2026-10-25 00:00:01.000000+00' }])
      }
      if (sql.includes('attempt=attempt+1')) { job.status = 'running'; job.attempt = Number(job.attempt) + 1 }
      else if (sql.includes("status='canceled'")) job.status = 'canceled'
      else if (sql.includes('status=$2')) job.status = values[1]
      else if (sql.includes("status='succeeded'")) job.status = 'succeeded'
      return rows([{ id: 'job' }])
    }
    if (sql.startsWith('UPDATE prompt_optimizations') || sql.startsWith('INSERT INTO outbox_events')) return rows()
    if (sql.includes('FROM generation_job_inputs') || sql.includes('FROM (')) return rows()
    assert.fail(`Unexpected lifecycle SQL: ${sql}`)
  }
  t.mock.method(db(), 'query', query)
  t.mock.method(db(), 'connect', async () => ({ query, release() { /* Mock connection owns no external resources. */ } }))
  const plugin = resolveMediaPlugin('seedance-video', '1.0.0')
  const submit = t.mock.method(plugin, 'submit', () => controls.submit())
  assert.ok(plugin.poll, 'the fixture requires an asynchronous plugin')
  const poll = t.mock.method(plugin as typeof plugin & { poll: NonNullable<typeof plugin.poll> }, 'poll', () => controls.poll())
  const cancel = plugin.cancel
    ? t.mock.method(plugin as typeof plugin & { cancel: NonNullable<typeof plugin.cancel> }, 'cancel', () => controls.cancel())
    : null
  t.mock.method(plugin, 'validateRequest', async () => { /* Request validity is unrelated to lifecycle races. */ })
  return { job, controls, statements, submit, poll, cancel, run: () => run }
}

test('a duplicate delivery cannot preprocess an actively owned running job without a provider run', async t => {
  const fixture = workerFixture(t)
  fixture.job.optimization_mode = 'enabled'
  const entered = deferred<void>()
  const release = deferred<void>()
  let preprocessCalls = 0
  fixture.controls.preprocess = async () => {
    preprocessCalls++
    if (preprocessCalls === 1) { entered.resolve(); await release.promise }
  }
  const first = processJob('job')
  await entered.promise
  try {
    await assert.rejects(processJob('job'), LifecyclePersistenceError)
    assert.equal(preprocessCalls, 1)
    assert.equal(fixture.job.attempt, 1)
    assert.equal(fixture.submit.mock.callCount(), 0)
  } finally {
    release.resolve()
    await first
  }
})

test('accepted async submit followed by persistence failure keeps capacity and never resubmits on redelivery', async t => {
  const fixture = workerFixture(t)
  const entered = deferred<void>()
  const complete = deferred<OperationResult>()
  fixture.controls.submit = async () => { entered.resolve(); return complete.promise }
  fixture.controls.failWaitingWrite = true
  const delivery = processJob('job')
  await entered.promise
  await assert.rejects(processJob('job'), ProviderLeaseLostError, 'contending delivery must remain unacknowledged')
  assert.equal(fixture.submit.mock.callCount(), 1)
  complete.resolve({ status: 'waiting', remoteId: 'billable-remote' })
  await assert.rejects(delivery, LifecyclePersistenceError)
  assert.equal(fixture.run()?.capacity_state, 'reserved')
  assert.equal(fixture.run()?.operation_state, 'submitting')
  assert.equal(fixture.job.status, 'running')
  fixture.controls.failWaitingWrite = false
  assert.equal(await processJob('job'), true)
  assert.equal(fixture.submit.mock.callCount(), 1)
  assert.equal(fixture.run()?.operation_state, 'submission_unknown')
  assert.equal(fixture.run()?.capacity_state, 'reserved')
})

for (const path of ['submit', 'poll'] as const) {
  test(`cancellation arriving during ${path} success discards outputs before ingestion`, async t => {
    const fixture = workerFixture(t)
    if (path === 'poll') {
      assert.equal(await processJob('job'), true)
      assert.equal(fixture.run()?.operation_state, 'waiting')
    }
    const entered = deferred<void>()
    const complete = deferred<OperationResult>()
    fixture.controls[path] = async () => { entered.resolve(); return complete.promise }
    const delivery = path === 'submit' ? processJob('job') : pollProviderRun('run')
    await entered.promise
    fixture.job.cancel_requested_at = new Date()
    complete.resolve({ status: 'succeeded', outputs: [{ index: 0, mimeType: 'image/png', url: 'https://example.invalid/output' }] })
    assert.equal(await delivery, true)
    assert.equal(fixture.job.status, 'canceled')
    assert.equal(fixture.run()?.operation_state, 'succeeded')
    assert.equal(fixture.run()?.capacity_state, 'released')
    assert.equal(fixture.statements.some(sql => sql.includes('INSERT INTO output_ingestions') || sql.includes('INSERT INTO assets')), false)
    await processJob('job')
    assert.equal(fixture.submit.mock.callCount(), 1, 'terminal cancellation must not resubmit')
  })
}

test('success transaction sees cancellation committed after ingestion started and inserts no assets', async () => {
  const locked = deferred<void>()
  const cancellationCommitted = deferred<void>()
  const statements: string[] = []
  const client = {
    async query(sql: string) {
      statements.push(sql)
      assert.match(sql, /SELECT status,deleted_at,cancel_requested_at.*FOR UPDATE/)
      locked.resolve()
      await cancellationCommitted.promise
      return { rows: [{ status: 'running', deleted_at: null, cancel_requested_at: new Date() }] }
    },
  } as unknown as pg.PoolClient
  const persistence = persistJobSuccess(client, { jobId: 'job', createdBy: 'actor', prompt: 'draw', uploaded: [{ key: 'output', checksum: 'digest', image: { mimeType: 'image/png' } }] })
  await locked.promise
  cancellationCommitted.resolve()
  assert.equal(await persistence, false)
  assert.equal(statements.length, 1, 'the locked cancellation guard must precede any asset write')
})

test('pre-run retry atomically commits failure and deduplicated delivery, rolls back outbox failure, and exhausts', async t => {
  let committed = { status: 'running', outbox: [] as string[], optimization: 'running' }
  let staged = structuredClone(committed)
  let failOutbox = false
  let cycle = '2026-10-25 00:00:00.123456+00'
  const statements: string[] = []
  const client = {
    release() {},
    async query(sql: string, values: unknown[] = []) {
      statements.push(sql)
      if (sql === 'BEGIN') staged = structuredClone(committed)
      else if (sql === 'COMMIT') committed = structuredClone(staged)
      else if (sql.startsWith('SELECT id FROM generation_jobs')) return { rows: staged.status === 'running' && values[2] === cycle ? [{ id: 'job' }] : [] }
      else if (sql.startsWith('UPDATE prompt_optimizations')) staged.optimization = 'failed'
      else if (sql.startsWith('UPDATE generation_jobs')) {
        assert.match(sql, /status='running' RETURNING id/)
        staged.status = String(values[1])
        return { rows: [{ id: 'job' }], rowCount: 1 }
      } else if (sql.startsWith('INSERT INTO outbox_events')) {
        if (sql.includes("SELECT 'media.job.completed'")) {
          assert.equal(staged.status, 'failed')
          return { rows: [], rowCount: 1 }
        }
        assert.match(sql, /dedupe_key.*ON CONFLICT DO NOTHING/)
        if (failOutbox) throw new Error('OUTBOX_UNAVAILABLE')
        if (!staged.outbox.includes(String(values[3]))) staged.outbox.push(String(values[3]))
      }
      return { rows: [], rowCount: 0 }
    },
  }
  t.mock.method(db(), 'connect', async () => client)
  const failure = { jobId: 'job', promptOptimizationId: 'optimization', phase: 'optimization_failed', code: 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR', retryable: true }
  failOutbox = true
  await assert.rejects(persistPreRunFailure(failure, 1, cycle), /OUTBOX_UNAVAILABLE/)
  assert.deepEqual(committed, { status: 'running', outbox: [], optimization: 'running' })
  assert.equal(statements.at(-1), 'ROLLBACK')
  failOutbox = false
  await persistPreRunFailure(failure, 1, cycle)
  assert.equal(committed.status, 'retry_wait')
  assert.deepEqual(committed.outbox, [`generation.retry:job:${cycle}:1`])
  await assert.rejects(persistPreRunFailure(failure, 1, cycle), /JOB_STATE_CONFLICT/)
  assert.equal(committed.outbox.length, 1)
  committed.status = 'running'
  await persistPreRunFailure(failure, MAX_PRE_RUN_ATTEMPTS, cycle)
  assert.equal(committed.status, 'failed')
  assert.equal(committed.outbox.length, 1, 'exhaustion must not enqueue another submission')
  assert.match(statements.findLast(sql => sql.startsWith('UPDATE generation_jobs'))!, /completed_at=now\(\)/)
  // Manual retry resets attempt but starts a new persisted cycle. Retain the
  // already-dispatched old outbox row to reproduce the unique-key collision.
  cycle = '2026-10-25 00:01:00.654321+00'
  committed.status = 'running'
  await persistPreRunFailure(failure, 1, cycle)
  assert.equal(committed.status, 'retry_wait')
  assert.equal(committed.outbox.length, 2)
  assert.equal(committed.outbox.at(-1), `generation.retry:job:${cycle}:1`)
})

test('processJob preprocessing recovery retries even after a previous terminal run; outbox failure rejects queue delivery', async t => {
  let attempt = 0
  let status = 'queued'
  let outbox = 0
  let failOutbox = false
  let snapshot = { attempt, status, outbox }
  const cycle = '2026-10-25 00:00:00.123456+00'
  let activeCycle = cycle
  let supersedeAfterRollback = false
  let historicalRun = false
  const keys = new Set<string>()
  const job = () => ({ id: 'job', status, attempt, retry_cycle: activeCycle, prompt: 'draw', optimization_mode: 'enabled', prompt_optimization_id: 'optimization' })
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql === 'BEGIN') snapshot = { attempt, status, outbox }
    else if (sql === 'ROLLBACK') {
      ({ attempt, status, outbox } = snapshot)
      if (supersedeAfterRollback) { activeCycle = '2026-10-25 01:00:00.999999+00'; attempt = 1; status = 'running' }
    }
    else if (sql === 'COMMIT') { /* Mock mutations are already applied; only rollback restores the snapshot. */ }
    else if (sql.startsWith('SELECT * FROM provider_runs')) return { rows: historicalRun || attempt > 1 ? [{ id: 'old-run', job_id: 'job', attempt: 3, operation_state: 'failed', state_revision: 1, created_at: new Date(), updated_at: new Date() }] : [] }
    else if (sql.startsWith('SELECT *')) return { rows: [job()] }
    else if (sql.startsWith('SELECT id FROM generation_jobs')) return { rows: [{ id: 'job' }] }
    else if (sql.includes('attempt=attempt+1')) { attempt++; status = 'running' }
    else if (sql.startsWith('SELECT po.*')) throw new Error('PROMPT_OPTIMIZATION_TEMPORARY_ERROR')
    else if (sql.startsWith('UPDATE prompt_optimizations')) { /* This mock tracks job and outbox recovery, not optimization metadata. */ }
    else if (sql.startsWith('UPDATE generation_jobs SET status=$2')) { status = String(values[1]); return { rows: [{ id: 'job' }], rowCount: 1 } }
    else if (sql.startsWith("UPDATE generation_jobs SET status='queued',attempt=attempt-1")) {
      assert.match(sql, /status='running' AND attempt=\$2 AND started_at=\$3::timestamptz/)
      assert.match(sql, /NOT EXISTS.*SELECT 1 FROM provider_runs/s)
      assert.match(sql, /submitted_at >= \$3::timestamptz OR operation_state IN/)
      if (values[1] === attempt && values[2] === activeCycle) { status = 'queued'; attempt-- }
    }
    else if (sql.startsWith('INSERT INTO outbox_events')) {
      if (sql.includes("SELECT 'media.job.completed'")) {
        assert.equal(status, 'failed')
        return { rows: [], rowCount: 1 }
      }
      if (failOutbox) throw new Error('OUTBOX_FAILED')
      const key = String(values[3])
      if (!keys.has(key)) { keys.add(key); outbox++ }
    }
    else assert.fail(`Unexpected SQL (provider submission must not run): ${sql}`)
    return { rows: [], rowCount: 0 }
  }
  t.mock.method(db(), 'query', query)
  t.mock.method(db(), 'connect', async () => ({ query, release() {} }))
  assert.equal(await processJob('job'), true)
  assert.equal(status, 'retry_wait')
  assert.equal(outbox, 1)
  failOutbox = true
  await assert.rejects(processJob('job'), LifecyclePersistenceError)
  assert.equal(status, 'queued', 'the owner restores only its pre-run claim before rejecting delivery')
  assert.equal(attempt, 1)
  assert.equal(outbox, 1)
  // Replay the restored delivery after interrupted persistence without
  // spending another attempt or creating a provider submission.
  failOutbox = false
  assert.equal(await processJob('job'), true)
  assert.equal(attempt, 2)
  assert.equal(status, 'retry_wait')
  assert.equal(outbox, 2)
  assert.equal(await processJob('job'), true)
  assert.equal(status, 'failed')
  assert.equal(outbox, 2)
  // An old terminal provider run may have a higher attempt than the reset job.
  // It must not swallow preprocessing failure in the new manual retry cycle.
  historicalRun = true
  activeCycle = '2026-10-25 00:30:00.654321+00'
  status = 'queued'; attempt = 0
  assert.equal(await processJob('job'), true)
  assert.equal(status, 'retry_wait')
  assert.equal(outbox, 3)
  // If another cycle became active after rollback, restoration must not queue
  // that new owner or decrement its attempt with the old claim's timestamp.
  failOutbox = true
  supersedeAfterRollback = true
  await assert.rejects(processJob('job'), LifecyclePersistenceError)
  assert.equal(status, 'running')
  assert.equal(attempt, 1)
  assert.equal(activeCycle, '2026-10-25 01:00:00.999999+00')
})

test('unknown reconciliation uses original timestamps, expires capacity, and never resubmits', async t => {
  let now = Date.parse('2026-10-25T00:00:00Z')
  t.mock.method(Date, 'now', () => now)
  const run = { submittedAt: new Date(now).toISOString(), createdAt: new Date(now - 1000).toISOString() }
  let capacity = 'reserved'
  let waits = 0
  const actions = { expire: async () => { capacity = 'released' }, wait: async () => { waits++ } }
  await reconcileUnknownSubmission(run, 300_000, actions)
  assert.equal(capacity, 'reserved')
  assert.equal(waits, 1)
  now += 300_000
  await reconcileUnknownSubmission(run, 300_000, actions)
  assert.equal(capacity, 'released')
  assert.equal(waits, 1)
  assert.equal(unknownSubmissionExpired({ ...run, submittedAt: null }, 300_000), true)
  assert.equal(unknownSubmissionExpired({ submittedAt: null, createdAt: 'invalid' }, 300_000), true)
  await assert.rejects(reconcileUnknownSubmission(run, 300_000, { ...actions, expire: async () => { throw new Error('DB_FAILED') } }), /DB_FAILED/)
})

test('waiting for capacity requeues without creating a run or spending the retry budget', async t => {
  const fixture = workerFixture(t)
  fixture.controls.capacityFull = true

  assert.equal(await processJob('job'), true)

  assert.equal(fixture.job.status, 'queued')
  assert.equal(fixture.job.attempt, 0, 'queueing is not a provider attempt')
  assert.equal(fixture.run(), undefined, 'capacity denial must not create a provider run')
  const delivery = fixture.statements.find(sql => sql.startsWith('INSERT INTO outbox_events'))
  assert.ok(delivery)
  assert.match(delivery, /dedupe_key/)
  assert.match(delivery, /generation\.retry/)
})

test('capacity requeue rolls back the transition when its delivery write fails', async t => {
  const committed = { status: 'running', attempt: 1, outbox: [] as string[] }
  let staged = structuredClone(committed)
  let fail = true
  const client = {
    release() { /* fake connection owns nothing */ },
    async query(sql: string, values: unknown[] = []) {
      if (sql === 'BEGIN') { staged = structuredClone(committed); return { rows: [], rowCount: 0 } }
      if (sql === 'COMMIT') { Object.assign(committed, structuredClone(staged)); return { rows: [], rowCount: 0 } }
      if (sql === 'ROLLBACK') { staged = structuredClone(committed); return { rows: [], rowCount: 0 } }
      if (sql.startsWith("UPDATE generation_jobs SET status='queued'")) {
        staged.status = 'queued'
        staged.attempt = Math.max(staged.attempt - 1, 0)
        return { rows: [{ id: 'job', requeue_cycle: 'cycle-1' }], rowCount: 1 }
      }
      if (sql.startsWith('INSERT INTO outbox_events')) {
        if (fail) throw new Error('OUTBOX_UNAVAILABLE')
        staged.outbox.push(String(values[2]))
        return { rows: [], rowCount: 1 }
      }
      assert.fail(`Unexpected requeue SQL: ${sql}`)
    },
  }
  t.mock.method(db(), 'connect', async () => client)

  await assert.rejects(transaction(c => requeueCapacityWait(c, 'job', 'cycle')), /OUTBOX_UNAVAILABLE/)
  assert.deepEqual(committed, { status: 'running', attempt: 1, outbox: [] })

  fail = false
  await transaction(c => requeueCapacityWait(c, 'job', 'cycle'))
  assert.equal(committed.status, 'queued')
  assert.equal(committed.attempt, 0)
  assert.deepEqual(committed.outbox, ['generation.retry:capacity:job:cycle-1'])
})

test('a soft-deleted job cancels its remote run instead of failing it as JOB_NOT_FOUND', async t => {
  const fixture = workerFixture(t)
  assert.equal(await processJob('job'), true)
  const submitted = fixture.run()
  assert.ok(submitted)
  assert.equal(submitted.operation_state, 'waiting')
  assert.equal(submitted.remote_id, 'remote')
  const cancel = fixture.cancel
  assert.ok(cancel, 'the fixture plugin must expose cancel')

  // Deleting the job mirrors the destructive API path: soft delete plus cancel intent.
  fixture.job.deleted_at = new Date()
  fixture.job.cancel_requested_at = new Date()

  assert.equal(await processJob('job', 'run'), true)
  assert.equal(cancel.mock.callCount(), 1, 'the remote task must be cancelled, not forgotten')
  assert.equal(fixture.run()?.operation_state, 'canceling')
  assert.equal(fixture.run()?.capacity_state, 'reserved', 'capacity stays reserved until the provider confirms')
})

test('cancellation pending/errors retain capacity; only confirmed terminal outcomes release', async () => {
  for (const outcome of ['waiting', 'submission_unknown', 'submitting', 'error', 'unsupported', 'canceled', 'succeeded', 'failed'] as const) {
    let capacity = 'reserved'
    let state = 'canceling'
    let scheduled = false
    await reconcileCancellation({
      invoke: async () => {
        if (outcome === 'error') throw new Error('PROVIDER_TIMEOUT')
        if (outcome === 'unsupported') return undefined
        return { status: outcome }
      },
      assertLease() {}, isLeaseLost: error => error instanceof ProviderLeaseLostError,
      pending: async () => { scheduled = true },
      terminal: async result => { capacity = 'released'; state = result.status },
    })
    const terminal = ['canceled', 'succeeded', 'failed'].includes(outcome)
    assert.equal(capacity, terminal ? 'released' : 'reserved', outcome)
    assert.equal(scheduled, !terminal, outcome)
    assert.equal(state, terminal ? outcome : 'canceling')
  }
})

test('cancellation fencing and persistence failures propagate, never become confirmed cancellation', async () => {
  let releases = 0
  const callbacks = {
    invoke: async () => ({ status: 'waiting' as const }),
    assertLease() {}, isLeaseLost: (error: unknown) => error instanceof ProviderLeaseLostError,
    pending: async () => { throw new Error('DB_FAILED') },
    terminal: async () => { releases++ },
  }
  await assert.rejects(reconcileCancellation(callbacks), /DB_FAILED/)
  await assert.rejects(reconcileCancellation({ ...callbacks, invoke: async () => { throw new ProviderLeaseLostError() } }), ProviderLeaseLostError)
  await assert.rejects(reconcileCancellation({ ...callbacks, assertLease() { throw new ProviderLeaseLostError() } }), ProviderLeaseLostError)
  await assert.rejects(reconcileCancellation({ ...callbacks, invoke: async () => ({ status: 'canceled' }), terminal: async () => { throw new Error('TERMINAL_DB_FAILED') } }), /TERMINAL_DB_FAILED/)
  assert.equal(releases, 0)
})

// Create helper PNG buffer with valid IHDR
function createValidPng(width = 100, height = 100): Buffer {
  const buf = Buffer.alloc(33)
  // PNG signature
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  // IHDR chunk length (13)
  buf.writeUInt32BE(13, 8)
  // IHDR type
  buf.write('IHDR', 12, 'latin1')
  // width and height
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  // bit depth, color type, compression, filter, interlace
  buf.set([8, 2, 0, 0, 0], 24)
  // CRC dummy
  buf.writeUInt32BE(0, 29)
  return buf
}

// Create helper JPEG buffer with SOF0
function createValidJpeg(width = 100, height = 100): Buffer {
  const buf = Buffer.alloc(23)
  // SOI
  buf.set([0xff, 0xd8], 0)
  // SOF0 marker
  buf.set([0xff, 0xc0], 2)
  // Length (8 + 3*channels = 11)
  buf.writeUInt16BE(11, 4)
  // Precision
  buf.writeUInt8(8, 6)
  // Height and width
  buf.writeUInt16BE(height, 7)
  buf.writeUInt16BE(width, 9)
  // Number of components
  buf.writeUInt8(3, 11)
  // Dummy component specs
  buf.set([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0], 12)
  // EOI
  buf.set([0xff, 0xd9], 21)
  return buf
}

test('inspectInputImage correctly inspects PNG and JPEG', () => {
  const png = createValidPng(200, 300)
  const inspectedPng = inspectInputImage(png)
  assert.equal(inspectedPng.mimeType, 'image/png')
  assert.equal(inspectedPng.width, 200)
  assert.equal(inspectedPng.height, 300)
  assert.equal(inspectedPng.sizeBytes, png.length)

  const jpeg = createValidJpeg(400, 500)
  const inspectedJpeg = inspectInputImage(jpeg)
  assert.equal(inspectedJpeg.mimeType, 'image/jpeg')
  assert.equal(inspectedJpeg.width, 400)
  assert.equal(inspectedJpeg.height, 500)
  assert.equal(inspectedJpeg.sizeBytes, jpeg.length)
})

test('inspectInputImage rejects invalid formats and sizes', () => {
  assert.throws(() => inspectInputImage(Buffer.from('not an image')), /INVALID_INPUT_IMAGE/)
  assert.throws(() => inspectInputImage(Buffer.alloc(0)), /INVALID_INPUT_IMAGE/)

  // Dimension too small
  const small = createValidPng(10, 10)
  assert.throws(() => inspectInputImage(small), /INVALID_INPUT_IMAGE_SIZE/)

  // Dimension too large
  const large = createValidPng(7000, 100)
  assert.throws(() => inspectInputImage(large), /INVALID_INPUT_IMAGE_SIZE/)

  // Aspect ratio > 16
  const wide = createValidPng(3200, 100) // 32:1 > 16
  assert.throws(() => inspectInputImage(wide), /INVALID_INPUT_IMAGE_SIZE/)
})

test('validateInputImages enforces caps and ordering', () => {
  const png1 = createValidPng(100, 100)
  const png2 = createValidPng(200, 200)
  const list = validateInputImages([{ data: png1 }, { data: png2 }])
  assert.equal(list.length, 2)
  assert.equal(list[0].width, 100)
  assert.equal(list[1].width, 200)

  // More than MAX_INPUT_IMAGES (32 absolute ceiling)
  assert.throws(
    () =>
      validateInputImages(Array.from({ length: 33 }, () => ({ data: png1 }))),
    /INVALID_INPUT_IMAGE/,
  )
  // Resolved runtime limits are enforced, including lowered values.
  assert.throws(() => validateInputImages([{ data: png1 }, { data: png1 }], { maxInputs: 1 }), /INVALID_INPUT_IMAGE/)
  assert.equal(validateInputImages([{ data: png1 }, { data: png1 }], { maxInputs: 32 }).length, 2)
})

test('validateStoredInputImage rejects post-completion object changes', () => {
  const data = createValidPng(256, 256)
  const checksum = createHash('sha256').update(data).digest('hex')
  const inspected = validateStoredInputImage(data, {
    mimeType: 'image/png',
    sizeBytes: data.length,
    checksum,
  })
  assert.equal(inspected.width, 256)

  assert.throws(
    () => validateStoredInputImage(data, {
      mimeType: 'image/png',
      sizeBytes: data.length + 1,
      checksum,
    }),
    /INVALID_INPUT_IMAGE_SIZE/,
  )
  assert.throws(
    () => validateStoredInputImage(data, {
      mimeType: 'image/jpeg',
      sizeBytes: data.length,
      checksum,
    }),
    /INVALID_INPUT_IMAGE/,
  )
  assert.throws(
    () => validateStoredInputImage(data, {
      mimeType: 'image/png',
      sizeBytes: data.length,
      checksum: '0'.repeat(64),
    }),
    /INVALID_INPUT_IMAGE/,
  )
  assert.throws(
    () => validateStoredInputImage(data, {
      mimeType: 'image/png',
      sizeBytes: data.length,
      checksum,
    }, { maxImageBytes: data.length - 1 }),
    /INVALID_INPUT_IMAGE_SIZE/,
  )
})

test('processJob claim decisions preserve canceled-at-claim and current cancellation gates', () => {
  assert.equal(decideJobClaim(undefined), 'ignore')
  assert.equal(decideJobClaim({ status: 'running' }), 'ignore')
  assert.equal(decideJobClaim({ status: 'queued', cancel_requested_at: 'now' }), 'cancel')
  assert.equal(decideJobClaim({ status: 'retry_wait' }), 'claim')
  assert.equal(decideClaimedJob(undefined), 'cancel')
  assert.equal(decideClaimedJob({ status: 'canceled' }), 'cancel')
  assert.equal(decideClaimedJob({ status: 'running', cancel_requested_at: 'now' }), 'cancel')
  assert.equal(decideClaimedJob({ status: 'running' }), 'continue')
})

test('processJob duplicate delivery polls nonterminal run instead of creating a run', () => {
  for (const state of ['submitting', 'submission_unknown', 'waiting', 'importing', 'canceling']) {
    assert.equal(isNonTerminalRunState(state), true)
    assert.equal(shouldCreateNewRun(state), false)
  }
  assert.equal(shouldCreateNewRun('failed'), true)
})

test('processJob distinguishes missing model terminal failure from capacity denial requeue', () => {
  assert.equal(decideCapacityDenial('MODEL_NOT_FOUND'), 'terminal_invalid_config')
  assert.equal(decideCapacityDenial('CONCURRENCY_LIMIT_EXCEEDED'), 'requeue')
  assert.equal(decideCapacityDenial(undefined), 'requeue')
})

test('processJob submit result decisions preserve sync and async state transitions', () => {
  const waiting = { status: 'waiting' as const, remoteId: 'remote-1' }
  const unknown = { status: 'submission_unknown' as const }
  const submitting = { status: 'submitting' as const, remoteId: 'remote-1' }
  assert.equal(decideSubmitResult(waiting, false), 'waiting')
  assert.equal(decideSubmitResult(unknown, false), 'submission_unknown')
  assert.equal(decideSubmitResult(submitting, false), 'submitting')
  assert.equal(decideSubmitResult(waiting, true), 'waiting')
  assert.equal(decideSubmitResult(unknown, true), 'empty_sync_remote')
  assert.equal(decideSubmitResult({ ...unknown, remoteId: 'remote-2' }, true), 'submission_unknown')
  assert.equal(decideSubmitResult({ status: 'succeeded' }, true), 'terminal')
})

test('isSynchronousPlugin distinguishes image-style and video-style plugins', () => {
  assert.equal(isSynchronousPlugin({}), true)
  assert.equal(isSynchronousPlugin({ poll: undefined }), true)
  assert.equal(isSynchronousPlugin({ poll: async () => ({ status: 'waiting' as const }) }), false)
})

test('classifySubmitError keeps the diagnostic an uploaded bundle carries', () => {
  const diagnostic = { status: 429, endpoint: '/v1/images/generations', detail: 'rate limited' }
  // A bundle cannot import NormalizedProviderError, so it signals with a plain Error.
  const temporary = classifySubmitError(Object.assign(new Error('PROVIDER_TEMPORARY_ERROR'), { diagnostic }), 'uploaded')
  assert.equal(temporary.code, 'PROVIDER_TEMPORARY_ERROR')
  assert.equal(temporary.retryable, true)
  assert.deepEqual(temporary.diagnostic, diagnostic)

  const rejected = classifySubmitError(Object.assign(new Error('PROVIDER_REJECTED'), { diagnostic }), 'uploaded')
  assert.equal(rejected.retryable, false, 'a rejection must never map to a retry')
  assert.deepEqual(rejected.diagnostic, diagnostic)

  const unnamed = classifySubmitError(Object.assign(new Error('boom'), { diagnostic }), 'uploaded')
  assert.equal(unnamed.code, 'GENERATION_FAILED')
  assert.deepEqual(unnamed.diagnostic, diagnostic)

  assert.equal(Array.isArray(classifySubmitError(Object.assign(new Error('PROVIDER_BUSY'), { diagnostic: [1, 2] }), 'uploaded').diagnostic), false)
  assert.deepEqual(classifySubmitError(new Error('PROVIDER_BUSY'), 'uploaded'), { code: 'PROVIDER_BUSY', retryable: true, diagnostic: null })
  assert.deepEqual(classifySubmitError(new Error('boom'), 'uploaded'), { code: 'GENERATION_FAILED', retryable: false, diagnostic: null })
  assert.deepEqual(classifySubmitError('PROVIDER_TIMEOUT', 'uploaded'), { code: 'GENERATION_FAILED', retryable: false, diagnostic: null })

  // The typed branches keep their own (narrower) retryable sets.
  const normalized = classifySubmitError(NormalizedProviderError.create('p', '1.0.0', 'OUTPUT_READ_FAILED', 'read failed'), 'p')
  assert.equal(normalized.code, 'OUTPUT_READ_FAILED')
  assert.equal(normalized.retryable, true)
  const notConfigured = classifySubmitError(NormalizedProviderError.create('p', '1.0.0', 'PROVIDER_NOT_CONFIGURED', 'disabled'), 'p')
  assert.equal(notConfigured.retryable, false)
  const providerDownload = classifySubmitError(NormalizedProviderError.create('p', '1.0.0', 'UNKNOWN_ERROR', 'flaked'), 'p')
  assert.equal(providerDownload.retryable, false, 'the NormalizedProviderError branch keeps its own narrow retryable set')

  // The availability gate throws this same error for a disabled plugin, so a disabled
  // install is a terminal PROVIDER_NOT_CONFIGURED here rather than a retry loop.
  let gated: unknown
  try {
    resolveMediaPlugin('jobs-test-unseen-plugin', '1.0.0')
    throw new Error('expected the gate to throw')
  } catch (error) {
    gated = error
  }
  assert.deepEqual(classifySubmitError(gated, 'jobs-test-unseen-plugin'), {
    code: 'PROVIDER_NOT_CONFIGURED',
    retryable: false,
    diagnostic: { ...normalizeDiagnostic(gated) },
  })
})

function normalizeDiagnostic(error: unknown): Record<string, unknown> {
  return (error as NormalizedProviderError).diagnostic as Record<string, unknown>
}


test('input body deadline destroys a stalled S3 stream and releases its waiter', async () => {
  const controller = new AbortController()
  let destroyed = 0
  const body: AsyncIterable<Uint8Array> & { destroy: () => void } = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }),
    destroy: () => { destroyed++ },
  }
  const pending = readInputBody(body, controller.signal, 10)
  const error = new Error('STORAGE_OPERATION_TIMEOUT')
  controller.abort(error)
  await assert.rejects(pending, value => value === error)
  assert.equal(destroyed, 1)
})

test('completed input body removes its abort listener', async () => {
  const controller = new AbortController()
  let destroyed = 0
  const bytes = new Uint8Array([1, 2, 3])
  const body: AsyncIterable<Uint8Array> & { destroy: () => void } = {
    async *[Symbol.asyncIterator]() { yield bytes },
    destroy: () => { destroyed++ },
  }
  assert.deepEqual(await readInputBody(body, controller.signal, 3), Buffer.from(bytes))
  controller.abort()
  assert.equal(destroyed, 0)
})

test('input body enforces per-object and remaining-total caps while streaming', async () => {
  for (const { chunks, cap, accepted } of [
    { chunks: [new Uint8Array(4), new Uint8Array(2)], cap: 5, accepted: false },
    { chunks: [new Uint8Array(3), new Uint8Array(3)], cap: 5, accepted: false },
    { chunks: [new Uint8Array(2), new Uint8Array(3)], cap: 5, accepted: true },
  ]) {
    let destroyed = 0
    let yielded = 0
    const body: AsyncIterable<Uint8Array> & { destroy: () => void } = {
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) { yielded++; yield chunk } },
      destroy: () => { destroyed++ },
    }
    if (accepted) {
      assert.equal((await readInputBody(body, new AbortController().signal, cap)).byteLength, cap)
      assert.equal(destroyed, 0)
    } else {
      await assert.rejects(readInputBody(body, new AbortController().signal, cap), /INVALID_INPUT_IMAGE_SIZE/)
      assert.equal(destroyed, 1)
      assert.equal(yielded, 2, 'stream stops as soon as the first over-limit chunk arrives')
    }
  }
})


test('media terminal producer follows saved outputs and shares caller rollback; retry_wait emits no completion', async () => {
  let committed = { status: 'running', assets: 0, outputs: 0, events: 0 }
  let staged = structuredClone(committed)
  let failOutbox = true
  const calls: string[] = []
  const client = { async query(sql: string, params: unknown[] = []) {
    calls.push(sql)
    if (sql === 'BEGIN') staged = structuredClone(committed)
    else if (sql === 'COMMIT') committed = structuredClone(staged)
    else if (sql.startsWith('SELECT status,deleted_at,cancel_requested_at')) return { rows: [{ status: staged.status, deleted_at: null, cancel_requested_at: null }] }
    else if (sql.startsWith('INSERT INTO assets')) { staged.assets++; return { rows: [{ id: 'asset' }] } }
    else if (sql.startsWith('INSERT INTO generation_outputs')) staged.outputs++
    else if (sql.startsWith("UPDATE generation_jobs SET status='succeeded'")) staged.status = 'succeeded'
    else if (sql.startsWith('UPDATE generation_jobs SET status=$2')) { staged.status = String(params[1]); return { rows: [{ id: 'job' }], rowCount: 1 } }
    else if (sql.includes("SELECT 'media.job.completed'")) {
      assert.ok(['succeeded', 'failed'].includes(staged.status))
      if (staged.status === 'succeeded') { assert.equal(staged.assets, 1); assert.equal(staged.outputs, 1) }
      if (failOutbox) throw new Error('OUTBOX_FAILED')
      staged.events++
    }
    return { rows: [], rowCount: 0 }
  } } as unknown as pg.PoolClient
  const withTransaction = async (work: () => Promise<unknown>) => {
    await client.query('BEGIN')
    try { await work(); await client.query('COMMIT') }
    catch (error) { await client.query('ROLLBACK'); throw error }
  }
  const success = () => persistJobSuccess(client, { jobId: 'job', createdBy: 'owner', prompt: 'draw', uploaded: [{ key: 'object', image: { mimeType: 'image/png', data: Buffer.from('fixture') }, checksum: 'a'.repeat(64) }] })
  await assert.rejects(withTransaction(success), /OUTBOX_FAILED/)
  assert.deepEqual(committed, { status: 'running', assets: 0, outputs: 0, events: 0 })
  assert.equal(calls.at(-1), 'ROLLBACK')
  failOutbox = false
  await withTransaction(success)
  assert.deepEqual(committed, { status: 'succeeded', assets: 1, outputs: 1, events: 1 })
  committed.status = 'running'
  const failure = { jobId: 'job', phase: 'generation_failed', code: 'FAILED', retryable: true }
  await withTransaction(() => persistJobFailure(client, failure))
  assert.equal(committed.status, 'retry_wait')
  assert.equal(committed.events, 1)
  committed.status = 'running'
  failOutbox = true
  await assert.rejects(withTransaction(() => persistJobFailure(client, { ...failure, retryable: false })), /OUTBOX_FAILED/)
  assert.equal(committed.status, 'running')
  assert.equal(committed.events, 1)
  failOutbox = false
  await withTransaction(() => persistJobFailure(client, { ...failure, retryable: false }))
  assert.equal(committed.status, 'failed')
  assert.equal(committed.events, 2)
})


test('post-preprocess cancel completion failure rejects delivery without failed commit, replay commits canceled', async t => {
  let committed = { status: 'queued', attempt: 0, cancel_requested_at: null as string | null, events: [] as string[] }
  let staged = structuredClone(committed)
  let inTransaction = false
  let failCompletion = true
  const statements: string[] = []
  const job = () => ({ id: 'job', ...staged, prompt: 'draw', optimization_mode: 'enabled', prompt_optimization_id: 'optimization', retry_cycle: '2026-10-25 00:00:00.123456+00' })
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push(sql)
    if (sql === 'BEGIN') { staged = structuredClone(committed); inTransaction = true }
    else if (sql === 'COMMIT') { committed = structuredClone(staged); inTransaction = false }
    else if (sql === 'ROLLBACK') { staged = structuredClone(committed); inTransaction = false }
    else if (sql.startsWith('SELECT * FROM provider_runs')) return { rows: [] }
    else if (sql.startsWith('SELECT j.id FROM generation_jobs')) return { rows: [] }
    else if (sql.includes('WITH ready AS') || sql.startsWith('UPDATE provider_runs') || sql.includes('FROM provider_runs WHERE job_id=') || sql.includes('SELECT id, job_id, state_revision')) return { rows: [] }
    else if (sql.includes('SELECT id FROM generation_jobs') && sql.includes('cancel_requested_at')) return { rows: [{ id: 'job' }] }
    else if (sql.startsWith('SELECT status FROM generation_jobs')) return { rows: [{ status: staged.status }] }
    else if (sql.startsWith('SELECT *') && sql.includes('generation_jobs')) return { rows: [job()] }
    else if (sql.includes('attempt=attempt+1')) { staged.status = 'running'; staged.attempt++ }
    else if (sql.startsWith('SELECT po.*')) {
      // A concurrent cancel arrives while real preprocessing is in progress.
      assert.equal(inTransaction, false)
      committed.cancel_requested_at = 'cancel-requested'
      staged = structuredClone(committed)
      return { rows: [{ final_prompt: 'prepared prompt' }] }
    } else if (sql.startsWith('UPDATE generation_jobs SET phase=')) return { rows: [] }
    else if (sql.startsWith("UPDATE generation_jobs SET status='canceled'")) staged.status = 'canceled'
    else if (sql.includes("SELECT 'media.job.completed'")) {
      assert.equal(inTransaction, true)
      assert.equal(staged.status, 'canceled')
      if (failCompletion) throw new Error('OUTBOX_FAILED')
      staged.events.push(staged.status)
    } else if (sql.startsWith('SELECT id FROM generation_jobs')) return { rows: [{ id: 'job' }] }
    else if (sql.startsWith('UPDATE generation_jobs SET status=$2')) {
      // The regression reached this branch and ACKed a failed job after rollback.
      staged.status = String(values[1])
      return { rows: [{ id: 'job' }], rowCount: 1 }
    } else if (!['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) assert.fail(`Unexpected SQL: ${sql}`)
    return { rows: [], rowCount: 0 }
  }
  t.mock.method(db(), 'query', query)
  t.mock.method(db(), 'connect', async () => ({ query, release() {} }))
  await assert.rejects(processJob('job'), LifecyclePersistenceError)
  assert.equal(committed.status, 'running')
  assert.equal(committed.cancel_requested_at, 'cancel-requested')
  assert.deepEqual(committed.events, [])
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.ok(!statements.some(sql => sql.startsWith('UPDATE generation_jobs SET status=$2')))
  failCompletion = false
  // Real maintenance commits the existing no-run cancellation before redelivery.
  await scheduleMaintenance()
  assert.equal(committed.status, 'canceled')
  assert.equal(await processJob('job'), true)
  assert.equal(committed.status, 'canceled')
  assert.deepEqual(committed.events, ['canceled'])
  assert.ok(!statements.some(sql => sql.includes('INSERT INTO provider_runs')))
})
