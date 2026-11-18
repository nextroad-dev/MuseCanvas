import { assertBootstrapConfig } from '@musecanvas/config'
import { AgentMediaRecoveryRepository, AgentRecoveryRepository, db, type AgentCoreTransaction } from '@musecanvas/database'
import { initializeObservability, shutdownObservability } from '@musecanvas/observability'
import { redis, redisCommand } from './shared/infra'
import { consume, trimGenerationStream } from './queue'
import { processJob } from './jobs'
import { cleanupMaintenance, scheduleMaintenance } from './maintenance'
import { PLUGIN_BOOT_REFRESH_BUDGET_MS, refreshPlugins } from './plugins/loader'
import { assertBuiltinPluginsAvailable } from './plugins/availability'
import { runCredentialTests } from './credentials/probe'
import { assertWorkerSchema, WorkerAgentIndexSchemaRequiredError, WorkerAgentMediaSchemaRequiredError, WorkerAgentSchemaRequiredError, WorkerSchemaRequiredError } from './shared/schema-preflight'
import { createWorkerHealth, startHealthServer } from './shared/health'
import { createDrainingSweep } from './shared/draining-sweep'
import { createProductionAgentComposition } from './agent-production'
import { startAgentWorkers, type AgentWorkerComposition } from './agent/boot'
import { superviseWorkerLoops } from './agent/consumer'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { agentRecoveryIntervalMs, runAgentCoordinator, runCoordinatorTick, type AgentCoordinatorPort } from './agent/coordinator'

// Recovery repositories take the database package's narrower transaction port.
// The pool client itself provides the query surface, so adapt it here instead
// of changing packages/database.
const agentCoreTransaction: AgentCoreTransaction = async (work, readOnly = false) => {
  const client = await db().connect()
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

export async function main(agentComposition?: AgentWorkerComposition) {
  // Imports above stay side-effect free (no S3/DB connects at module load),
  // so bootstrap validation runs before schema preflight: missing DATABASE_URL,
  // REDIS_URL, APP_MASTER_KEY, or NODE_ENV exits BOOTSTRAP_CONFIG_INVALID
  // before any queue or maintenance work starts. S3 is still not required
  // here; storage resolves lazily on first use.
  assertBootstrapConfig()
  // Fail before Redis, health, plugin refresh or either generation scheduling path.
  await assertWorkerSchema()
  await initializeObservability('musecanvas-worker', process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
  await redisCommand(redis.connect())
  const recovery = new AgentRecoveryRepository(agentCoreTransaction)
  const mediaRecovery = new AgentMediaRecoveryRepository(agentCoreTransaction)
  const coordinatorPort: AgentCoordinatorPort = {
    expireDeadlines: limit => recovery.expireDeadlines(limit),
    expireApprovals: limit => recovery.expireApprovals(limit),
    finalizeCancellations: limit => recovery.finalizeCancellations(limit),
    recoverExpiredLeases: limit => recovery.recoverExpiredLeases(limit),
    reconcileMediaJobs: limit => mediaRecovery.reconcileMediaJobs(limit),
    settleAbandonedMedia: limit => mediaRecovery.settleAbandonedMedia(limit),
    outboxBacklog: () => recovery.outboxBacklog(),
  }
  const composition = agentComposition ?? createProductionAgentComposition()
  const health = createWorkerHealth()
  const server = startHealthServer(health)
  const shutdown = new AbortController()
  const stop = () => { shutdown.abort(); server.close() }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  // Every job path resolves through the availability gate, so verify here — not by
  // assumption — that the built-in keys (media and language) it short-circuits really resolve.
  assertBuiltinPluginsAvailable()
  // The plugin catalog refresh is never allowed to gate boot: it swallows its own
  // errors and runs under a deadline, because a worker without S3 configured (or
  // with one wedged artifact) must still serve the built-in plugins. Installed
  // plugins stay unavailable with PROVIDER_NOT_CONFIGURED until it lands.
  const refreshCatalog = async () => {
    try {
      const result = await refreshPlugins()
      if (result.changed || result.loaded || result.failed) console.log('plugin catalog refreshed', { code: 'PLUGIN_CATALOG_REFRESHED', rows: result.rows, loaded: result.loaded, failed: result.failed })
    } catch (error) { console.error('plugin catalog refresh failed', { code: error instanceof Error ? error.name : 'ERROR' }) }
  }
  await Promise.race([
    refreshCatalog(),
    new Promise<void>(resolve => { setTimeout(resolve, PLUGIN_BOOT_REFRESH_BUDGET_MS).unref() }),
  ])
  let running = false
  const runMaintenance = async () => {
    if (running) return
    running = true
    try {
      await scheduleMaintenance()
      health.scheduleProgress()
    }
    catch (error) { console.error('maintenance failed', { code: error instanceof Error ? error.name : 'ERROR' }) }
    finally { running = false }
  }
  // Slow object deletion or plugin downloads cannot block outbox/poll scheduling.
  void runMaintenance()
  // Recovery is not gated by AGENT_CORE_ENABLED: turning the API feature flag
  // off stops admission but admitted turns must still drain and settle.
  const coordinator = createDrainingSweep(shutdown.signal, async () => {
    const summary = await runAgentCoordinator(coordinatorPort)
    if (summary.processed > 0 || summary.failures > 0) {
      console.log('agent coordinator sweep summary', { code: 'AGENT_RECOVERY_SWEEP', ...summary })
    }
  })
  const runCoordinator = () => runCoordinatorTick(coordinator, health)
  void runCoordinator()
  const timers: Array<ReturnType<typeof setInterval>> = [setInterval(runMaintenance, 5000)]
  timers.push(setInterval(runCoordinator, agentRecoveryIntervalMs()))
  let cleaning = false
  timers.push(setInterval(async () => {
    if (cleaning) return
    cleaning = true
    try { await cleanupMaintenance() }
    catch (error) { console.error('cleanup failed', { code: error instanceof Error ? error.name : 'ERROR' }) }
    finally { cleaning = false }
  }, 10_000))
  let refreshing = false
  timers.push(setInterval(async () => {
    if (refreshing) return
    refreshing = true
    try { await refreshCatalog() }
    finally { refreshing = false }
  }, 30_000))
  let trimming = false
  timers.push(setInterval(async () => {
    if (trimming) return
    trimming = true
    try { await trimGenerationStream() }
    catch (error) { console.error('stream cleanup failed', { code: error instanceof Error ? error.name : 'ERROR' }) }
    finally { trimming = false }
  }, 30_000))
  let unhealthySince = Date.now()
  timers.push(setInterval(() => {
    if (health.ready()) unhealthySince = Date.now()
    else if (Date.now() - unhealthySince > 180_000) {
      console.error('worker progress stalled', { code: 'WORKER_STALLED' })
      process.exit(1)
    }
  }, 10_000))
  // Credential tests have an admin waiting on them, so they get their own short
  // cadence instead of queueing behind maintenance or a long generation job.
  let testing = false
  timers.push(setInterval(async () => {
    if (testing) return
    testing = true
    try { await runCredentialTests() }
    catch (error) { console.error('credential tests failed', { code: error instanceof Error ? error.name : 'ERROR' }) }
    finally { testing = false }
  }, 2000))
  try {
    await superviseWorkerLoops([
      ()=>consume(processJob, { signal: shutdown.signal, onActivity: health.queueProgress }),
      ()=>startAgentWorkers({ signal: shutdown.signal, composition, onActivity: health.queueProgress }),
    ],shutdown)
  }
  finally {
    shutdown.abort()
    for (const timer of timers) clearInterval(timer)
    try { await coordinator.drain() }
    catch (error) { console.error('agent coordinator drain failed', { code: error instanceof Error ? error.name : 'ERROR' }) }
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    server.close()
    if (redis.isOpen) redis.destroy()
    try { await shutdownObservability() }
    catch (error) { console.error('observability shutdown failed', { code: error instanceof Error ? error.name : 'ERROR' }) }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main().catch(async error => {
  console.error('worker fatal', error instanceof WorkerSchemaRequiredError
    ? { code: error.name, requiredMigration: '0042', missingColumns: error.missingColumns }
    : error instanceof WorkerAgentMediaSchemaRequiredError
      ? { code: error.name, requiredMigration: '0045', missingColumns: error.missingColumns }
      : error instanceof WorkerAgentIndexSchemaRequiredError
        ? { code: error.name, requiredMigration: '0044', missingIndexes: error.missingIndexes }
        : error instanceof WorkerAgentSchemaRequiredError
          ? { code: error.name, requiredMigration: '0043', missingColumns: error.missingColumns }
          : { code: error instanceof Error ? error.name : 'ERROR' })
  try { await shutdownObservability() }
  catch (shutdownError) { console.error('observability shutdown failed', { code: shutdownError instanceof Error ? shutdownError.name : 'ERROR' }) }
  process.exit(1)
})
