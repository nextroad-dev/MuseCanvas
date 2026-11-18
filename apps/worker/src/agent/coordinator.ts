import type { AgentOutboxBacklog, AgentRecoveryKind, AgentRecoveryOutcome } from '@musecanvas/database'

export interface AgentCoordinatorPort {
  expireDeadlines(limit: number): Promise<AgentRecoveryOutcome>
  expireApprovals(limit: number): Promise<AgentRecoveryOutcome>
  finalizeCancellations(limit: number): Promise<AgentRecoveryOutcome>
  recoverExpiredLeases(limit: number): Promise<AgentRecoveryOutcome>
  reconcileMediaJobs(limit: number): Promise<AgentRecoveryOutcome>
  settleAbandonedMedia(limit: number): Promise<AgentRecoveryOutcome>
  outboxBacklog(): Promise<AgentOutboxBacklog>
}

export interface AgentCoordinatorHealth {
  scheduleProgress(): void
}

export interface AgentCoordinatorLogger {
  info(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export interface AgentCoordinatorSummary {
  sweeps: number
  processed: number
  failures: number
}

export const AGENT_RECOVERY_DEFAULT_BATCH_SIZE = 50
export const AGENT_RECOVERY_DEFAULT_INTERVAL_MS = 5000

function boundedInteger(raw: string | number | undefined, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'string' ? (raw.trim() === '' ? Number.NaN : Number(raw)) : raw
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

export function agentRecoveryBatchSize(raw: string | number | undefined = process.env.AGENT_RECOVERY_BATCH_SIZE): number {
  return boundedInteger(raw, AGENT_RECOVERY_DEFAULT_BATCH_SIZE, 1, 500)
}

export function agentRecoveryIntervalMs(raw: string | number | undefined = process.env.AGENT_RECOVERY_INTERVAL_MS): number {
  return boundedInteger(raw, AGENT_RECOVERY_DEFAULT_INTERVAL_MS, 1000, 60_000)
}

const defaultLogger: AgentCoordinatorLogger = {
  info(event, fields) { if (fields === undefined) console.log(event); else console.log(event, fields) },
  error(event, fields) { if (fields === undefined) console.error(event); else console.error(event, fields) },
}

/** Error names are safe class identities; never log messages or stacks that may contain SQL values. */
function errorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'ERROR'
}

/**
 * Drain one bounded slice of each recovery class, then report outbox pressure.
 * Every sweep is isolated: a failure in one class must not delay the others or
 * reject the coordinator tick. The port is the only database boundary.
 */
export async function runAgentCoordinator(
  port: AgentCoordinatorPort,
  options: {
    batchSize?: number
    logger?: AgentCoordinatorLogger
    backlog?: { pendingWarn: number; ageWarnMs: number; quarantinedWarn: number }
  } = {},
): Promise<AgentCoordinatorSummary> {
  const logger = options.logger ?? defaultLogger
  const batchSize = agentRecoveryBatchSize(options.batchSize ?? process.env.AGENT_RECOVERY_BATCH_SIZE)
  const sweeps: ReadonlyArray<{ kind: AgentRecoveryKind | 'abandoned-media'; run: () => Promise<AgentRecoveryOutcome> }> = [
    { kind: 'deadline', run: () => port.expireDeadlines(batchSize) },
    { kind: 'approval', run: () => port.expireApprovals(batchSize) },
    { kind: 'cancel', run: () => port.finalizeCancellations(batchSize) },
    { kind: 'lease', run: () => port.recoverExpiredLeases(batchSize) },
    { kind: 'media', run: () => port.reconcileMediaJobs(batchSize) },
    { kind: 'abandoned-media', run: () => port.settleAbandonedMedia(batchSize) },
  ]
  const pendingWarn = options.backlog?.pendingWarn ?? 1000
  const ageWarnMs = options.backlog?.ageWarnMs ?? 300_000
  const quarantinedWarn = options.backlog?.quarantinedWarn ?? 0
  let processed = 0
  let failures = 0

  for (const sweep of sweeps) {
    let outcome: AgentRecoveryOutcome
    try {
      outcome = await sweep.run()
    } catch (error) {
      failures += 1
      logger.error('agent coordinator sweep failed', { kind: sweep.kind, code: errorCode(error) })
      continue
    }
    processed += outcome.processed
    if (outcome.processed > 0) {
      logger.info('agent coordinator sweep', {
        kind: outcome.kind,
        processed: outcome.processed,
        remaining: outcome.remaining,
      })
    }
  }

  let backlog: AgentOutboxBacklog
  try {
    backlog = await port.outboxBacklog()
  } catch (error) {
    failures += 1
    logger.error('agent coordinator backlog failed', { kind: 'outbox', code: errorCode(error) })
    return { sweeps: sweeps.length, processed, failures }
  }
  if (backlog.pending > pendingWarn
    || (backlog.oldestAgeMs !== null && backlog.oldestAgeMs > ageWarnMs)
    || backlog.quarantined > quarantinedWarn) {
    logger.info('agent coordinator backlog warning', {
      pending: backlog.pending,
      oldestAgeMs: backlog.oldestAgeMs,
      quarantined: backlog.quarantined,
      pendingWarn,
      ageWarnMs,
      quarantinedWarn,
    })
  }

  return { sweeps: sweeps.length, processed, failures }
}

/**
 * Supervise one coordinator tick. A rejected tick is logged here instead of
 * escaping the unawaited initial run or the setInterval callback, and progress
 * is reported only after a clean tick, so a wedged coordinator stops refreshing
 * readiness and eventually trips the worker stall check.
 */
export async function runCoordinatorTick(
  tick: { run(): Promise<void> },
  health: AgentCoordinatorHealth,
  logger: AgentCoordinatorLogger = defaultLogger,
): Promise<void> {
  try {
    await tick.run()
    health.scheduleProgress()
  } catch (error) {
    logger.error('agent coordinator failed', { code: errorCode(error) })
  }
}
