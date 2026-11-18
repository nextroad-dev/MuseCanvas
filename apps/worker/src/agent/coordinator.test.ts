import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import {
  AGENT_RECOVERY_DEFAULT_BATCH_SIZE,
  AGENT_RECOVERY_DEFAULT_INTERVAL_MS,
  agentRecoveryBatchSize,
  agentRecoveryIntervalMs,
  runAgentCoordinator,
  runCoordinatorTick,
  type AgentCoordinatorLogger,
} from './coordinator'

type RecoveryKind = 'deadline' | 'approval' | 'cancel' | 'lease' | 'media'
type SweepName = RecoveryKind | 'abandoned-media'
interface Outcome { kind: RecoveryKind; processed: number; remaining: boolean }
interface Backlog { pending: number; oldestAgeMs: number | null; quarantined: number }
interface Port {
  expireDeadlines(limit: number): Promise<Outcome>
  expireApprovals(limit: number): Promise<Outcome>
  finalizeCancellations(limit: number): Promise<Outcome>
  recoverExpiredLeases(limit: number): Promise<Outcome>
  reconcileMediaJobs(limit: number): Promise<Outcome>
  settleAbandonedMedia(limit: number): Promise<Outcome>
  outboxBacklog(): Promise<Backlog>
}

const outcome = (kind: RecoveryKind, processed = 0, remaining = false): Outcome => ({ kind, processed, remaining })
type Call = { sweep: SweepName; limit: number }
type Log = { level: 'info' | 'error'; event: string; fields?: Record<string, unknown> }

function makePort(overrides: Partial<Port> = {}, backlog: Backlog = { pending: 0, oldestAgeMs: null, quarantined: 0 }) {
  const calls: Call[] = []
  const record = (name: SweepName, run: (limit: number) => Promise<Outcome>) => async (limit: number) => {
    calls.push({ sweep: name, limit })
    return run(limit)
  }
  const port: Port = {
    expireDeadlines: record('deadline', overrides.expireDeadlines ?? (async () => outcome('deadline'))),
    expireApprovals: record('approval', overrides.expireApprovals ?? (async () => outcome('approval'))),
    finalizeCancellations: record('cancel', overrides.finalizeCancellations ?? (async () => outcome('cancel'))),
    recoverExpiredLeases: record('lease', overrides.recoverExpiredLeases ?? (async () => outcome('lease'))),
    reconcileMediaJobs: record('media', overrides.reconcileMediaJobs ?? (async () => outcome('media'))),
    settleAbandonedMedia: record('abandoned-media', overrides.settleAbandonedMedia ?? (async () => outcome('media'))),
    outboxBacklog: overrides.outboxBacklog ?? (async () => backlog),
  }
  return { port, calls }
}

function captureLogger() {
  const logs: Log[] = []
  const logger: AgentCoordinatorLogger = {
    info: (event, fields) => { logs.push({ level: 'info', event, fields }) },
    error: (event, fields) => { logs.push({ level: 'error', event, fields }) },
  }
  return { logger, logs }
}

function setEnv(t: TestContext, key: string, value: string | undefined) {
  const previous = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  t.after(() => {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  })
}

test('coordinator runs all six sweeps in order with the same bounded batch size', async () => {
  const { port, calls } = makePort({
    expireDeadlines: async () => outcome('deadline', 1),
    expireApprovals: async () => outcome('approval', 2, true),
    finalizeCancellations: async () => outcome('cancel', 0),
    recoverExpiredLeases: async () => outcome('lease', 3, true),
    reconcileMediaJobs: async () => outcome('media', 4),
    settleAbandonedMedia: async () => outcome('media', 5),
  })
  const { logger, logs } = captureLogger()

  const summary = await runAgentCoordinator(port, { batchSize: 7, logger })

  assert.deepEqual(calls.map(call => call.sweep), ['deadline', 'approval', 'cancel', 'lease', 'media', 'abandoned-media'])
  assert.deepEqual(calls.map(call => call.limit), [7, 7, 7, 7, 7, 7])
  assert.deepEqual(summary, { sweeps: 6, processed: 15, failures: 0 })
  const sweeps = logs.filter(log => log.event === 'agent coordinator sweep')
  assert.deepEqual(sweeps.map(log => log.fields), [
    { kind: 'deadline', processed: 1, remaining: false },
    { kind: 'approval', processed: 2, remaining: true },
    { kind: 'lease', processed: 3, remaining: true },
    { kind: 'media', processed: 4, remaining: false },
    { kind: 'media', processed: 5, remaining: false },
  ])
  assert.equal(logs.some(log => log.level === 'error'), false)
})

test('one failed sweep does not block later sweeps and logs only a safe error code', async () => {
  const secret = 'token=super-secret-value'
  const failure = new Error(secret)
  failure.name = 'DB_QUERY_FAILED'
  const { port, calls } = makePort({
    expireApprovals: async () => { throw failure },
    expireDeadlines: async () => outcome('deadline', 1),
    finalizeCancellations: async () => outcome('cancel', 2),
    recoverExpiredLeases: async () => outcome('lease', 0),
    reconcileMediaJobs: async () => outcome('media', 3),
    settleAbandonedMedia: async () => outcome('media', 4),
  })
  const { logger, logs } = captureLogger()

  const summary = await runAgentCoordinator(port, { batchSize: 5, logger })

  assert.deepEqual(calls.map(call => call.sweep), ['deadline', 'approval', 'cancel', 'lease', 'media', 'abandoned-media'])
  assert.deepEqual(summary, { sweeps: 6, processed: 10, failures: 1 })
  const errors = logs.filter(log => log.level === 'error')
  assert.deepEqual(errors, [{ level: 'error', event: 'agent coordinator sweep failed', fields: { kind: 'approval', code: 'DB_QUERY_FAILED' } }])
  assert.equal(JSON.stringify(logs).includes(secret), false)
  assert.equal(logs.some(log => log.event === 'agent coordinator sweep' && log.fields?.kind === 'approval'), false)
})

test('backlog defaults warn once when pending, age, or quarantine exceeds its threshold', async t => {
  await t.test('any exceeded threshold produces one warning', async () => {
    const { port } = makePort({}, { pending: 1001, oldestAgeMs: 300_001, quarantined: 2 })
    const { logger, logs } = captureLogger()
    await runAgentCoordinator(port, { logger })
    const warnings = logs.filter(log => log.event === 'agent coordinator backlog warning')
    assert.equal(warnings.length, 1)
    assert.deepEqual(warnings[0]?.fields, {
      pending: 1001,
      oldestAgeMs: 300_001,
      quarantined: 2,
      pendingWarn: 1000,
      ageWarnMs: 300_000,
      quarantinedWarn: 0,
    })
  })

  await t.test('threshold boundaries do not warn', async () => {
    const { port } = makePort({}, { pending: 1000, oldestAgeMs: 300_000, quarantined: 0 })
    const { logger, logs } = captureLogger()
    await runAgentCoordinator(port, { logger })
    assert.equal(logs.some(log => log.event === 'agent coordinator backlog warning'), false)
  })

  await t.test('null oldest age never warns and custom thresholds are honored', async () => {
    const { port } = makePort({}, { pending: 10, oldestAgeMs: null, quarantined: 1 })
    const { logger, logs } = captureLogger()
    await runAgentCoordinator(port, { logger, backlog: { pendingWarn: 10, ageWarnMs: 0, quarantinedWarn: 1 } })
    assert.equal(logs.some(log => log.event === 'agent coordinator backlog warning'), false)

    const warning = captureLogger()
    await runAgentCoordinator(port, { logger: warning.logger, backlog: { pendingWarn: 9, ageWarnMs: 0, quarantinedWarn: 0 } })
    assert.equal(warning.logs.filter(log => log.event === 'agent coordinator backlog warning').length, 1)
  })
})

test('a backlog failure is isolated and counted without rejecting the run', async () => {
  const failure = new Error('outbox unavailable')
  failure.name = 'OUTBOX_UNAVAILABLE'
  const { port } = makePort({
    outboxBacklog: async () => { throw failure },
    expireDeadlines: async () => outcome('deadline', 2),
    expireApprovals: async () => outcome('approval', 1),
  })
  const { logger, logs } = captureLogger()

  const summary = await runAgentCoordinator(port, { logger })

  assert.deepEqual(summary, { sweeps: 6, processed: 3, failures: 1 })
  assert.deepEqual(logs.filter(log => log.level === 'error'), [{
    level: 'error',
    event: 'agent coordinator backlog failed',
    fields: { kind: 'outbox', code: 'OUTBOX_UNAVAILABLE' },
  }])
})

test('batch size and interval parsing use the frozen defaults and bounds', async t => {
  await t.test('batch size parses the environment and falls back on invalid values', async () => {
    for (const [raw, expected] of [['1', 1], ['500', 500], ['25', 25], ['0', 50], ['501', 50], ['2.5', 50], ['', 50], [undefined, 50]] as const) {
      assert.equal(agentRecoveryBatchSize(raw), expected, String(raw))
    }
  })

  await t.test('coordinator reads AGENT_RECOVERY_BATCH_SIZE when no option is provided', async (t) => {
    setEnv(t, 'AGENT_RECOVERY_BATCH_SIZE', '9')
    const { port, calls } = makePort()
    await runAgentCoordinator(port, { logger: captureLogger().logger })
    assert.deepEqual(calls.map(call => call.limit), Array(6).fill(9))
  })

  await t.test('an invalid explicit batch size falls back to 50 instead of the env value', async (t) => {
    setEnv(t, 'AGENT_RECOVERY_BATCH_SIZE', '9')
    const explicit = makePort()
    await runAgentCoordinator(explicit.port, { batchSize: 0, logger: captureLogger().logger })
    assert.deepEqual(explicit.calls.map(call => call.limit), Array(6).fill(AGENT_RECOVERY_DEFAULT_BATCH_SIZE))
  })

  await t.test('an out-of-range env batch size falls back to 50', async (t) => {
    setEnv(t, 'AGENT_RECOVERY_BATCH_SIZE', '501')
    const fromEnv = makePort()
    await runAgentCoordinator(fromEnv.port, { logger: captureLogger().logger })
    assert.deepEqual(fromEnv.calls.map(call => call.limit), Array(6).fill(AGENT_RECOVERY_DEFAULT_BATCH_SIZE))
  })

  await t.test('interval parses the environment with 1000..60000 bounds', () => {
    assert.equal(AGENT_RECOVERY_DEFAULT_INTERVAL_MS, 5000)
    for (const [raw, expected] of [['1000', 1000], ['60000', 60_000], ['999', 5000], ['60001', 5000], ['5000.5', 5000], ['', 5000], [undefined, 5000]] as const) {
      assert.equal(agentRecoveryIntervalMs(raw), expected, String(raw))
    }
  })
})

test('coordinator supervision handles a rejected tick and reports progress only after success', async () => {
  const progress: number[] = []
  const health = { scheduleProgress: () => { progress.push(1) } }
  const { logger, logs } = captureLogger()
  const failure = new Error('coordinator tick exploded')
  failure.name = 'COORDINATOR_TICK_FAILED'

  await runCoordinatorTick({ run: async () => { throw failure } }, health, logger)
  assert.deepEqual(progress, [])
  assert.deepEqual(logs, [{ level: 'error', event: 'agent coordinator failed', fields: { code: 'COORDINATOR_TICK_FAILED' } }])

  await runCoordinatorTick({ run: async () => {} }, health, logger)
  assert.equal(progress.length, 1)
  assert.equal(logs.length, 1)
})

test('an unawaited initial coordinator tick never becomes an unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    void runCoordinatorTick(
      { run: async () => { throw new Error('initial tick') } },
      { scheduleProgress: () => {} },
      captureLogger().logger,
    )
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})
