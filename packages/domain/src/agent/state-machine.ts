import type { AgentApprovalStatus, AgentBudgetDTO, AgentDecimal, AgentEstimatedCost, AgentToolCallStatus, AgentTurnStatus, JobStatus } from '@musecanvas/contracts'

const transitions: Readonly<Record<AgentTurnStatus, readonly AgentTurnStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['waiting_tools', 'waiting_approval', 'completed', 'failed', 'cancelled'],
  waiting_tools: ['queued', 'cancelled'],
  waiting_approval: ['queued', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

export function canTransitionAgentTurn(from: AgentTurnStatus, to: AgentTurnStatus): boolean {
  return transitions[from].includes(to)
}
export function isTerminalAgentTurn(status: AgentTurnStatus): boolean {
  return transitions[status].length === 0
}
export function isTerminalAgentToolCall(status: AgentToolCallStatus): boolean {
  return ['completed', 'failed', 'cancelled', 'skipped'].includes(status)
}
export function areAgentMediaDependenciesTerminal(statuses: readonly JobStatus[]): boolean {
  return statuses.length > 0 && statuses.every(status => ['succeeded', 'failed', 'canceled'].includes(status))
}
export interface AgentToolGate {
  status: AgentToolCallStatus
  finalResultRecorded: boolean
  approvalStatus?: AgentApprovalStatus
}
/** All rounds must be supplied, including rejected/expired approvals awaiting error results. */
export function canResumeAgentTurn(status: AgentTurnStatus, cancelRequested: boolean, tools: readonly AgentToolGate[]): boolean {
  return (status === 'waiting_tools' || status === 'waiting_approval') && !cancelRequested && tools.length > 0
    && tools.every(tool => isTerminalAgentToolCall(tool.status) && tool.finalResultRecorded && tool.approvalStatus !== 'pending')
}

/** A cancellation request is intent; local handoff must finish before terminal settlement. */
export function shouldSettleAgentCancellation(status: AgentTurnStatus, cancelRequested: boolean, ownsCurrentFence: boolean, localHandoffComplete: boolean): boolean {
  return cancelRequested && ownsCurrentFence && localHandoffComplete && !isTerminalAgentTurn(status)
}

export interface AgentBudgetUsage {
  modelCalls: number
  toolCalls: number
  mediaJobs: number
  mediaOutputs: number
  inputTokens: bigint
  outputTokens: bigint
  concurrentMediaJobs: number
  /** null is an explicit unknown estimate, never zero. */
  estimatedCost: AgentEstimatedCost | null
}

function validUsage(usage: AgentBudgetUsage): boolean {
  return [usage.modelCalls, usage.toolCalls, usage.mediaJobs, usage.mediaOutputs, usage.concurrentMediaJobs]
    .every(value => Number.isSafeInteger(value) && value >= 0)
    && usage.inputTokens >= 0n && usage.outputTokens >= 0n
}

/** Parse exactly to nano-units; never round a monetary amount through Number. */
function decimalUnits(amount: string): bigint | null {
  if (!/^(0|[1-9]\d{0,20})(?:\.\d{1,9})?$/.test(amount)) return null
  const [whole, fraction = ''] = amount.split('.')
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'))
}
function tokenLimit(value: AgentDecimal): bigint | null {
  return /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : null
}
function validCost(cost: AgentEstimatedCost): boolean {
  return cost.currency.length > 0 && cost.pricingReference.length > 0 && decimalUnits(cost.amount) !== null
}

export function isAgentBudgetDeadlineExceeded(deadlineAt: string, nowMs: number): boolean {
  const deadline = Date.parse(deadlineAt)
  return !Number.isFinite(nowMs) || !Number.isFinite(deadline) || nowMs >= deadline
}

/** Usage includes outstanding reservations. Callers serialize reserve/settlement in persistence. */
export function canReserveAgentBudget(used: AgentBudgetUsage, reserve: AgentBudgetUsage, limit: AgentBudgetDTO, nowMs: number): boolean {
  const inputLimit = tokenLimit(limit.maxInputTokens)
  const outputLimit = tokenLimit(limit.maxOutputTokens)
  const counters = [
    [used.modelCalls, reserve.modelCalls, limit.maxModelCalls],
    [used.toolCalls, reserve.toolCalls, limit.maxToolCalls],
    [used.mediaJobs, reserve.mediaJobs, limit.maxMediaJobs],
    [used.mediaOutputs, reserve.mediaOutputs, limit.maxMediaOutputs],
    [used.concurrentMediaJobs, reserve.concurrentMediaJobs, limit.maxConcurrentMediaJobs],
  ]
  if (!validUsage(used) || !validUsage(reserve) || inputLimit === null || outputLimit === null
      || isAgentBudgetDeadlineExceeded(limit.deadlineAt, nowMs)
      || !counters.every(([current, added, maximum]) => Number.isSafeInteger(maximum) && maximum >= 0 && BigInt(current) + BigInt(added) <= BigInt(maximum))
      || used.inputTokens + reserve.inputTokens > inputLimit || used.outputTokens + reserve.outputTokens > outputLimit) return false
  if (limit.maxEstimatedCost === null) return [used.estimatedCost, reserve.estimatedCost].every(cost => cost === null || validCost(cost))
  const maximum = limit.maxEstimatedCost
  const current = used.estimatedCost
  const added = reserve.estimatedCost
  if (!validCost(maximum) || current === null || added === null || !validCost(current) || !validCost(added)) return false
  if ([current, added].some(cost => cost.currency !== maximum.currency || cost.pricingReference !== maximum.pricingReference)) return false
  return decimalUnits(current.amount)! + decimalUnits(added.amount)! <= decimalUnits(maximum.amount)!
}
