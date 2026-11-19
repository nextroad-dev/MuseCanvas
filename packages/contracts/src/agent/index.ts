import type { JsonObject } from '../index'

export * from './artifacts'

/** PostgreSQL bigint values travel as base-10 strings, never JS numbers. */
export type AgentDecimal = `${bigint}`
export type AgentTurnStatus = 'queued' | 'running' | 'waiting_tools' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
export type AgentToolCallStatus = 'recorded' | 'validating' | 'waiting_approval' | 'executing' | 'waiting_external' | 'completed' | 'failed' | 'cancelled' | 'skipped'
export type AgentApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'
export type AgentModelRoundStatus = 'recorded' | 'running' | 'completed' | 'failed' | 'superseded'
export type AgentBudgetReservationStatus = 'reserved' | 'settled' | 'released' | 'unknown'
export type AgentUsageKind = 'estimated' | 'actual' | 'unknown'
export const AGENT_BUDGET_QUOTAS = ['model_calls', 'tool_calls', 'media_jobs', 'media_outputs', 'input_tokens', 'output_tokens', 'estimated_cost', 'concurrent_media_jobs'] as const
export type AgentBudgetQuota = (typeof AGENT_BUDGET_QUOTAS)[number]
export type AgentItemType = 'user_message' | 'assistant_message' | 'tool_call' | 'tool_result' | 'approval' | 'artifact_reference' | 'system_event'
export type AgentErrorCode = 'IDEMPOTENCY_CONFLICT' | 'RESYNC_REQUIRED' | 'INVALID_TRANSITION' | 'LEASE_LOST' | 'BUDGET_EXCEEDED' | 'APPROVAL_CONFLICT' | 'APPROVAL_EXPIRED' | 'APPROVAL_REJECTED' | 'TOOL_FAILED' | 'DEADLINE_EXCEEDED' | 'SUBMISSION_UNKNOWN'
export interface AgentError { code: AgentErrorCode; message: string; retryable: boolean }

/** Decimal amounts match numeric(30,9); runtime checks belong to pure domain rules. */
export interface AgentEstimatedCost {
  currency: string
  amount: string
  pricingReference: string
}
export interface AgentBudgetDTO {
  maxModelCalls: number
  maxToolCalls: number
  maxMediaJobs: number
  maxMediaOutputs: number
  maxInputTokens: AgentDecimal
  maxOutputTokens: AgentDecimal
  /** null explicitly denotes no monetary ceiling; null usage denotes unknown cost. */
  maxEstimatedCost: AgentEstimatedCost | null
  maxConcurrentMediaJobs: number
  deadlineAt: string
}
/** Definitions store relative lifetime; each Turn freezes its own DB-clock deadline. */
export interface AgentDefinitionBudgetPolicy extends Omit<AgentBudgetDTO, 'deadlineAt'> { timeoutMs: number }
export interface AgentDefinitionModelPolicy { modelConfigId: string; modelRevisionId: string }
export interface AgentDefinition {
  id: string
  ownerId: string | null
  name: string
  version: number
  modelPolicy: AgentDefinitionModelPolicy
  instructions: string
  toolAllowlist: string[]
  budgetPolicy: AgentDefinitionBudgetPolicy
  status: 'active' | 'retired'
  createdAt: string
}
export interface AgentSessionDTO {
  id: string
  ownerId: string
  agentDefinitionId: string
  definitionVersion: number
  /** @deprecated 画布已废弃（docs/canvas-deprecation.md），新会话恒为 null，仅为过渡兼容保留。 */
  defaultCanvasId: string | null
  activeTurnId: string | null
  inputRevision: AgentDecimal
  nextItemSequence: AgentDecimal
  nextEventCursor: AgentDecimal
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}
export interface AgentTurnLease {
  owner: string
  until: string
  fencingToken: AgentDecimal
}

export interface AgentTurnDTO {
  id: string
  sessionId: string
  status: AgentTurnStatus
  engineVersion: string
  revision: AgentDecimal
  inputRevision: AgentDecimal
  cancelRequestedAt: string | null
  terminalAt: string | null
  deadlineAt: string
  error: AgentError | null
}
export interface AgentItemDTO {
  id: string
  sessionId: string
  turnId: string | null
  sequence: AgentDecimal
  type: AgentItemType
  toolCallId: string | null
  payload: JsonObject
  createdAt: string
}
export interface AgentToolCallDTO {
  id: string
  sessionId: string
  turnId: string
  roundId: string
  position: number
  providerCallId: string
  toolName: string
  toolSchemaVersion: number
  arguments: JsonObject
  argumentsHash: string
  status: AgentToolCallStatus
  result: JsonObject | null
  error: AgentError | null
}
export type ToolExecutionResult =
  | { kind: 'completed'; result: JsonObject }
  /** All job IDs must already be durable before this result is returned. */
  | { kind: 'pending'; jobIds: [string, ...string[]] }
  | { kind: 'failed'; error: AgentError }
export interface AgentApprovalDTO {
  id: string
  sessionId: string
  turnId: string
  toolCallId: string
  argumentsHash: string
  modelRevision: string
  pricingRevision: string
  reservationId: string
  status: AgentApprovalStatus
  expiresAt: string
  resolvedBy: string | null
  resolvedAt: string | null
}

/** User-visible durable log; deliberately distinct from Outbox commands. */
export interface AgentEventPayloads {
  'item.created': { item: AgentItemDTO }
  'tool.updated': { tool: AgentToolSummaryDTO }
  'approval.required': { approval: AgentApprovalSummaryDTO }
  'turn.updated': { turn: AgentTurnDTO }
}
export type AgentEventEnvelope = {
  [K in keyof AgentEventPayloads]: {
    schemaVersion: 1
    eventId: string
    sessionId: string
    turnId: string | null
    type: K
    createdAt: string
    cursor: AgentDecimal
    itemSequence: AgentDecimal | null
    entityRevision: AgentDecimal | null
    payload: AgentEventPayloads[K]
  }
}[keyof AgentEventPayloads]
export type AgentOutboxCommand =
  | { type: 'agent.turn.wake'; aggregateId: string; payload: { schemaVersion: 1; sessionId: string; turnId: string; revision: AgentDecimal } }
  | { type: 'media.job.completed'; aggregateId: string; payload: { schemaVersion: 1; jobId: string } }
export interface AgentSessionSnapshotDTO {
  session: AgentSessionDTO
  activeTurn: AgentTurnDTO | null
  items: AgentItemDTO[]
  eventCursor: AgentDecimal
  lastItemSequence: AgentDecimal
  itemsHasMore: boolean
  nextItemsCursor: AgentDecimal
  /** Tools/pending approvals use current parent Turn revision; decided approvals freeze the decision Turn revision. */
  tools: AgentToolSummaryDTO[]
  approvals: AgentApprovalSummaryDTO[]
  summariesTruncated: boolean
}
export interface AgentToolSummaryDTO { id: string; turnId: string; toolName: string; status: AgentToolCallStatus; revision: AgentDecimal }
/** revision is the decision Turn revision when final, otherwise current Turn revision; not an approval counter. */
export interface AgentApprovalSummaryDTO extends AgentApprovalDTO { revision: AgentDecimal }
export interface AgentItemsPageDTO { items: AgentItemDTO[]; nextCursor: AgentDecimal; hasMore: boolean; lastItemSequence: AgentDecimal }
export interface AgentSessionsPageDTO { sessions: AgentSessionDTO[]; nextCursor: string | null }
export interface AgentEventsPageDTO {
  events: AgentEventEnvelope[]
  highWater: AgentDecimal
  retentionFloor: AgentDecimal
  hasMore: boolean
  resyncRequired: boolean
}
/** Transport frames are not durable events. SSE IDs are sessionId:cursor. Reconnect with that ID. */
export type AgentTransportFrame =
  | { type: 'ready'; sessionId: string; highWater: AgentDecimal }
  | { type: 'heartbeat'; sessionId: string; cursor: AgentDecimal }
  | { type: 'resync.required'; sessionId: string; reason: 'retention' | 'backlog' | 'unavailable' }

/** @deprecated defaultCanvasId 已随画布废弃（docs/canvas-deprecation.md），后端接受但忽略该字段。 */
export interface CreateAgentSessionRequest { clientRequestId: string; agentDefinitionId: string; definitionVersion: number; defaultCanvasId?: string }
export const AGENT_MESSAGE_MAX_ATTACHMENTS = 4
export interface AgentMessageAttachment {
  kind: 'upload' | 'asset'
  id: string
  role: 'reference_image' | 'mask'
  checksum: string
  width: number
  height: number
  mimeType: 'image/png' | 'image/jpeg'
  preparationVersion?: 1
  sourceChecksum?: string
}
export interface CreateAgentMessageRequest { clientMessageId: string; content: string; attachments?: AgentMessageAttachment[] }
/** Multipart metadata; image and mask bytes are separate binary parts, not JSON DTO values.
 * turnId requires sessionId and proves an active admitted turn; session-only is new work.
 */
export interface PrepareAgentImageEditRequest {
  modelId: string
  assetId?: string
  region?: { x: number; y: number; width: number; height: number }
  idempotencyKey?: string
  sessionId?: string
  turnId?: string
}
export interface AgentEditPreparationDTO {
  maskUploadId: string
  source: { kind: 'upload' | 'asset'; id: string }
  sourceChecksum: string
  maskChecksum: string
  width: number
  height: number
  selection?: { x: number; y: number; width: number; height: number }
  expiresAt: string
  preparationVersion: 1
}
export interface AgentMessageAcceptedDTO { turn: AgentTurnDTO; acceptedInputRevision: AgentDecimal }
export interface ResolveAgentApprovalRequest { decision: 'approved' | 'rejected'; expectedArgumentsHash: string }
