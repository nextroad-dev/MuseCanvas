import type { AgentBudgetDTO, AgentBudgetQuota, AgentDecimal, AgentEstimatedCost, AgentUsageKind, JsonObject } from '@musecanvas/contracts'
import type { AgentCoreClient } from './agent-core'
import type { AgentTurnScope } from './agent-runtime'
import { canonicalJsonDigest } from '../canonical-json-digest'

export interface AgentExecutionBudgetUsage { modelCalls: number; toolCalls: number; mediaJobs: number; mediaOutputs: number; inputTokens: bigint; outputTokens: bigint; concurrentMediaJobs: number; estimatedCost: AgentEstimatedCost | null }
export interface AgentExecutionBudgetReserveInput { quota: AgentBudgetQuota; amount: AgentDecimal; currency?: string; pricingRevision?: string; idempotencyKey: string }
export interface AgentExecutionBudgetReservation { id: string; quota: AgentBudgetQuota; amount: AgentDecimal; currency: string | null; pricingRevision: string | null }
export interface AgentExecutionBudgetRepository {
  reserveBudget(client: AgentCoreClient, input: { scope: AgentTurnScope; roundId?: string; toolCallId?: string; reserve: AgentExecutionBudgetReserveInput; limit: AgentBudgetDTO; nowMs: number }): Promise<AgentExecutionBudgetReservation>
  settleBudget(client: AgentCoreClient, input: { scope: AgentTurnScope; reservationId: string; outcome: 'settled' | 'released' | 'unknown'; usage?: { kind: AgentUsageKind; amount: AgentDecimal; currency: string | null; details: JsonObject } }): Promise<void>
  readBudgetUsage(client: AgentCoreClient, scope: AgentTurnScope): Promise<AgentExecutionBudgetUsage>
}
const args = (scope: AgentTurnScope) => [scope.sessionId, scope.turnId]
export class AgentExecutionBudgetError extends Error { constructor(readonly code: 'BUDGET_EXCEEDED' | 'INVALID_BUDGET' | 'BUDGET_CONFLICT') { super(code) } }
const fail = (code: AgentExecutionBudgetError['code']): never => { throw new AgentExecutionBudgetError(code) }
/** Exact numeric(30,9) arithmetic. No accounting passes through a floating point value. */
export function agentBudgetUnits(amount: string): bigint {
  if (!/^(0|[1-9]\d{0,20})(?:\.\d{1,9})?$/.test(amount)) return fail('INVALID_BUDGET')
  const [whole, fraction = ''] = amount.split('.')
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9,'0'))
}
const decimalAmount = (units: bigint) => `${units / 1_000_000_000n}.${(units % 1_000_000_000n).toString().padStart(9,'0')}`
const integer = (amount: string) => { const units = agentBudgetUnits(amount); if (units % 1_000_000_000n) return fail('INVALID_BUDGET'); return units / 1_000_000_000n }
interface Entry { id: string | null; quota: AgentBudgetQuota; amount: string; currency: string | null; pricing_revision: string | null; status: string; tool_call_id: string | null; round_id: string | null; actual: string | null; usage_kind: string | null; unknown_cost: boolean; unknown_usage: boolean }
/** Caller serializes with actor -> session -> turn locks; no network or transaction control here. */
async function entries(client: AgentCoreClient, scope: AgentTurnScope): Promise<Entry[]> {
  return (await client.query<Entry>(`WITH usage AS (
    SELECT reservation_id,SUM(amount)::text AS amount,MIN(currency) AS currency,MIN(usage_kind) AS usage_kind,
      BOOL_OR(usage_kind='unknown' OR details->>'unknownCost'='true') AS unknown_cost,BOOL_OR(usage_kind='unknown') AS unknown_usage
    FROM agent_usage_entries WHERE session_id=$1 AND turn_id=$2 AND reservation_id IS NOT NULL GROUP BY reservation_id
  )
  SELECT b.id,b.quota,b.reserved_amount::text AS amount,b.currency,b.pricing_revision,b.status,b.tool_call_id,b.round_id,
    u.amount AS actual,u.usage_kind,COALESCE(u.unknown_cost,false) AS unknown_cost,COALESCE(u.unknown_usage,false) AS unknown_usage
  FROM agent_budget_reservations b LEFT JOIN usage u ON u.reservation_id=b.id
  WHERE b.session_id=$1 AND b.turn_id=$2
  UNION ALL
  SELECT NULL,details->>'quota',amount::text,currency,NULL,'settled',NULL,NULL,amount::text,usage_kind,
    (usage_kind='unknown' OR details->>'unknownCost'='true') AS unknown_cost,(usage_kind='unknown') AS unknown_usage
  FROM agent_usage_entries WHERE session_id=$1 AND turn_id=$2 AND reservation_id IS NULL
  ORDER BY id NULLS LAST`, args(scope))).rows
}
function effective(entry: Entry) {
  if (entry.status === 'released' || (entry.quota === 'concurrent_media_jobs' && entry.status === 'settled')) return 0n
  const reserved=agentBudgetUnits(entry.amount)
  const reported=entry.actual===null ? reserved : agentBudgetUnits(entry.actual)
  if (entry.status === 'settled' && entry.actual !== null && !entry.unknown_usage) return reported
  return reported > reserved ? reported : reserved
}
function maximum(quota: AgentBudgetQuota, limit: AgentBudgetDTO): string {
  const number = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) return fail('INVALID_BUDGET'); return String(value) }
  switch (quota) {
    case 'model_calls': return number(limit.maxModelCalls)
    case 'tool_calls': return number(limit.maxToolCalls)
    case 'media_jobs': return number(limit.maxMediaJobs)
    case 'media_outputs': return number(limit.maxMediaOutputs)
    case 'concurrent_media_jobs': return number(limit.maxConcurrentMediaJobs)
    case 'input_tokens': return limit.maxInputTokens
    case 'output_tokens': return limit.maxOutputTokens
    case 'estimated_cost': return limit.maxEstimatedCost?.amount ?? fail('INVALID_BUDGET')
  }
}
export function createAgentExecutionBudgetRepository(): AgentExecutionBudgetRepository {
  return {
    async reserveBudget(client, input) {
      const request = input.reserve
      if (!request.idempotencyKey || request.idempotencyKey.length > 512) return fail('INVALID_BUDGET')
      const amount = agentBudgetUnits(request.amount)
      if (request.quota !== 'estimated_cost' && amount % 1_000_000_000n) return fail('INVALID_BUDGET')
      const existing = (await client.query<Entry & { idempotency_key: string }>(`SELECT *,reserved_amount::text AS amount FROM agent_budget_reservations WHERE session_id=$1 AND turn_id=$2 AND idempotency_key=$3`, [...args(input.scope),request.idempotencyKey])).rows[0]
      if (existing) {
        if (typeof existing.id !== 'string' || existing.quota !== request.quota || agentBudgetUnits(existing.amount) !== amount || existing.currency !== (request.currency ?? null) || existing.pricing_revision !== (request.pricingRevision ?? null) || existing.round_id !== (input.roundId ?? null) || existing.tool_call_id !== (input.toolCallId ?? null)) return fail('BUDGET_CONFLICT')
        return {id:existing.id,quota:existing.quota,amount:request.amount,currency:existing.currency,pricingRevision:existing.pricing_revision}
      }
      const clock = (await client.query<{ live: boolean }>(`SELECT clock_timestamp()<deadline_at AS live FROM agent_turns WHERE session_id=$1 AND id=$2`,args(input.scope))).rows[0]
      if (!clock?.live) return fail('BUDGET_EXCEEDED')
      const all = await entries(client,input.scope)
      if (all.some(entry => entry.status === 'unknown')) return fail('BUDGET_EXCEEDED')
      if (request.quota === 'estimated_cost') {
        if (!request.currency || !/^[A-Z]{3}$/.test(request.currency) || !request.pricingRevision) return fail('INVALID_BUDGET')
        if (input.limit.maxEstimatedCost && (input.limit.maxEstimatedCost.currency !== request.currency || input.limit.maxEstimatedCost.pricingReference !== request.pricingRevision)) return fail('BUDGET_EXCEEDED')
        if (all.some(entry => entry.quota === request.quota && entry.status !== 'released' && (entry.currency !== request.currency || entry.pricing_revision !== request.pricingRevision))) return fail('BUDGET_EXCEEDED')
      } else if (request.currency !== undefined || request.pricingRevision !== undefined) return fail('INVALID_BUDGET')
      const used = all.filter(entry => entry.quota === request.quota).reduce((sum,entry)=>sum+effective(entry),0n)
      if (!(request.quota === 'estimated_cost' && input.limit.maxEstimatedCost === null) && used + amount > agentBudgetUnits(maximum(request.quota,input.limit))) return fail('BUDGET_EXCEEDED')
      const inserted = (await client.query<Entry>(`INSERT INTO agent_budget_reservations(session_id,turn_id,tool_call_id,round_id,quota,reserved_amount,currency,pricing_revision,status,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9) RETURNING id`, [...args(input.scope),input.toolCallId ?? null,input.roundId ?? null,request.quota,request.amount,request.currency ?? null,request.pricingRevision ?? null,request.idempotencyKey])).rows[0]
      if (!inserted || typeof inserted.id !== 'string') return fail('BUDGET_CONFLICT')
      return {id:inserted.id,quota:request.quota,amount:request.amount,currency:request.currency ?? null,pricingRevision:request.pricingRevision ?? null}
    },
    async settleBudget(client,input) {
      const previous = (await client.query<Entry>(`SELECT *,reserved_amount::text AS amount FROM agent_budget_reservations WHERE session_id=$1 AND turn_id=$2 AND id=$3 FOR UPDATE`,[...args(input.scope),input.reservationId])).rows[0]
      if (!previous) return fail('BUDGET_CONFLICT')
      if (input.usage) {
        const actual = agentBudgetUnits(input.usage.amount)
        if (previous.quota !== 'estimated_cost' && actual % 1_000_000_000n) return fail('INVALID_BUDGET')
        if (input.usage.currency !== previous.currency) return fail('BUDGET_CONFLICT')
      }
      if (previous.status !== 'reserved') {
        if (previous.status !== input.outcome) return fail('BUDGET_CONFLICT')
        if (input.usage) {
          const stored=(await client.query<{amount:string;currency:string|null;usage_kind:string;details:JsonObject}>(`SELECT amount::text,currency,usage_kind,details FROM agent_usage_entries WHERE session_id=$1 AND turn_id=$2 AND reservation_id=$3 AND settlement_key=$4`,[...args(input.scope),input.reservationId,`reservation:${input.reservationId}`])).rows[0]
          if (!stored || agentBudgetUnits(stored.amount)!==agentBudgetUnits(input.usage.amount) || stored.currency!==input.usage.currency || stored.usage_kind!==input.usage.kind || canonicalJsonDigest(stored.details)!==canonicalJsonDigest({...input.usage.details,quota:previous.quota})) return fail('BUDGET_CONFLICT')
        }
        return
      }
      if (input.outcome === 'settled' && !input.usage) return fail('INVALID_BUDGET')
      if (input.outcome === 'unknown' && input.usage?.kind !== 'unknown') return fail('INVALID_BUDGET')
      await client.query(`UPDATE agent_budget_reservations SET status=$4,settled_at=clock_timestamp() WHERE session_id=$1 AND turn_id=$2 AND id=$3 AND status='reserved'`,[...args(input.scope),input.reservationId,input.outcome])
      if (input.usage) await client.query(`INSERT INTO agent_usage_entries(session_id,turn_id,reservation_id,settlement_key,usage_kind,amount,currency,details)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(turn_id,settlement_key) DO NOTHING`,[...args(input.scope),input.reservationId,`reservation:${input.reservationId}`,input.usage.kind,input.usage.amount,input.usage.currency,JSON.stringify({...input.usage.details,quota:previous.quota})])
    },
    async readBudgetUsage(client,scope) {
      const all = await entries(client,scope)
      const sum = (quota: AgentBudgetQuota) => all.filter(entry=>entry.quota===quota).reduce((sum,entry)=>sum+effective(entry),0n)
      const count = (quota: AgentBudgetQuota) => { const value = integer(decimalAmount(sum(quota))); if (value > BigInt(Number.MAX_SAFE_INTEGER)) return fail('INVALID_BUDGET'); return Number(value) }
      const costs = all.filter(entry=>entry.quota==='estimated_cost' && entry.status!=='released')
      const known = costs.length>0 && costs.every(entry=>entry.status!=='unknown' && !entry.unknown_cost && !entry.unknown_usage && entry.currency===costs[0].currency && entry.pricing_revision===costs[0].pricing_revision)
      return {modelCalls:count('model_calls'),toolCalls:count('tool_calls'),mediaJobs:count('media_jobs'),mediaOutputs:count('media_outputs'),inputTokens:integer(decimalAmount(sum('input_tokens'))),outputTokens:integer(decimalAmount(sum('output_tokens'))),concurrentMediaJobs:count('concurrent_media_jobs'),estimatedCost:known ? {currency:costs[0].currency!,amount:decimalAmount(sum('estimated_cost')),pricingReference:costs[0].pricing_revision!} : null}
    },
  }
}
