import type { AgentBudgetDTO, AgentDecimal, AgentError, AgentToolCallStatus, AgentTurnDTO, JsonObject, JsonValue, ToolExecutionResult } from '@musecanvas/contracts'
import {
  canonicalJsonDigest, AgentExecutionBudgetError, AgentRuntimeError, agentRoundCheckpoint, expireAgentToolApproval,
  type AgentCoreClient, type AgentCoreTransaction, type AgentExecutionBudgetRepository,
  type AgentExecutionBudgetReservation, type AgentExecutionRepository, type AgentExecutionState, type AgentRoundRepository,
  type AgentTurnLease, type AgentTurnScope,
} from '@musecanvas/database'
import type { LanguageModelChatTool } from '@musecanvas/providers'
import type {
  AgentBudgetReserveInput, AgentContextPort, AgentModelConfig, AgentModelPort, AgentModelResult,
  AgentRunner, AgentRunnerWake, AgentSqlClient, AgentToolContext, AgentToolRegistry,
} from './ports'
import type { AgentToolExecutor } from './tools/executor'

export interface AgentRunnerRuntime {
  claimTurnLease(input: AgentTurnScope & { leaseOwner: string; leaseDurationMs: number }): Promise<AgentTurnLease | null>
  renewTurnLease(input: { ownerId: string; sessionId: string; turnId: string; leaseOwner: string; fencingToken: AgentDecimal; leaseDurationMs: number }): Promise<AgentTurnLease | null>
  releaseTurnLease(input: { ownerId: string; sessionId: string; turnId: string; leaseOwner: string; fencingToken: AgentDecimal }): Promise<boolean>
  withTurnLease<T>(input: AgentRunnerFence, work: (client: AgentCoreClient) => Promise<T>): Promise<T>
  transitionWithTurnLease<T>(input: AgentRunnerFence, transition: { to: 'waiting_tools' | 'waiting_approval' | 'completed' | 'failed'; error?: JsonObject | null }, work: (client: AgentCoreClient) => Promise<T>): Promise<{ work: T; turn: unknown }>
}
export interface AgentRunnerFence extends AgentTurnScope { leaseOwner: string; fencingToken: AgentDecimal; expectedInputRevision: AgentDecimal }

export interface AgentRunnerDependencies {
  readonly runtime: AgentRunnerRuntime
  readonly rounds: AgentRoundRepository
  readonly execution: AgentExecutionRepository
  readonly budget: AgentExecutionBudgetRepository
  readonly registry: AgentToolRegistry
  readonly executor: AgentToolExecutor
  readonly model: AgentModelPort
  readonly context: AgentContextPort
  readonly read: AgentCoreTransaction
  /** Media policy seam. Absence leaves raw media calls failed-closed and approval rows inert. */
  readonly media?: AgentMediaProposalRunnerPort
  readonly now?: () => number
  readonly leaseOwner?: string
  readonly leaseDurationMs?: number
  readonly maxRounds?: number
  readonly signal?: AbortSignal
}

/**
 * Materialized media proposals are a media-owned policy, so the runner only
 * routes durable rows through this injected seam. Every method runs on the
 * caller's fenced transaction; none may begin, commit or roll back.
 */
export interface AgentMediaProposalRunnerPort {
  canMaterialize(toolName: string, toolSchemaVersion: number): boolean
  isCanonical(args: JsonObject): boolean
  readApproval(client: AgentCoreClient, scope: AgentTurnScope, toolCallId: string): Promise<{ id: string; status: 'pending' | 'approved' | 'rejected' | 'expired'; expired: boolean } | null>
  materialize(client: AgentCoreClient, context: {
    scope: AgentTurnScope; round: { roundId: string; position: number }; turn: AgentTurnDTO; signal: AbortSignal
  }, input: { rawToolCallId: string; toolName: string; toolSchemaVersion: number; rawArgs: JsonObject }): Promise<{ toolCallId: string }>
  executeApproved(context: AgentToolContext, toolName: string, toolSchemaVersion: number, args: JsonObject): Promise<ToolExecutionResult>
}

class AgentToolRejected extends Error { constructor(readonly toolError: AgentError) { super('AGENT_TOOL_REJECTED') } }

const offeredToolName = (name: string, version: number) => `${name}__v${version}`
const parseOfferedTool = (name: string): { name: string; version: number } | null => {
  const match = /^([a-z][a-z0-9_.-]{0,99})__v([1-9][0-9]{0,3})$/.exec(name)
  return match ? { name: match[1]!, version: Number(match[2]) } : null
}
const sql = (client: AgentCoreClient): AgentSqlClient => ({ query: (text, params) => client.query(text, params) as unknown as Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> })
const failure = (code: AgentError['code'], message: string): AgentError => ({ code, message, retryable: false })
const isFenceError = (error: unknown) => error instanceof AgentRuntimeError && (error.code === 'LEASE_REJECTED' || error.code === 'TRANSITION_REJECTED')
const remainingMs = (deadlineAt: string, now: number) => Math.max(1, Math.min(120_000, Date.parse(deadlineAt) - now))

function modelConfig(config: JsonObject, deadlineAt: string, now: number): AgentModelConfig | null {
  const string = (name: string) => typeof config[name] === 'string' ? config[name] as string : null
  const number = (name: string) => typeof config[name] === 'number' ? config[name] as number : null
  const protocol = string('protocol')
  if (protocol !== 'openai_chat' && protocol !== 'anthropic_messages') return null
  const ids = {
    modelConfigId: string('modelConfigId'), modelRevisionId: string('modelRevisionId'), modelRevision: string('modelRevision'),
    providerId: string('providerId'), pluginId: string('pluginId'), pluginVersion: string('pluginVersion'), vendorModelId: string('vendorModelId'),
  }
  const maxOutputTokens = number('maxOutputTokens')
  if (!ids.modelConfigId || !ids.modelRevisionId || !ids.modelRevision || !ids.providerId || !ids.pluginId
    || !ids.pluginVersion || !ids.vendorModelId || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens! <= 0) return null
  const temperature = number('temperature')
  const reasoning = typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null
  return { ...ids as Record<keyof typeof ids,string>, protocol, maxOutputTokens: maxOutputTokens!, temperature,
    reasoningEffort: reasoning as AgentModelConfig['reasoningEffort'], timeoutMs: remainingMs(deadlineAt, now) }
}
function budgetLimit(snapshot: AgentBudgetDTO, deadlineAt: string): AgentBudgetDTO {
  return { ...(snapshot as unknown as AgentBudgetDTO), deadlineAt }
}
function usageOf(result: AgentModelResult): { input: number | null; output: number | null } {
  const input = Number.isSafeInteger(result.usage.inputTokens) && (result.usage.inputTokens ?? -1) >= 0 ? result.usage.inputTokens! : null
  const output = Number.isSafeInteger(result.usage.outputTokens) && (result.usage.outputTokens ?? -1) >= 0 ? result.usage.outputTokens! : null
  return { input, output }
}
const estimateTokens = (value: JsonValue) => Math.max(1, Buffer.byteLength(JSON.stringify(value), 'utf8'))

export function createAgentRunner(dependencies: AgentRunnerDependencies): AgentRunner {
  const now = dependencies.now ?? Date.now
  const leaseOwner = dependencies.leaseOwner ?? `agent-runner-${process.pid}`
  const leaseDurationMs = dependencies.leaseDurationMs ?? 30_000
  const maxRounds = dependencies.maxRounds ?? 8
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 100 || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 100 || leaseDurationMs > 120_000) throw new Error('INVALID_AGENT_RUNNER_CONFIG')
  return {
    async runTurn(wake: AgentRunnerWake): Promise<void> {
      const owner = (await dependencies.read(client => client.query(
        `SELECT s.owner_id FROM agent_sessions s JOIN agent_turns t ON t.session_id=s.id WHERE s.id=$1 AND t.id=$2`,
        [wake.sessionId, wake.turnId]))).rows[0]?.owner_id as string | undefined
      if (!owner) return
      const scope: AgentTurnScope = { ownerId: owner, sessionId: wake.sessionId, turnId: wake.turnId }
      const lease = await dependencies.runtime.claimTurnLease({ ...scope, leaseOwner, leaseDurationMs })
      if (!lease) return
      const fence: AgentRunnerFence = { ...scope, leaseOwner: lease.leaseOwner, fencingToken: lease.fencingToken, expectedInputRevision: lease.inputRevision }
      const abort = new AbortController()
      const stop = () => abort.abort()
      dependencies.signal?.addEventListener('abort', stop, { once: true })
      if (dependencies.signal?.aborted) abort.abort()
      let renewing = false
      const heartbeat = setInterval(() => {
        if (renewing || abort.signal.aborted) return
        renewing = true
        void dependencies.runtime.renewTurnLease({ ...fence, leaseDurationMs })
          .then(value => { if (!value) abort.abort() })
          .catch(() => abort.abort())
          .finally(() => { renewing = false })
      }, Math.max(20, Math.floor(leaseDurationMs / 3)))
      const settleRound = async (client: AgentCoreClient, reservations: AgentExecutionBudgetReservation[], usage: ReturnType<typeof usageOf>) => {
        for (const reservation of reservations) {
          if (reservation.quota === 'model_calls') {
            await dependencies.budget.settleBudget(client, { scope, reservationId: reservation.id, outcome: 'settled',
              usage: { kind: 'actual', amount: '1' as AgentDecimal, currency: null, details: { quota: reservation.quota } } })
          } else {
            const actual = reservation.quota === 'input_tokens' ? usage.input : usage.output
            await dependencies.budget.settleBudget(client, { scope, reservationId: reservation.id, outcome: 'settled',
              usage: actual === null
                ? { kind: 'unknown', amount: reservation.amount, currency: null, details: { quota: reservation.quota, reason: 'provider_usage_missing' } }
                : { kind: 'actual', amount: String(actual) as AgentDecimal, currency: null, details: { quota: reservation.quota } } })
          }
        }
        await client.query(`INSERT INTO agent_usage_entries(session_id,turn_id,settlement_key,usage_kind,amount,currency,details)
          VALUES($1,$2,$3,'unknown',0,NULL,$4::jsonb) ON CONFLICT(turn_id,settlement_key) DO NOTHING`,
        [scope.sessionId,scope.turnId,`model-cost:${reservations[0]!.id}`,JSON.stringify({quota:'estimated_cost',reason:'unpriced_model',unknownCost:true})])
      }
      const settleUnknown = async (roundId: string, reservations: AgentExecutionBudgetReservation[]) => {
        await dependencies.runtime.withTurnLease(fence, async client => {
          for (const reservation of reservations) {
            await dependencies.budget.settleBudget(client, { scope, reservationId: reservation.id, outcome: 'unknown',
              usage: { kind: 'unknown', amount: reservation.amount, currency: reservation.currency,
                details: { quota: reservation.quota, reason: 'provider_outcome_unknown' } } })
          }
          await dependencies.rounds.completeModelRound(client, { scope, roundId, status: 'failed', usage: null, checkpoint: null })
        })
      }
      const fail = async (error: AgentError) => {
        abort.abort()
        try {
          await dependencies.runtime.transitionWithTurnLease(fence, { to: 'failed', error: error as unknown as JsonObject }, async () => undefined)
        } catch (value) { if (!isFenceError(value)) throw value }
      }
      const executePending = async (state: AgentExecutionState): Promise<boolean> => {
        for (const tool of state.pendingToolCalls) {
          if (abort.signal.aborted) return true
          if (tool.status === 'waiting_external') continue
          // A materialized proposal has no model-issued effect yet. Only a durable
          // approved decision may advance it; declined/expired becomes a paired failure.
          let from: AgentToolCallStatus[] = ['recorded', 'validating']
          if (tool.status === 'waiting_approval') {
            if (!dependencies.media) return true
            const approval = await dependencies.read(client => dependencies.media!.readApproval(client, scope, tool.id))
            if (!approval) return true
            if (approval.status === 'pending' && !approval.expired) continue
            if (approval.status !== 'approved' || approval.expired) {
              const declined = approval.status === 'rejected'
              const expired = !declined && (approval.status === 'expired' || approval.expired)
              const error: AgentError = declined
                ? { code: 'APPROVAL_REJECTED', message: 'Agent approval was declined', retryable: false }
                : { code: 'APPROVAL_EXPIRED', message: 'Agent approval expired', retryable: false }
              await dependencies.runtime.withTurnLease(fence, async client => {
                // An expired decision still reads `pending` until the recovery
                // sweep wins the race, and a pending approval rejects the next
                // completed transition. Expiring it in this transaction keeps the
                // decision and its paired failure atomic; the helper is
                // idempotent and ignores a row the sweep already expired.
                if (expired) await expireAgentToolApproval(client, { scope, approvalId: approval.id })
                await dependencies.execution.recordToolResult(client, {
                  sessionId: scope.sessionId, turnId: scope.turnId, toolCallId: tool.id, idempotencyKey: `tool:${tool.id}`,
                  status: 'failed', result: null, error })
              })
              continue
            }
            from = ['waiting_approval']
          }
          // Effects, status and results commit together. Executing rows left by
          // a different implementation are uncertain and need M5 recovery.
          if (!from.includes(tool.status)) return true
          const round = (await dependencies.read(client => client.query(`SELECT position,input_revision::text FROM agent_model_rounds WHERE id=$1 AND turn_id=$2 AND session_id=$3 AND status='completed'`, [tool.roundId, scope.turnId, scope.sessionId]))).rows[0]
          if (!round) throw new Error('AGENT_TOOL_ROUND_MISSING')
          if (round.input_revision !== fence.expectedInputRevision) {
            // Steering superseded the reviewed arguments. A raw row keeps
            // waiting for its original input revision, but an approved
            // proposal can never execute and must fail instead of hanging.
            if (tool.status !== 'waiting_approval') return true
            const error: AgentError = { code: 'APPROVAL_CONFLICT', message: 'Approved proposal was superseded by a new input revision', retryable: false }
            await dependencies.runtime.withTurnLease(fence, client => dependencies.execution.recordToolResult(client, {
              sessionId: scope.sessionId, turnId: scope.turnId, toolCallId: tool.id, idempotencyKey: `tool:${tool.id}`,
              status: 'failed', result: null, error }).then(() => undefined))
            continue
          }
          try {
            await dependencies.runtime.withTurnLease(fence, async client => {
              const budget = { reserve: (input: AgentBudgetReserveInput) => dependencies.budget.reserveBudget(client, {
                scope, roundId: tool.roundId, toolCallId: tool.id, limit: budgetLimit(state.budget, state.turn.deadlineAt), nowMs: now(), reserve: input }) }
              const changed = await dependencies.rounds.markToolCallStatus(client, { scope, toolCallId: tool.id, from, to: 'executing' })
              if (!changed) throw new AgentRuntimeError('TRANSITION_REJECTED')
              const context: AgentToolContext = { scope, turn: state.turn, round: { roundId: tool.roundId, position: round.position, inputRevision: round.input_revision }, toolCallId: tool.id, sql: sql(client), budget, signal: abort.signal }
              // Canonical proposals are only ever written by the media materializer,
              // so they bypass the model-facing schema and run the approved executor.
              // Registration is still mandatory: canMaterialize only knows names, and
              // a sync tool must never inherit the approval-gated effect path.
              const canonical = Boolean(dependencies.media?.canMaterialize(tool.toolName, tool.toolSchemaVersion) && dependencies.media.isCanonical(tool.arguments))
              if (canonical) {
                const definition = dependencies.registry.get(tool.toolName, tool.toolSchemaVersion)
                if (!definition || definition.execution !== 'media_async' || definition.approval !== 'required') throw new Error('AGENT_MEDIA_TOOL_UNAVAILABLE')
              }
              const result = canonical
                ? await dependencies.media!.executeApproved(context, tool.toolName, tool.toolSchemaVersion, tool.arguments)
                : await dependencies.executor(context, tool.toolName, tool.toolSchemaVersion, tool.arguments)
              if (result.kind === 'failed') throw new AgentToolRejected(result.error)
              if (result.kind === 'pending') {
                if (!result.jobIds.length) throw new Error('AGENT_EMPTY_MEDIA_DEPENDENCIES')
                const links = (await client.query(`SELECT media_job_id FROM agent_tool_job_links WHERE session_id=$1 AND turn_id=$2 AND tool_call_id=$3 AND owner_id=$4`, [scope.sessionId, scope.turnId, tool.id, scope.ownerId])).rows.map(row => row.media_job_id as string)
                if (links.length !== result.jobIds.length || result.jobIds.some(id => !links.includes(id))) throw new Error('AGENT_MEDIA_LINKS_MISSING')
                const updated = await dependencies.rounds.markToolCallStatus(client, { scope, toolCallId: tool.id, from: ['executing'], to: 'waiting_external' })
                if (!updated) throw new AgentRuntimeError('TRANSITION_REJECTED')
              } else {
                await dependencies.execution.recordToolResult(client, { sessionId: scope.sessionId, turnId: scope.turnId, toolCallId: tool.id, idempotencyKey: `tool:${tool.id}`,
                  status: 'completed', result: result.result, error: null })
              }
            })
          } catch (value) {
            if (isFenceError(value) || abort.signal.aborted) throw value
            const error = value instanceof AgentToolRejected ? value.toolError : failure('TOOL_FAILED', 'Tool execution failed')
            if (value instanceof AgentToolRejected && error.message === 'APPROVAL_REQUIRED' && dependencies.media?.canMaterialize(tool.toolName, tool.toolSchemaVersion)) {
              // The raw call keeps its immutable identity and is never rewritten.
              // A materialized proposal hands off to the approval gate; a failed
              // one rolls back and becomes a paired failure the model can recover from.
              try {
                await dependencies.runtime.withTurnLease(fence, async client => {
                  await dependencies.media!.materialize(client, {
                    scope, round: { roundId: tool.roundId, position: round.position }, turn: state.turn, signal: abort.signal,
                  }, { rawToolCallId: tool.id, toolName: tool.toolName, toolSchemaVersion: tool.toolSchemaVersion, rawArgs: tool.arguments })
                  const advanced = await dependencies.rounds.markToolCallStatus(client, { scope, toolCallId: tool.id, from: [tool.status], to: 'waiting_external' })
                  if (!advanced) throw new AgentRuntimeError('TRANSITION_REJECTED')
                })
              } catch (cause) {
                if (isFenceError(cause)) throw cause
                if (abort.signal.aborted) continue
                // Never surface the underlying cause: it may carry model ids or SQL detail.
                await dependencies.runtime.withTurnLease(fence, client => dependencies.execution.recordToolResult(client, {
                  sessionId: scope.sessionId, turnId: scope.turnId, toolCallId: tool.id, idempotencyKey: `tool:${tool.id}`,
                  status: 'failed', result: { reason: 'PROPOSAL_INVALID' },
                  error: failure('TOOL_FAILED', 'Media proposal could not be materialized'),
                }).then(() => undefined))
              }
              continue
            }
            await dependencies.runtime.withTurnLease(fence, client => dependencies.execution.recordToolResult(client, { sessionId: scope.sessionId, turnId: scope.turnId, toolCallId: tool.id, idempotencyKey: `tool:${tool.id}`,
              status: 'failed', result: error.message === 'APPROVAL_REQUIRED' ? {reason:'APPROVAL_REQUIRED',proposalRequired:true} : null, error }).then(() => undefined))
          }
        }
        const current = await dependencies.read(client => dependencies.execution.loadExecutionState(client, scope))
        // A pending decision outranks outstanding media: both may block a turn.
        if (current.pendingToolCalls.some(tool => tool.status === 'waiting_approval')) {
          try { await dependencies.runtime.transitionWithTurnLease(fence, { to: 'waiting_approval' }, async () => undefined); return true }
          catch (value) { if (!(value instanceof AgentRuntimeError) || value.code !== 'TRANSITION_REJECTED') throw value }
          return true
        }
        if (current.pendingToolCalls.some(tool => tool.status === 'waiting_external')) {
          try { await dependencies.runtime.transitionWithTurnLease(fence, { to: 'waiting_tools' }, async () => undefined); return true }
          catch (value) { if (!(value instanceof AgentRuntimeError) || value.code !== 'TRANSITION_REJECTED') throw value }
          const latest = await dependencies.read(client => dependencies.execution.loadExecutionState(client, scope))
          return latest.pendingToolCalls.length > 0
        }
        return current.pendingToolCalls.length > 0
      }
      try {
        let state = await dependencies.read(client => dependencies.execution.loadExecutionState(client, scope))
        if (state.runningRounds > 0) {
          // A previous process may have died between a paid provider response
          // and its checkpoint. Replaying that call could charge twice.
          const rounds = (await dependencies.read(client => client.query(
            `SELECT r.id,b.id AS reservation_id,b.quota,b.reserved_amount::text AS amount,b.currency
             FROM agent_model_rounds r LEFT JOIN agent_budget_reservations b ON b.round_id=r.id AND b.status='reserved'
             WHERE r.session_id=$1 AND r.turn_id=$2 AND r.status IN ('running','recorded') ORDER BY r.position`, [scope.sessionId, scope.turnId]))).rows
          const unknown = rounds.filter(row => row.reservation_id).map(row => ({ id: row.reservation_id as string, quota: row.quota as AgentExecutionBudgetReservation['quota'],
            amount: row.amount as AgentDecimal, currency: row.currency as string | null, pricingRevision: null }))
          const roundIds = [...new Set(rounds.map(row => row.id as string))]
          await dependencies.runtime.withTurnLease(fence, async client => {
            for (const reservation of unknown) {
              await dependencies.budget.settleBudget(client, { scope, reservationId: reservation.id, outcome: 'unknown',
                usage: { kind: 'unknown', amount: reservation.amount, currency: reservation.currency, details: { quota: reservation.quota, reason: 'recovered_unknown' } } })
            }
            for (const roundId of roundIds) await dependencies.rounds.completeModelRound(client, { scope, roundId, status: 'failed', usage: null, checkpoint: null })
          }).catch(value => { if (!isFenceError(value)) throw value })
          return
        }
        for (let round = 0; round < maxRounds; round++) {
          if (abort.signal.aborted) return
          if (state.turn.cancelRequestedAt || Date.parse(state.turn.deadlineAt) <= now()) return
          if (state.pendingToolCalls.length) {
            if (await executePending(state)) return
            state = await dependencies.read(client => dependencies.execution.loadExecutionState(client, scope))
          }
          // No reliable price is frozen in V1. Deny unpriced paid calls under
          // a finite monetary ceiling instead of pretending their cost is zero.
          if (state.budget.maxEstimatedCost !== null) { await fail(failure('BUDGET_EXCEEDED', 'Model price is unknown')); return }
          const config = modelConfig(state.config, state.turn.deadlineAt, now())
          if (!config) { await fail(failure('TOOL_FAILED', 'Agent model configuration is unavailable')); return }
          const instructions = typeof state.config.instructions === 'string' ? state.config.instructions : ''
          const context = await dependencies.context.build({ ...scope, instructions })
          if (abort.signal.aborted) return
          const allowlist = new Set(Array.isArray(state.config.toolAllowlist) ? state.config.toolAllowlist.filter((entry): entry is string => typeof entry === 'string') : [])
          const tools: LanguageModelChatTool[] = dependencies.registry.list().filter(tool => allowlist.has(`${tool.name}@v${tool.schemaVersion}`)).map(tool => ({ name: offeredToolName(tool.name, tool.schemaVersion), description: tool.description, parameters: tool.parameters as Record<string, unknown> }))
          const offered = new Set(tools.map(tool => tool.name))
          const requestDigest = canonicalJsonDigest({ instructions: context.system, messages: context.messages as unknown as JsonValue, tools: tools as unknown as JsonValue })
          const admitted = await dependencies.runtime.withTurnLease(fence, async client => {
            const value = await dependencies.rounds.beginModelRound(client, { scope, position: state.nextRoundPosition, requestDigest, inputRevision: fence.expectedInputRevision, modelReferenceId: config.modelRevisionId })
            const limit = budgetLimit(state.budget, state.turn.deadlineAt)
            const reserve = (quota: 'model_calls' | 'input_tokens' | 'output_tokens', amount: string) => dependencies.budget.reserveBudget(client, {
              scope, roundId: value.roundId, limit, nowMs: now(),
              reserve: { quota, amount: amount as AgentDecimal, idempotencyKey: `model:${value.position}:${quota}` } })
            return { round: value, reservations: [await reserve('model_calls', '1'), await reserve('input_tokens', String(estimateTokens({ system: context.system, messages: context.messages as unknown as JsonValue, tools: tools as unknown as JsonValue }))), await reserve('output_tokens', String(config.maxOutputTokens))] }
          })
          let result: AgentModelResult
          try {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              result = await Promise.race([dependencies.model.complete({ config, instructions: context.system, messages: context.messages, tools, signal: abort.signal }), new Promise<never>((_, reject) => {
                timer = setTimeout(() => { abort.abort(); reject(new Error('AGENT_MODEL_DEADLINE')) }, config.timeoutMs)
              })])
            } finally { clearTimeout(timer) }
          } catch {
            await settleUnknown(admitted.round.roundId, admitted.reservations).catch(value => { if (!isFenceError(value)) throw value })
            return
          }
          if (abort.signal.aborted) { await settleUnknown(admitted.round.roundId,admitted.reservations); return }
          const parsed = result.toolCalls.map(call => parseOfferedTool(call.name))
          try { agentRoundCheckpoint({text:result.text,toolCalls:result.toolCalls,...(result.contentBlocks.length?{contentBlocks:result.contentBlocks}:{})}) }
          catch {
            await settleUnknown(admitted.round.roundId,admitted.reservations)
            return
          }
          if (parsed.some(value => value === null)) {
            await settleUnknown(admitted.round.roundId, admitted.reservations)
            return
          }
          const calls = result.toolCalls.map((call, index) => ({ call, tool: parsed[index]!, offered: offered.has(call.name), position: index }))
          const usage = usageOf(result)
          const checkpoint = { text: result.text, toolCalls: result.toolCalls.map(call => ({ id: call.id, name: call.name, arguments: call.arguments })),
            ...(result.contentBlocks.length ? { contentBlocks: result.contentBlocks } : {}) } as unknown as JsonObject
          let callBudgetExceeded = false
          if (!calls.length) {
            await dependencies.runtime.transitionWithTurnLease(fence, { to: 'completed' }, async client => {
              await dependencies.rounds.completeModelRound(client, { scope, roundId: admitted.round.roundId, status: 'completed', usage: { ...usage } as JsonObject, checkpoint })
              await dependencies.execution.appendAssistantItem(client, { scope, content: result.text })
              await settleRound(client, admitted.reservations, usage)
            })
            return
          }
          await dependencies.runtime.withTurnLease(fence, async client => {
            await dependencies.rounds.completeModelRound(client, { scope, roundId: admitted.round.roundId, status: 'completed', usage: { ...usage } as JsonObject, checkpoint })
            const rows = await dependencies.rounds.recordToolCalls(client, { scope, roundId: admitted.round.roundId,
              calls: calls.map(({ call, tool }, index) => ({ providerCallId: call.id, toolName: tool.name, toolSchemaVersion: tool.version,
                arguments: call.arguments as JsonObject, argumentsHash: canonicalJsonDigest(call.arguments as JsonValue), idempotencyKey: `round:${admitted.round.position}:${index}:${call.id}` })) })
            await dependencies.execution.appendAssistantItem(client, { scope, content: result.text, toolCallIds: rows.map(row => row.toolCallId) })
            for (let index = 0; index < rows.length; index++) {
              await dependencies.execution.appendToolCallItem(client, { scope, toolCallId: rows[index]!.toolCallId,
                providerCallId: calls[index]!.call.id, toolName: calls[index]!.tool.name, toolSchemaVersion: calls[index]!.tool.version, arguments: calls[index]!.call.arguments as JsonObject })
            }
            try {
              const callReservation = await dependencies.budget.reserveBudget(client, { scope, roundId: admitted.round.roundId, limit: budgetLimit(state.budget, state.turn.deadlineAt), nowMs: now(), reserve: { quota: 'tool_calls', amount: String(rows.length) as AgentDecimal, idempotencyKey: `round:${admitted.round.position}:tools` } })
              await dependencies.budget.settleBudget(client, { scope, reservationId: callReservation.id, outcome: 'settled', usage: { kind: 'actual', amount: String(rows.length) as AgentDecimal, currency: null, details: { quota: 'tool_calls' } } })
            } catch (error) {
              if (!(error instanceof AgentExecutionBudgetError) || error.code !== 'BUDGET_EXCEEDED') throw error
              callBudgetExceeded = true
            }
            await settleRound(client, admitted.reservations, usage)
            for (let index = 0; index < rows.length; index++) {
              if (callBudgetExceeded || !calls[index]!.offered) {
                await dependencies.execution.recordToolResult(client, { toolCallId: rows[index]!.toolCallId, sessionId: scope.sessionId, turnId: scope.turnId,
                  idempotencyKey: `tool:${rows[index]!.toolCallId}`, status: 'failed', result: null,
                  error: callBudgetExceeded ? failure('BUDGET_EXCEEDED', 'Tool call budget exceeded') : failure('TOOL_FAILED', 'Tool is unavailable') })
              }
            }
            return rows
          })
          if (callBudgetExceeded) { await fail(failure('BUDGET_EXCEEDED', 'Tool call budget exceeded')); return }
          state = await dependencies.read(client => dependencies.execution.loadExecutionState(client, scope))
          if (await executePending(state)) return
          state = await dependencies.read(client => dependencies.execution.loadExecutionState(client, scope))
        }
        await fail(failure('BUDGET_EXCEEDED', 'Agent turn exceeded its model round budget'))
      } catch (value) {
        if (value instanceof AgentExecutionBudgetError && value.code === 'BUDGET_EXCEEDED') {
          await fail(failure('BUDGET_EXCEEDED', 'Agent turn budget exceeded'))
          return
        }
        if (!isFenceError(value)) throw value
      } finally {
        clearInterval(heartbeat)
        dependencies.signal?.removeEventListener('abort', stop)
        await dependencies.runtime.releaseTurnLease(fence).catch(() => false)
      }
    },
  }
}
