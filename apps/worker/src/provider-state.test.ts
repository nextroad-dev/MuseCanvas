import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY ||= 'test-worker-encryption-key'

const {
  canAcquireLease,
  decryptOpaqueState,
  encryptOpaqueState,
  ingestionStorageKey,
  isCancelRequested,
  isLeaseExpired,
  isSyncRetryPersistenceError,
  isSyncRetryableResultError,
  isSyncRetryableSubmitCode,
  manifestContainsSecrets,
  MAX_RESOLVED_OUTPUT_BYTES,
  MAX_SYNC_SUBMIT_ATTEMPTS,
  nextActionAtForRetryAfter,
  planSyncSubmitRetry,
  resolveOutputMaxBytes,
  shouldCreateNewRun,
  shouldRetrySyncSubmit,
  stripOutputManifest,
  SYNC_RETRY_PERSISTENCE_ERROR_CODE,
  SYNC_RETRYABLE_HTTP_STATUS,
  SyncRetryPersistenceError,
  syncNoRemotePollCode,
} = await import('./provider-state')

test('opaque state round-trips locator without leaking into manifest', () => {
  const opaque = { remoteId: 'seedance-123', pollUrl: 'https://provider.example/jobs/seedance-123', cursor: 'abc' }
  const payload = encryptOpaqueState(opaque)
  assert.ok(payload && typeof payload === 'string')
  assert.deepEqual(decryptOpaqueState(payload), opaque)
  const manifest = stripOutputManifest([
    { index: 0, mimeType: 'video/mp4', url: 'https://provider.example/signed/video.mp4?sig=secret', durationSeconds: 5, metadata: { poster: 'https://provider.example/signed/poster.jpg?sig=x', codec: 'h264' } },
  ])
  assert.ok(manifest)
  assert.equal(manifestContainsSecrets({ outputs: [{ url: 'https://provider.example/signed/x?sig=1' }] }), true)
  assert.equal(manifestContainsSecrets({ manifest }), false)
  assert.equal((manifest as Array<Record<string, unknown>>)[0].mimeType, 'video/mp4')
  assert.ok(!JSON.stringify(manifest).includes('https://'))
})

test('unknown submission never triggers a blind resubmit', () => {
  assert.equal(shouldCreateNewRun('submission_unknown'), false)
  assert.equal(shouldCreateNewRun('submitting'), false)
  assert.equal(shouldCreateNewRun('waiting'), false)
  assert.equal(shouldCreateNewRun('importing'), false)
  assert.equal(shouldCreateNewRun('canceling'), false)
  assert.equal(shouldCreateNewRun('succeeded'), true)
  assert.equal(shouldCreateNewRun('failed'), true)
  assert.equal(shouldCreateNewRun('canceled'), true)
  assert.equal(shouldCreateNewRun(null), true)
})

test('stale lease can be reclaimed while active lease is protected', () => {
  const now = Date.now()
  const expired = new Date(now - 1000).toISOString()
  const active = new Date(now + 60_000).toISOString()
  assert.equal(isLeaseExpired(expired, now), true)
  assert.equal(isLeaseExpired(active, now), false)
  assert.equal(isLeaseExpired(null, now), true)
  assert.equal(canAcquireLease('token-a', expired, 'token-b', now), true)
  assert.equal(canAcquireLease('token-a', active, 'token-b', now), false)
  assert.equal(canAcquireLease('token-a', active, 'token-a', now), true)
  assert.equal(canAcquireLease(null, null, 'token-b', now), true)
})

test('retry-after schedules bounded future polling', () => {
  const before = Date.now()
  const soon = nextActionAtForRetryAfter(3000).getTime()
  assert.ok(soon >= before + 2500 && soon <= before + 4000)
  const floored = nextActionAtForRetryAfter(0).getTime()
  assert.ok(floored >= before + 900)
  const capped = nextActionAtForRetryAfter(10_000_000).getTime()
  assert.ok(capped <= before + 600_000 + 50)
  const fallback = nextActionAtForRetryAfter(undefined, 5000).getTime()
  assert.ok(fallback >= before + 4000)
})

test('cancellation is detected from cancel_requested_at only', () => {
  assert.equal(isCancelRequested({ cancel_requested_at: new Date().toISOString(), status: 'running' }), true)
  assert.equal(isCancelRequested({ status: 'running' }), false)
  assert.equal(isCancelRequested({ cancel_requested_at: null, status: 'running' }), false)
})

test('output ingestion keys are deterministic per output index', () => {
  const a = ingestionStorageKey('user-1', 'run-1', 0, 'video/mp4')
  const b = ingestionStorageKey('user-1', 'run-1', 0, 'video/mp4')
  const c = ingestionStorageKey('user-1', 'run-1', 1, 'video/mp4')
  const img = ingestionStorageKey('user-1', 'run-1', 0, 'image/png')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.ok(a.endsWith('.mp4'))
  assert.ok(img.endsWith('.png'))
  assert.ok(a.startsWith('user-1/run-1/'))
})

test('worker uses leases, XAUTOCLAIM, capacity reservation without sleep loops', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)))
  const jobsSrc = readFileSync(join(root, 'jobs', 'index.ts'), 'utf8')
  const queueSrc = readFileSync(join(root, 'queue', 'index.ts'), 'utf8')
  const maintenanceSrc = readFileSync(join(root, 'maintenance', 'index.ts'), 'utf8')
  assert.ok(!/setTimeout|setInterval|sleep\(/.test(jobsSrc), 'jobs must not sleep around provider operations')
  assert.ok(!/setTimeout/.test(queueSrc), 'queue must not sleep around provider operations')
  assert.ok(/xAutoClaim/i.test(queueSrc), 'queue must XAUTOCLAIM stale pending messages')
  assert.ok(/xAck/i.test(queueSrc), 'queue must acknowledge each message')
  assert.ok(/acquireModelCapacity/.test(jobsSrc), 'jobs must reserve capacity per model')
  assert.ok(/acquireWorkerLease/.test(jobsSrc), 'jobs must use Postgres leases')
  assert.ok(/encryptOpaqueState|decryptOpaqueState/.test(jobsSrc), 'jobs must encrypt opaque provider state')
  assert.ok(/stripOutputManifest/.test(jobsSrc), 'jobs must strip signed URLs from manifests')
  assert.ok(/openOutput/.test(jobsSrc), 'jobs must use bounded plugin.openOutput for ingestion')
  assert.ok(/worker_lease_expires_at/.test(maintenanceSrc), 'maintenance must recover expired leases')
  assert.ok(/next_action_at/.test(maintenanceSrc), 'maintenance must schedule due provider-run polling')
  assert.ok(/cancel_requested_at/.test(maintenanceSrc), 'maintenance must handle cooperative cancellation')
})

test('synchronous retry only resubmits explicit 429 non-acceptance', () => {
  assert.equal(MAX_SYNC_SUBMIT_ATTEMPTS, 3)
  assert.equal(SYNC_RETRYABLE_HTTP_STATUS, 429)
  const rateLimited = { status: 429 }
  assert.equal(isSyncRetryableSubmitCode('PROVIDER_TEMPORARY_ERROR', rateLimited), true)
  assert.equal(isSyncRetryableSubmitCode('PROVIDER_TEMPORARY_ERROR', { status: 503 }), false)
  assert.equal(isSyncRetryableSubmitCode('PROVIDER_TEMPORARY_ERROR', { status: 500 }), false)
  assert.equal(isSyncRetryableSubmitCode('PROVIDER_TEMPORARY_ERROR'), false)
  assert.equal(isSyncRetryableSubmitCode('PROVIDER_TEMPORARY_ERROR', null), false)
  assert.equal(isSyncRetryableSubmitCode('PROVIDER_TIMEOUT', rateLimited), false)
  assert.equal(isSyncRetryableSubmitCode('PROVIDER_TIMEOUT', { status: 429 }), false)
  assert.equal(isSyncRetryableSubmitCode('PROVIDER_REJECTED', rateLimited), false)
  assert.equal(isSyncRetryableSubmitCode('PROVIDER_BUSY', rateLimited), false)
  assert.equal(isSyncRetryableSubmitCode(undefined, rateLimited), false)

  for (const attempt of [1, 2]) {
    assert.equal(shouldRetrySyncSubmit(attempt, 'PROVIDER_TEMPORARY_ERROR', rateLimited), true)
    assert.equal(shouldRetrySyncSubmit(attempt, 'PROVIDER_TEMPORARY_ERROR', { status: 503 }), false)
    assert.equal(shouldRetrySyncSubmit(attempt, 'PROVIDER_TIMEOUT', rateLimited), false)
    const plan = planSyncSubmitRetry(attempt, 'PROVIDER_TEMPORARY_ERROR', rateLimited)
    assert.equal(plan.retry, true)
    assert.equal(plan.runOperationState, 'failed')
    assert.equal(plan.releaseCapacity, true)
    assert.equal(plan.completeRun, true)
    assert.equal(plan.jobStatus, 'retry_wait')
    assert.equal(plan.outboxEventType, 'generation.retry')
  }

  assert.equal(
    isSyncRetryableResultError({ status: 'failed', error: { code: 'PROVIDER_TEMPORARY_ERROR', status: 429 } }),
    true,
  )
  assert.equal(
    isSyncRetryableResultError({ status: 'failed', error: { code: 'PROVIDER_TEMPORARY_ERROR', status: 503 } }),
    false,
  )
  assert.equal(
    isSyncRetryableResultError({ status: 'failed', error: { code: 'PROVIDER_TIMEOUT', status: 429 } }),
    false,
  )
  assert.equal(
    isSyncRetryableResultError({ status: 'failed', error: { code: 'PROVIDER_REJECTED', status: 429 } }),
    false,
  )
  assert.equal(
    isSyncRetryableResultError({ status: 'succeeded', error: { code: 'PROVIDER_TEMPORARY_ERROR', status: 429 } }),
    false,
  )
})

test('third synchronous attempt is terminal and releases capacity without requeue', () => {
  const rateLimited = { status: 429 }
  assert.equal(shouldRetrySyncSubmit(3, 'PROVIDER_TEMPORARY_ERROR', rateLimited), false)
  assert.equal(shouldRetrySyncSubmit(4, 'PROVIDER_TEMPORARY_ERROR', rateLimited), false)
  assert.equal(shouldRetrySyncSubmit(1, 'PROVIDER_REJECTED', rateLimited), false)
  assert.equal(shouldRetrySyncSubmit(1, 'PROVIDER_TEMPORARY_ERROR', { status: 503 }), false)
  assert.equal(shouldRetrySyncSubmit(0, 'PROVIDER_TEMPORARY_ERROR', rateLimited), false)

  const plan = planSyncSubmitRetry(3, 'PROVIDER_TEMPORARY_ERROR', rateLimited)
  assert.equal(plan.retry, false)
  assert.equal(plan.runOperationState, 'failed')
  assert.equal(plan.releaseCapacity, true)
  assert.equal(plan.completeRun, true)
  assert.equal(plan.jobStatus, 'failed')
  assert.equal(plan.outboxEventType, null)
})

test('sync no-remote recovery terminalizes submitting runs as temporary, reserves empty-result for completed empties', () => {
  assert.equal(syncNoRemotePollCode('submitting'), 'PROVIDER_TEMPORARY_ERROR')
  assert.equal(syncNoRemotePollCode('waiting'), 'PROVIDER_EMPTY_RESULT')
  assert.equal(syncNoRemotePollCode('submission_unknown'), 'PROVIDER_EMPTY_RESULT')
  assert.equal(syncNoRemotePollCode('importing'), 'PROVIDER_EMPTY_RESULT')
  assert.equal(syncNoRemotePollCode(null), 'PROVIDER_EMPTY_RESULT')
  assert.equal(syncNoRemotePollCode(undefined), 'PROVIDER_EMPTY_RESULT')
})

test('output byte cap defaults when unset and rejects unbounded or invalid values', () => {
  assert.equal(MAX_RESOLVED_OUTPUT_BYTES, 100_000_000)
  assert.equal(resolveOutputMaxBytes(undefined), 100_000_000)
  assert.equal(resolveOutputMaxBytes(null), 100_000_000)
  assert.equal(resolveOutputMaxBytes(''), 100_000_000)
  assert.equal(resolveOutputMaxBytes(100_000_000), 100_000_000)
  assert.equal(resolveOutputMaxBytes(1024), 1024)
  assert.equal(resolveOutputMaxBytes('4096'), 4096)
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 100_000_001, 'huge', {}, []]) {
    assert.throws(() => resolveOutputMaxBytes(bad), /INVALID_CONFIG/)
  }
})

test('sync retry persistence marker survives identity checks and never looks terminal', () => {
  const marker = new SyncRetryPersistenceError(new Error('RUN_STATE_CONFLICT'))
  assert.equal(marker.message, SYNC_RETRY_PERSISTENCE_ERROR_CODE)
  assert.equal(marker.name, 'SyncRetryPersistenceError')
  assert.ok(marker.cause instanceof Error)
  assert.equal(isSyncRetryPersistenceError(marker), true)
  assert.equal(isSyncRetryPersistenceError(new Error(SYNC_RETRY_PERSISTENCE_ERROR_CODE)), true)
  assert.equal(isSyncRetryPersistenceError(new Error('PROVIDER_TEMPORARY_ERROR')), false)
  assert.equal(isSyncRetryPersistenceError(new Error('GENERATION_FAILED')), false)
  assert.equal(isSyncRetryPersistenceError(null), false)
  assert.equal(isSyncRetryPersistenceError(undefined), false)
})
