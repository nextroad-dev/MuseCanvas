/**
 * Cross-lane contracts for the Agent Core Worker runtime.
 *
 * This file is type-only. It deliberately contains no implementation, no I/O,
 * no database access and no transaction control.
 *
 * Ownership:
 * - `runner.ts` (backend) owns the model round, tool-call rows, the fence
 *   callback and model-round budget reservation/settlement.
 * - Tool implementations receive `AgentToolContext.sql`, which is already
 *   inside the caller-owned `withTurnLease` transaction. They must never
 *   BEGIN/COMMIT/ROLLBACK. Throwing rolls back every write in that tool
 *   effect, including `agent_tool_job_links` and the wake Outbox row.
 * - `media-events.ts` (media) uses `AgentTransaction` and
 *   `AgentToolSettlementPort`; the Redis ACK happens only after that
 *   transaction commits.
 * - M5 owns cancel, steering, approval enforcement and recovery coordination.
 *   The fields below are the seams those controls build on: `approval` is
 *   metadata only in this phase, and `expectedInputRevision` is the existing
 *   P5a fence that makes stale steering/cancel effects fail.
 */
import type {
  AgentBudgetQuota,
  AgentDecimal,
  AgentError,
  AgentEstimatedCost,
  AgentToolCallStatus,
  AgentTurnDTO,
  JsonObject,
  ToolExecutionResult,
} from '@musecanvas/contracts'
import type {
  DecodedCredential,
  LanguageModelChatMessage,
  LanguageModelChatResult,
  LanguageModelChatTool,
  ReasoningEffort,
} from '@musecanvas/providers'

/** Minimal query surface accepted by Worker tools. It is not a transaction handle. */
export interface AgentSqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
}

/** The caller owns BEGIN/COMMIT/ROLLBACK and must rethrow every error. */
export type AgentTransaction = <T>(work: (client: AgentSqlClient) => Promise<T>) => Promise<T>

export interface AgentTurnScope {
  readonly ownerId: string
  readonly sessionId: string
  readonly turnId: string
}

/** P5a execution fence. M5 may create it; every effect write must still pass it. */
export interface AgentFencedTurn extends AgentTurnScope {
  readonly leaseOwner: string
  readonly fencingToken: AgentDecimal
  readonly expectedInputRevision: AgentDecimal
}

export interface AgentModelRoundRef {
  readonly roundId: string
  readonly position: number
  readonly inputRevision: AgentDecimal
}

export type AgentToolExecutionKind = 'sync' | 'media_async' | 'canvas_mutation'

/**
 * Metadata seam for M5. `required` means the runner must not execute the tool
 * without an approval decision; this phase does not create or resolve one.
 */
export type AgentToolApprovalPolicy = 'never' | 'required'

export interface AgentToolBudgetPolicy {
  readonly maxMediaJobs: number
  readonly maxMediaOutputs: number
  readonly maxEstimatedCost: AgentEstimatedCost | null
}

export interface AgentBudgetReserveInput {
  readonly quota: AgentBudgetQuota
  /** Counts are base-10 integer strings; estimated_cost uses numeric(30,9). */
  readonly amount: AgentDecimal
  readonly currency?: string
  readonly pricingRevision?: string
  /** Unique per turn. Reusing it must not reserve twice. */
  readonly idempotencyKey: string
}

export interface AgentBudgetReservation {
  readonly id: string
  readonly quota: AgentBudgetQuota
  readonly amount: AgentDecimal
  readonly currency: string | null
  readonly pricingRevision: string | null
}

/**
 * Bound by the executor to the same fenced `sql` client as the tool context.
 * The runner owns settlement/release; tools only reserve before effects.
 */
export interface AgentToolBudgetPort {
  reserve(input: AgentBudgetReserveInput): Promise<AgentBudgetReservation>
}

export interface AgentToolContext {
  readonly scope: AgentTurnScope
  readonly turn: AgentTurnDTO
  readonly round: AgentModelRoundRef
  readonly toolCallId: string
  /** Caller-owned fenced SQL. Never begins or ends a transaction. */
  readonly sql: AgentSqlClient
  readonly budget: AgentToolBudgetPort
  readonly signal: AbortSignal
}

export interface AgentTool {
  readonly name: string
  readonly description: string
  readonly schemaVersion: number
  readonly parameters: JsonObject
  readonly permissions: readonly string[]
  readonly execution: AgentToolExecutionKind
  readonly approval: AgentToolApprovalPolicy
  readonly budget: AgentToolBudgetPolicy
  execute(context: AgentToolContext, args: JsonObject): Promise<ToolExecutionResult>
}

export interface AgentToolRegistry {
  get(name: string, schemaVersion: number): AgentTool | null
  list(): readonly AgentTool[]
}

/** Owner-scoped read-only dependencies. Results become tool JSON, never raw rows. */
export interface AgentReadOnlyToolPorts {
  listModels(ownerId: string, input: { readonly mediaKind?: 'image' | 'video' }): Promise<JsonObject>
  searchAssets(ownerId: string, input: { readonly query?: string; readonly cursor?: string; readonly limit: number }): Promise<JsonObject>
  getAsset(ownerId: string, input: { readonly assetId: string }): Promise<JsonObject>
  getCanvas(ownerId: string, input: { readonly canvasId: string }): Promise<JsonObject>
}

/** Safe, non-secret model execution snapshot taken from the turn config. */
export interface AgentModelConfig {
  readonly modelConfigId: string
  readonly modelRevisionId: string
  readonly modelRevision: string
  readonly providerId: string
  readonly protocol: 'openai_chat' | 'anthropic_messages'
  readonly pluginId: string
  readonly pluginVersion: string
  readonly vendorModelId: string
  readonly maxOutputTokens: number
  readonly temperature: number | null
  readonly reasoningEffort: ReasoningEffort | null
  readonly timeoutMs: number
}

/** Internal Worker-only credential material. Never copy this into Items or logs. */
export interface AgentModelCredential {
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly credential?: DecodedCredential
}

export interface AgentModelRequest {
  readonly config: AgentModelConfig
  readonly instructions: string
  readonly messages: LanguageModelChatMessage[]
  readonly tools: LanguageModelChatTool[]
  readonly signal: AbortSignal
}

export type AgentModelResult = LanguageModelChatResult

export interface AgentModelPort {
  complete(input: AgentModelRequest): Promise<AgentModelResult>
}

export interface AgentModelDependencies {
  loadCredential(input: { readonly modelConfigId: string; readonly providerId: string }): Promise<AgentModelCredential>
}

export type CreateAgentModel = (dependencies: AgentModelDependencies) => AgentModelPort

export interface AgentContextRequest {
  readonly ownerId: string
  readonly sessionId: string
  readonly turnId: string
  readonly instructions: string
  readonly maxBytes?: number
  readonly maxTurns?: number
}

export interface AgentContext {
  readonly system: string
  readonly messages: LanguageModelChatMessage[]
}

export interface AgentContextPort {
  build(input: AgentContextRequest): Promise<AgentContext>
}

export interface AgentContextDependencies {
  /** Read-only transaction owned by the caller. */
  readonly transaction: AgentTransaction
}

export type CreateAgentContext = (dependencies: AgentContextDependencies) => AgentContextPort

export interface AgentToolResultInput {
  readonly toolCallId: string
  readonly sessionId: string
  readonly turnId: string
  /** Unique per result; duplicate delivery must not append a second Item. */
  readonly idempotencyKey: string
  readonly status: Extract<AgentToolCallStatus, 'completed' | 'failed' | 'cancelled'>
  readonly result: JsonObject | null
  readonly error: AgentError | null
}

export interface AgentToolResultRecord {
  readonly recorded: boolean
  readonly finalResult: boolean
}

export interface AgentWakeIntent {
  readonly sessionId: string
  readonly turnId: string
  readonly revision: AgentDecimal
}

/**
 * Media-event handoff. Both methods must run on the same caller-owned client;
 * the implementation writes the Outbox wake in that transaction and returns the
 * intent so the consumer can ACK only after commit.
 */
export interface AgentToolSettlementPort {
  recordToolResult(client: AgentSqlClient, input: AgentToolResultInput): Promise<AgentToolResultRecord>
  queueIfDependenciesTerminal(client: AgentSqlClient, scope: AgentTurnScope): Promise<AgentWakeIntent | null>
}

/** Durable media completion consumed from `media.job.completed`. */
export interface AgentMediaCompletion {
  readonly eventId: string
  readonly jobId: string
}

export interface AgentMediaEventDependencies {
  readonly transaction: AgentTransaction
  readonly settlement: AgentToolSettlementPort
}

export type AgentMediaEventHandler = (event: AgentMediaCompletion) => Promise<'ack' | 'retry'>
export type CreateAgentMediaEventHandler = (dependencies: AgentMediaEventDependencies) => AgentMediaEventHandler

/** Durable `agent.turn.wake` stream message. */
export interface AgentRunnerWake {
  readonly eventId: string
  readonly sessionId: string
  readonly turnId: string
  readonly revision: AgentDecimal
}

export interface AgentRunner {
  runTurn(wake: AgentRunnerWake): Promise<void>
}
