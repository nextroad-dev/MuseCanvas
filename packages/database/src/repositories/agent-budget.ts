import type {
  AgentBudgetDTO, AgentBudgetQuota, AgentBudgetReservationStatus, AgentDecimal, AgentEstimatedCost, JsonObject,
} from '@musecanvas/contracts'
import { AGENT_BUDGET_QUOTAS } from '@musecanvas/contracts'
import { canReserveAgentBudget, type AgentBudgetUsage } from '@musecanvas/domain'
import type { AgentCoreClient, AgentCoreTransaction } from './agent-core'

export type AgentBudgetErrorCode = 'BUDGET_EXCEEDED' | 'CONFLICT' | 'INVALID_INPUT' | 'NOT_FOUND' | 'UNAVAILABLE'

/** AgentCoreError deliberately has no budget error codes. Keep this slice's
 * domain errors local until the core error union is extended centrally. */
export class AgentBudgetError extends Error {
  constructor(readonly code: AgentBudgetErrorCode) { super(code) }
}

export interface AgentBudgetReserveInput {
  ownerId: string
  sessionId: string
  turnId: string
  quota: AgentBudgetQuota
  amount: string
  currency?: string | null
  pricingRevision?: string | null
  toolCallId?: string | null
  roundId?: string | null
  idempotencyKey: string
}
export interface AgentBudgetReservationDTO {
  id: string
  quota: AgentBudgetQuota
  /** numeric(30,9) decimal; cost reservations may be fractional. */
  amount: string
  status: AgentBudgetReservationStatus
  currency: string | null
  pricingRevision: string | null
  createdAt: string
}
export interface AgentBudgetSettleInput {
  ownerId: string
  sessionId: string
  turnId: string
  reservationId: string
  actualAmount: string
  usageKind: 'actual' | 'estimated' | 'unknown'
  settlementKey: string
  details?: JsonObject
}
export interface AgentBudgetReleaseInput {
  ownerId: string
  sessionId: string
  turnId: string
  reservationId: string
}
export interface AgentBudgetUsageInput { ownerId: string; sessionId: string; turnId: string }

interface Scope { ownerId: string; sessionId: string; turnId: string }
interface TurnRow {
  id: string
  session_id: string
  status: string
  engine_version: string
  budget_snapshot: unknown
  deadline_at: unknown
  cancel_requested_at: unknown
}
interface ReservationRow {
  id: string
  session_id: string
  turn_id: string
  quota: string
  reserved_amount: string
  currency: string | null
  pricing_revision: string | null
  status: string
  idempotency_key: string
  created_at: unknown
  settled_at: unknown
}
interface UsageRow {
  reservation_id: string | null
  settlement_key: string
  usage_kind: string
  amount: string
  currency: string | null
  details: Record<string, unknown>
}
interface AggregateRow {
  unknown_cost?: boolean
  quota: string | null
  amount: string
  currency: string | null
  currency_max: string | null
  pricing_revision: string | null
  pricing_revision_max: string | null
}
interface CostAggregate { amount: string; currency: string; pricingReference: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AMOUNT = /^(0|[1-9][0-9]{0,20})(\.[0-9]{1,9})?$/
const TOKEN = /^(0|[1-9][0-9]*)$/
const CURRENCY = /^[A-Z]{3}$/
const QUOTAS = AGENT_BUDGET_QUOTAS as readonly string[]
const NANO = 1_000_000_000n

function fail(code: AgentBudgetErrorCode): never { throw new AgentBudgetError(code) }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) return fail('INVALID_INPUT')
  return value
}
function optionalUuid(value: unknown): string | null {
  if (value == null) return null
  return uuid(value)
}
function key(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.includes('\0')) return fail('INVALID_INPUT')
  return value
}
function quota(value: unknown): AgentBudgetQuota {
  if (typeof value !== 'string' || !QUOTAS.includes(value)) return fail('INVALID_INPUT')
  return value as AgentBudgetQuota
}
function canonicalAmount(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = AMOUNT.exec(value)
  if (!match) return null
  const fraction = (match[2] ?? '').slice(1).replace(/0+$/, '')
  return fraction ? `${match[1]}.${fraction}` : match[1]!
}
function inputAmount(value: unknown): string {
  const result = canonicalAmount(value)
  return result ?? fail('INVALID_INPUT')
}
function dbAmount(value: unknown): string {
  const result = canonicalAmount(value)
  return result ?? fail('UNAVAILABLE')
}
function dbInteger(value: unknown): string {
  const result = dbAmount(value)
  if (result.includes('.')) return fail('UNAVAILABLE')
  return result
}
function units(value: string): bigint {
  const canonical = canonicalAmount(value)
  if (!canonical || canonical.split('.')[0]!.length > 21) return fail('UNAVAILABLE')
  const [whole, fraction = ''] = canonical.split('.')
  return BigInt(whole!) * NANO + BigInt(fraction.padEnd(9, '0'))
}
function amountFromUnits(value: bigint): string {
  if (value < 0n) return fail('UNAVAILABLE')
  const whole = value / NANO
  if (whole.toString().length > 21) return fail('UNAVAILABLE')
  const fraction = (value % NANO).toString().padStart(9, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}
function addAmount(left: string, right: string): string { return amountFromUnits(units(left) + units(right)) }
function addCount(current: number, value: string): number {
  const next = current + Number(dbInteger(value))
  if (!Number.isSafeInteger(next) || next < 0) return fail('UNAVAILABLE')
  return next
}
function addTokens(current: bigint, value: string): bigint {
  return current + BigInt(dbInteger(value))
}
function oneAggregateValue(left: string | null, right: string | null): string {
  if (left == null || right == null || left !== right) return fail('UNAVAILABLE')
  return left
}
function iso(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
  if (!date || !Number.isFinite(date.getTime())) return fail('UNAVAILABLE')
  return date.toISOString()
}

function scope(input: Scope): Scope {
  return { ownerId: uuid(input.ownerId), sessionId: uuid(input.sessionId), turnId: uuid(input.turnId) }
}
function reserveInput(input: AgentBudgetReserveInput) {
  const normalized = { ...scope(input), quota: quota(input.quota), amount: inputAmount(input.amount),
    toolCallId: optionalUuid(input.toolCallId), roundId: optionalUuid(input.roundId), idempotencyKey: key(input.idempotencyKey),
    currency: null as string | null, pricingRevision: null as string | null }
  if (normalized.quota === 'estimated_cost') {
    if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) return fail('INVALID_INPUT')
    if (typeof input.pricingRevision !== 'string' || input.pricingRevision.length < 1
        || input.pricingRevision.includes('\0')) return fail('INVALID_INPUT')
    normalized.currency = input.currency
    normalized.pricingRevision = input.pricingRevision
  } else {
    if (input.currency != null || input.pricingRevision != null || normalized.amount.includes('.')) return fail('INVALID_INPUT')
  }
  return normalized
}
function settleInput(input: AgentBudgetSettleInput) {
  const details = input.details
  if (details !== undefined && !isRecord(details)) return fail('INVALID_INPUT')
  if (input.usageKind !== 'actual' && input.usageKind !== 'estimated' && input.usageKind !== 'unknown') return fail('INVALID_INPUT')
  return { ...scope(input), reservationId: uuid(input.reservationId), amount: inputAmount(input.actualAmount),
    usageKind: input.usageKind, settlementKey: key(input.settlementKey), details: details ?? {} }
}
function releaseInput(input: AgentBudgetReleaseInput) {
  return { ...scope(input), reservationId: uuid(input.reservationId) }
}
function budgetDTO(snapshot: unknown, deadlineAt: unknown): AgentBudgetDTO {
  if (!isRecord(snapshot)) return fail('UNAVAILABLE')
  const counter = (name: string): number => {
    const value = snapshot[name]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail('UNAVAILABLE')
    return value
  }
  const tokens = (name: string): AgentDecimal => {
    const value = snapshot[name]
    if (typeof value !== 'string' || !TOKEN.test(value)) return fail('UNAVAILABLE')
    try { BigInt(value) } catch { return fail('UNAVAILABLE') }
    return value as AgentDecimal
  }
  let maxEstimatedCost: AgentEstimatedCost | null = null
  if (snapshot.maxEstimatedCost !== null) {
    const cost = snapshot.maxEstimatedCost
    if (!isRecord(cost) || typeof cost.currency !== 'string' || !CURRENCY.test(cost.currency)
        || typeof cost.amount !== 'string' || typeof cost.pricingReference !== 'string'
        || cost.pricingReference.length < 1 || cost.pricingReference.includes('\0')) {
      return fail('UNAVAILABLE')
    }
    const amount = canonicalAmount(cost.amount)
    if (!amount) return fail('UNAVAILABLE')
    maxEstimatedCost = { currency: cost.currency, amount, pricingReference: cost.pricingReference }
  }
  return {
    maxModelCalls: counter('maxModelCalls'), maxToolCalls: counter('maxToolCalls'),
    maxMediaJobs: counter('maxMediaJobs'), maxMediaOutputs: counter('maxMediaOutputs'),
    maxInputTokens: tokens('maxInputTokens'), maxOutputTokens: tokens('maxOutputTokens'),
    maxEstimatedCost, maxConcurrentMediaJobs: counter('maxConcurrentMediaJobs'), deadlineAt: iso(deadlineAt),
  }
}
function reservationDTO(row: ReservationRow): AgentBudgetReservationDTO {
  const rowQuota = quotaOrUnavailable(row.quota)
  const status = row.status
  if (status !== 'reserved' && status !== 'settled' && status !== 'released' && status !== 'unknown') return fail('UNAVAILABLE')
  const cost = rowQuota === 'estimated_cost'
  if (cost) {
    if (row.currency == null || !CURRENCY.test(row.currency) || row.pricing_revision == null
        || row.pricing_revision.length < 1 || row.pricing_revision.includes('\0')) return fail('UNAVAILABLE')
  } else if (row.currency != null || row.pricing_revision != null) {
    return fail('UNAVAILABLE')
  }
  return { id: row.id, quota: rowQuota, amount: dbAmount(row.reserved_amount), status,
    currency: row.currency, pricingRevision: row.pricing_revision, createdAt: iso(row.created_at) }
}
function quotaOrUnavailable(value: string): AgentBudgetQuota {
  if (!QUOTAS.includes(value)) return fail('UNAVAILABLE')
  return value as AgentBudgetQuota
}
function emptyUsage(): AgentBudgetUsage {
  return { modelCalls: 0, toolCalls: 0, mediaJobs: 0, mediaOutputs: 0, inputTokens: 0n, outputTokens: 0n,
    concurrentMediaJobs: 0, estimatedCost: null }
}
function reserveUsage(value: ReturnType<typeof reserveInput>, limit: AgentBudgetDTO): AgentBudgetUsage {
  const usage = emptyUsage()
  // The pure rule requires both sides of a finite cost ceiling. A non-cost
  // reservation still contributes a zero cost in the limit's denomination.
  if (limit.maxEstimatedCost) {
    usage.estimatedCost = { amount: '0', currency: limit.maxEstimatedCost.currency,
      pricingReference: limit.maxEstimatedCost.pricingReference }
  }
  switch (value.quota) {
    case 'model_calls': usage.modelCalls = addCount(0, value.amount); break
    case 'tool_calls': usage.toolCalls = addCount(0, value.amount); break
    case 'media_jobs': usage.mediaJobs = addCount(0, value.amount); break
    case 'media_outputs': usage.mediaOutputs = addCount(0, value.amount); break
    case 'input_tokens': usage.inputTokens = addTokens(0n, value.amount); break
    case 'output_tokens': usage.outputTokens = addTokens(0n, value.amount); break
    case 'estimated_cost':
      usage.estimatedCost = { amount: value.amount, currency: value.currency!, pricingReference: value.pricingRevision! }
      break
    case 'concurrent_media_jobs': usage.concurrentMediaJobs = addCount(0, value.amount); break
  }
  return usage
}

/**
 * Database-only execution-budget ledger. The transaction owns BEGIN/COMMIT/
 * ROLLBACK; this repository never opens a transaction or performs network I/O
 * while holding a lock. Reservations are authoritative in PostgreSQL, never
 * Redis. Callers must pass an owner-scoped Session and Turn.
 */
export class AgentBudgetRepository {
  constructor(private readonly tx: AgentCoreTransaction) {}

  reserve(input: AgentBudgetReserveInput): Promise<AgentBudgetReservationDTO> {
    const value = reserveInput(input)
    return this.tx(async c => {
      const turn = await this.lockTurn(c, value)
      const existing = (await c.query<ReservationRow>(`SELECT * FROM agent_budget_reservations
        WHERE turn_id=$1 AND idempotency_key=$2`, [value.turnId, value.idempotencyKey])).rows[0]
      if (existing) {
        const replay = reservationDTO(existing)
        if (replay.quota !== value.quota || replay.amount !== value.amount || replay.currency !== value.currency
            || replay.pricingRevision !== value.pricingRevision) return fail('CONFLICT')
        return replay
      }
      const limit = budgetDTO(turn.budget_snapshot, turn.deadline_at)
      const used = await this.currentUsage(c, value, limit)
      if (!canReserveAgentBudget(used, reserveUsage(value, limit), limit, Date.now())) return fail('BUDGET_EXCEEDED')
      const row = (await c.query<ReservationRow>(`INSERT INTO agent_budget_reservations
        (session_id,turn_id,tool_call_id,round_id,quota,reserved_amount,currency,pricing_revision,status,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9) RETURNING *`,
      [value.sessionId, value.turnId, value.toolCallId, value.roundId, value.quota, value.amount,
        value.currency, value.pricingRevision, value.idempotencyKey])).rows[0]
      if (!row) return fail('UNAVAILABLE')
      return reservationDTO(row)
    })
  }

  settle(input: AgentBudgetSettleInput): Promise<AgentBudgetReservationDTO> {
    const value = settleInput(input)
    return this.tx(async c => {
      const row = await this.lockReservation(c, value)
      const current = reservationDTO(row)
      if (current.status === 'settled') {
        await this.replaySettlement(c, value, row, value.amount)
        return current
      }
      if (current.status !== 'reserved') return fail('CONFLICT')
      if (current.quota !== 'estimated_cost' && value.amount.includes('.')) return fail('INVALID_INPUT')
      const details = { ...value.details, quota: current.quota }
      const inserted = (await c.query<{ id: string }>(`INSERT INTO agent_usage_entries
        (session_id,turn_id,reservation_id,settlement_key,usage_kind,amount,currency,details)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        ON CONFLICT(turn_id,settlement_key) DO NOTHING RETURNING id`,
      [value.sessionId, value.turnId, row.id, value.settlementKey, value.usageKind, value.amount, row.currency,
        JSON.stringify(details)])).rows[0]
      if (!inserted) await this.replaySettlement(c, value, row, value.amount)
      const updated = (await c.query<ReservationRow>(`UPDATE agent_budget_reservations
        SET status='settled',settled_at=clock_timestamp()
        WHERE id=$1 AND session_id=$2 AND turn_id=$3 AND status='reserved' RETURNING *`,
      [row.id, value.sessionId, value.turnId])).rows[0]
      if (!updated) return fail('CONFLICT')
      return reservationDTO(updated)
    })
  }

  release(input: AgentBudgetReleaseInput): Promise<AgentBudgetReservationDTO> {
    const value = releaseInput(input)
    return this.tx(async c => {
      const row = await this.lockReservation(c, value)
      const current = reservationDTO(row)
      if (current.status === 'released') return current
      if (current.status !== 'reserved') return fail('CONFLICT')
      const updated = (await c.query<ReservationRow>(`UPDATE agent_budget_reservations
        SET status='released',settled_at=clock_timestamp()
        WHERE id=$1 AND session_id=$2 AND turn_id=$3 AND status='reserved' RETURNING *`,
      [row.id, value.sessionId, value.turnId])).rows[0]
      if (!updated) return fail('CONFLICT')
      return reservationDTO(updated)
    })
  }

  usage(input: AgentBudgetUsageInput): Promise<AgentBudgetUsage> {
    const value = scope(input)
    return this.tx(async c => {
      const turn = (await c.query<TurnRow>(`SELECT t.* FROM agent_turns t JOIN agent_sessions s ON s.id=t.session_id
        WHERE s.owner_id=$1 AND s.id=$2 AND t.id=$3`, [value.ownerId, value.sessionId, value.turnId])).rows[0]
      if (!turn) return fail('NOT_FOUND')
      return this.currentUsage(c, value, budgetDTO(turn.budget_snapshot, turn.deadline_at))
    }, true)
  }

  private async lockTurn(c: AgentCoreClient, value: Scope): Promise<TurnRow> {
    const turn = (await c.query<TurnRow>(`SELECT t.* FROM agent_turns t JOIN agent_sessions s ON s.id=t.session_id
      WHERE s.owner_id=$1 AND s.id=$2 AND t.id=$3 AND t.engine_version='agent-core-v1'
        AND t.status NOT IN ('completed','failed','cancelled') AND t.cancel_requested_at IS NULL
        AND t.deadline_at > clock_timestamp() FOR UPDATE OF t`,
    [value.ownerId, value.sessionId, value.turnId])).rows[0]
    if (!turn) return fail('NOT_FOUND')
    return turn
  }

  private async lockReservation(c: AgentCoreClient, value: Scope & { reservationId: string }): Promise<ReservationRow> {
    const row = (await c.query<ReservationRow>(`SELECT r.* FROM agent_budget_reservations r
      JOIN agent_sessions s ON s.id=r.session_id
      WHERE s.owner_id=$1 AND r.session_id=$2 AND r.turn_id=$3 AND r.id=$4 FOR UPDATE OF r`,
    [value.ownerId, value.sessionId, value.turnId, value.reservationId])).rows[0]
    if (!row) return fail('NOT_FOUND')
    return row
  }

  private async replaySettlement(c: AgentCoreClient, value: ReturnType<typeof settleInput>, row: ReservationRow, amount: string): Promise<void> {
    const existing = (await c.query<UsageRow>(`SELECT * FROM agent_usage_entries
      WHERE turn_id=$1 AND settlement_key=$2`, [value.turnId, value.settlementKey])).rows[0]
    if (!existing || existing.reservation_id !== row.id || dbAmount(existing.amount) !== amount) return fail('CONFLICT')
  }

  private async currentUsage(c: AgentCoreClient, value: Scope, limit: AgentBudgetDTO): Promise<AgentBudgetUsage> {
    const reserved = (await c.query<AggregateRow>(`SELECT quota,SUM(reserved_amount)::text AS amount,
      MIN(currency) AS currency,MAX(currency) AS currency_max,
      MIN(pricing_revision) AS pricing_revision,MAX(pricing_revision) AS pricing_revision_max
      FROM agent_budget_reservations
      WHERE session_id=$1 AND turn_id=$2 AND status='reserved' GROUP BY quota`,
    [value.sessionId, value.turnId])).rows
    // Usage entries are attributed only through details.quota; settlement
    // injects it so rows without attribution fail closed above.
    const entries = (await c.query<AggregateRow>(`SELECT u.details->>'quota' AS quota,SUM(u.amount)::text AS amount,
      BOOL_OR(u.usage_kind='unknown' OR u.details->>'unknownCost'='true') AS unknown_cost,
      MIN(COALESCE(u.currency,r.currency)) AS currency,MAX(COALESCE(u.currency,r.currency)) AS currency_max,
      MIN(r.pricing_revision) AS pricing_revision,MAX(r.pricing_revision) AS pricing_revision_max
      FROM agent_usage_entries u
      LEFT JOIN agent_budget_reservations r
        ON r.id=u.reservation_id AND r.turn_id=u.turn_id AND r.session_id=u.session_id
      WHERE u.session_id=$1 AND u.turn_id=$2 GROUP BY u.details->>'quota'`,
    [value.sessionId, value.turnId])).rows
    const usage = emptyUsage()
    const maximum = limit.maxEstimatedCost
    let cost: CostAggregate | null = null
    let unknownCost = false
    for (const row of [...reserved, ...entries]) {
      if (typeof row.quota !== 'string' || !QUOTAS.includes(row.quota)) return fail('UNAVAILABLE')
      const amount = dbAmount(row.amount)
      switch (row.quota as AgentBudgetQuota) {
        case 'model_calls': usage.modelCalls = addCount(usage.modelCalls, amount); break
        case 'tool_calls': usage.toolCalls = addCount(usage.toolCalls, amount); break
        case 'media_jobs': usage.mediaJobs = addCount(usage.mediaJobs, amount); break
        case 'media_outputs': usage.mediaOutputs = addCount(usage.mediaOutputs, amount); break
        case 'input_tokens': usage.inputTokens = addTokens(usage.inputTokens, amount); break
        case 'output_tokens': usage.outputTokens = addTokens(usage.outputTokens, amount); break
        case 'concurrent_media_jobs': usage.concurrentMediaJobs = addCount(usage.concurrentMediaJobs, amount); break
        case 'estimated_cost': {
          if (row.unknown_cost) { unknownCost=true; break }
          // Missing per-entry metadata inherits the ceiling's denomination;
          // any present metadata must agree across outstanding/settled rows.
          const currency = row.currency == null && row.currency_max == null
            ? maximum?.currency : oneAggregateValue(row.currency, row.currency_max)
          const pricingReference = row.pricing_revision == null && row.pricing_revision_max == null
            ? maximum?.pricingReference : oneAggregateValue(row.pricing_revision, row.pricing_revision_max)
          if (currency == null || !CURRENCY.test(currency) || pricingReference == null
              || pricingReference.length < 1 || pricingReference.includes('\0')) return fail('UNAVAILABLE')
          if (!cost) cost = { amount, currency, pricingReference }
          else if (cost.currency !== currency || cost.pricingReference !== pricingReference) return fail('UNAVAILABLE')
          else cost.amount = addAmount(cost.amount, amount)
          break
        }
      }
    }
    if (maximum && !unknownCost) {
      if (cost && (cost.currency !== maximum.currency || cost.pricingReference !== maximum.pricingReference)) {
        return fail('UNAVAILABLE')
      }
      usage.estimatedCost = cost
        ? { amount: cost.amount, currency: maximum.currency, pricingReference: maximum.pricingReference }
        : { amount: '0', currency: maximum.currency, pricingReference: maximum.pricingReference }
    }
    if (unknownCost) usage.estimatedCost=null
    else if (!maximum && cost) usage.estimatedCost={...cost}
    return usage
  }
}
