import type { AgentApprovalStatus, JsonObject } from '@musecanvas/contracts'
import { agentCoreDecimal, type AgentCoreClient } from './agent-core'
import { appendAgentExecutionItem } from './agent-execution'
import type { AgentTurnScope } from './agent-runtime'

/**
 * Proposal half of the media approval lifecycle: append the waiting_approval
 * tool call, its pending approval and their public events. The caller owns the
 * transaction, the actor/session/turn locks and the Turn handoff, so these
 * functions never BEGIN/COMMIT, lock a row or read a client clock; expiry is
 * observed here and only an explicit `expireAgentToolApproval` (the Runner) or
 * the recovery sweep may decide it.
 */
export interface AppendAgentMediaProposalToolCallInput {
  scope: AgentTurnScope
  roundId: string
  providerCallId: string
  toolName: string
  toolSchemaVersion: number
  arguments: JsonObject
  argumentsHash: string
  idempotencyKey: string
}
export interface CreatePendingAgentMediaApprovalInput {
  scope: AgentTurnScope
  toolCallId: string
  argumentsHash: string
  modelRevision: string
  pricingRevision: string
  reservationId: string
}
export interface ReadAgentToolApprovalInput {
  scope: AgentTurnScope
  toolCallId: string
}
export interface ExpireAgentToolApprovalInput {
  scope: AgentTurnScope
  approvalId: string
}
export interface AgentToolApproval {
  id: string
  status: AgentApprovalStatus
  expired: boolean
}

interface AgentApprovalRow {
  id: string
  session_id: string
  turn_id: string
  tool_call_id: string
  arguments_hash: string
  model_revision: string
  pricing_revision: string
  reservation_id: string
  status: AgentApprovalStatus
  expires_at: Date
  resolved_by: string | null
  resolved_at: Date | null
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('AGENT_MEDIA_PROPOSAL_NOT_FOUND')
  return value
}
/** Session cursor allocation matches AgentCoreRepository.event. */
async function event(client: AgentCoreClient, scope: AgentTurnScope, revision: string,
  type: 'tool.updated' | 'approval.required', payload: JsonObject): Promise<void> {
  const counter = required((await client.query<{ cursor: string }>(`UPDATE agent_sessions SET next_event_cursor=next_event_cursor+1,updated_at=clock_timestamp()
    WHERE id=$1 AND owner_id=$2 RETURNING (next_event_cursor-1)::text AS cursor`, [scope.sessionId, scope.ownerId])).rows[0])
  await client.query(`INSERT INTO agent_session_events(session_id,turn_id,cursor,entity_revision,event_type,payload)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
  [scope.sessionId, scope.turnId, counter.cursor, revision, type, JSON.stringify(payload)])
}
async function turnRevision(client: AgentCoreClient, scope: AgentTurnScope): Promise<string> {
  const row = required((await client.query<{ revision: string }>(`SELECT revision::text AS revision FROM agent_turns
    WHERE session_id=$1 AND id=$2`, [scope.sessionId, scope.turnId])).rows[0])
  return agentCoreDecimal(row.revision)
}
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : value
/** Same allowlisted AgentApprovalSummaryDTO projection agent-recovery publishes. */
function approvalProjection(a: AgentApprovalRow, revision: string): JsonObject {
  return { approval: { id: a.id, sessionId: a.session_id, turnId: a.turn_id, toolCallId: a.tool_call_id,
    argumentsHash: a.arguments_hash, modelRevision: a.model_revision, pricingRevision: a.pricing_revision,
    reservationId: a.reservation_id, status: a.status, expiresAt: iso(a.expires_at),
    resolvedBy: a.resolved_by ?? null, resolvedAt: a.resolved_at == null ? null : iso(a.resolved_at), revision } }
}

export async function appendAgentMediaProposalToolCall(client: AgentCoreClient,
  input: AppendAgentMediaProposalToolCallInput): Promise<{ toolCallId: string }> {
  const { scope } = input
  const replay = (await client.query<{ id: string }>(`SELECT id FROM agent_tool_calls
    WHERE session_id=$1 AND turn_id=$2 AND idempotency_key=$3`,
  [scope.sessionId, scope.turnId, input.idempotencyKey])).rows[0]
  if (replay) return { toolCallId: replay.id }
  // MAX(position) is evaluated inside the INSERT so a concurrent proposal for the
  // same round cannot read a stale position; UNIQUE(round_id,position) stays the
  // final guard.
  const created = required((await client.query<{ id: string }>(`INSERT INTO agent_tool_calls(session_id,turn_id,round_id,position,
    provider_call_id,tool_name,tool_schema_version,arguments,arguments_hash,status,idempotency_key)
    SELECT $1,$2,$3,COALESCE((SELECT MAX(position) FROM agent_tool_calls WHERE session_id=$1 AND turn_id=$2 AND round_id=$3),-1)+1,
      $4,$5,$6,$7::jsonb,$8,'waiting_approval',$9
    RETURNING id`,
  [scope.sessionId, scope.turnId, input.roundId, input.providerCallId, input.toolName, input.toolSchemaVersion,
    JSON.stringify(input.arguments), input.argumentsHash, input.idempotencyKey])).rows[0])
  await appendAgentExecutionItem(client, scope, 'tool_call', { providerCallId: input.providerCallId,
    toolName: input.toolName, toolSchemaVersion: input.toolSchemaVersion, arguments: input.arguments }, created.id)
  const revision = await turnRevision(client, scope)
  await event(client, scope, revision, 'tool.updated',
    { tool: { id: created.id, turnId: scope.turnId, toolName: input.toolName, status: 'waiting_approval', revision } })
  return { toolCallId: created.id }
}

export async function createPendingAgentMediaApproval(client: AgentCoreClient,
  input: CreatePendingAgentMediaApprovalInput): Promise<{ approvalId: string }> {
  const { scope } = input
  const replay = (await client.query<{ id: string }>(`SELECT id FROM agent_approvals
    WHERE session_id=$1 AND turn_id=$2 AND tool_call_id=$3 AND arguments_hash=$4`,
  [scope.sessionId, scope.turnId, input.toolCallId, input.argumentsHash])).rows[0]
  if (replay) return { approvalId: replay.id }
  // Both instants are database clocks: the Turn deadline is frozen at admission
  // and the 30 minute review window starts when the approval row is written.
  const created = required((await client.query<AgentApprovalRow>(`INSERT INTO agent_approvals(session_id,turn_id,tool_call_id,
    arguments_hash,model_revision,pricing_revision,reservation_id,status,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,'pending',LEAST(t.deadline_at,clock_timestamp()+interval '30 minutes')
    FROM agent_turns t WHERE t.session_id=$1 AND t.id=$2
    RETURNING *`,
  [scope.sessionId, scope.turnId, input.toolCallId, input.argumentsHash, input.modelRevision, input.pricingRevision,
    input.reservationId])).rows[0])
  const revision = await turnRevision(client, scope)
  await event(client, scope, revision, 'approval.required', approvalProjection(created, revision))
  return { approvalId: created.id }
}

export async function readAgentToolApproval(client: AgentCoreClient,
  input: ReadAgentToolApprovalInput): Promise<AgentToolApproval | null> {
  const row = (await client.query<AgentToolApproval>(`SELECT id,status,expires_at<=clock_timestamp() AS expired
    FROM agent_approvals WHERE session_id=$1 AND turn_id=$2 AND tool_call_id=$3`,
  [input.scope.sessionId, input.scope.turnId, input.toolCallId])).rows[0]
  if (!row) return null
  return row.status === 'pending' && row.expired ? { id: row.id, status: 'expired', expired: true } : row
}

/**
 * Durable expiry for the Runner after it observes an expired approval: the row
 * must read `expired` before the paired failure and the next model round commit,
 * otherwise the still-pending approval rejects the waiting/terminal transition.
 * One idempotent UPDATE that binds the decision to the parent Turn revision in
 * SQL; it never emits an event, touches a reservation or controls the transaction.
 */
export async function expireAgentToolApproval(client: AgentCoreClient,
  input: ExpireAgentToolApprovalInput): Promise<boolean> {
  const rows = (await client.query<{ id: string }>(`UPDATE agent_approvals a SET status='expired',resolved_at=clock_timestamp(),
    decision_revision=t.revision
    FROM agent_turns t
    WHERE a.id=$1 AND a.session_id=$2 AND a.turn_id=$3
      AND t.session_id=a.session_id AND t.id=a.turn_id
      AND a.status='pending' AND a.expires_at<=clock_timestamp()
    RETURNING a.id`,
  [input.approvalId, input.scope.sessionId, input.scope.turnId])).rows
  return rows.length > 0
}
