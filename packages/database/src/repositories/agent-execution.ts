import type { AgentBudgetDTO, AgentError, AgentItemDTO, AgentToolCallDTO, AgentToolCallStatus, AgentTurnDTO, JsonObject } from '@musecanvas/contracts'
import { agentCoreDecimal, agentItemDTO, agentTurnDTO, type AgentCoreClient } from './agent-core'
import type { AgentTurnScope } from './agent-runtime'
import { canvasAgentRequestDigest } from './canvas-agent'
import { settleLinkedAgentMediaReservations } from './agent-media-settlement'

export interface AgentToolResultInput { toolCallId: string; sessionId: string; turnId: string; idempotencyKey: string; status: Extract<AgentToolCallStatus,'completed'|'failed'|'cancelled'>; result: JsonObject | null; error: AgentError | null }
export interface AgentToolResultRecord { recorded: boolean; finalResult: boolean }
export interface AgentWakeIntent { sessionId: string; turnId: string; revision: ReturnType<typeof agentCoreDecimal> }
export interface AgentExecutionState { turn: AgentTurnDTO; config: JsonObject; budget: AgentBudgetDTO; items: AgentItemDTO[]; pendingToolCalls: AgentToolCallDTO[]; nextRoundPosition: number; runningRounds: number }
export interface AgentExecutionRepository {
  loadExecutionState(client: AgentCoreClient, scope: AgentTurnScope): Promise<AgentExecutionState>
  appendAssistantItem(client: AgentCoreClient, input: { scope: AgentTurnScope; content: string; toolCallIds?: string[] }): Promise<AgentItemDTO>
  appendToolCallItem(client: AgentCoreClient, input: { scope: AgentTurnScope; toolCallId: string; providerCallId: string; toolName: string; toolSchemaVersion: number; arguments: JsonObject }): Promise<AgentItemDTO>
  recordToolResult(client: AgentCoreClient, input: AgentToolResultInput): Promise<AgentToolResultRecord>
  queueIfDependenciesTerminal(client: AgentCoreClient, scope: AgentTurnScope): Promise<AgentWakeIntent | null>
}
const req = <T>(value: T | undefined): T => { if (value === undefined) throw new Error('AGENT_EXECUTION_NOT_FOUND'); return value }
async function event(client: AgentCoreClient, scope: AgentTurnScope, type: 'item.created'|'turn.updated'|'tool.updated', payload: JsonObject, sequence: string | null = null): Promise<void> {
  const counter = req((await client.query(`UPDATE agent_sessions SET next_event_cursor=next_event_cursor+1,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 RETURNING (next_event_cursor-1)::text AS cursor`,[scope.sessionId,scope.ownerId])).rows[0])
  await client.query(`INSERT INTO agent_session_events(session_id,turn_id,cursor,entity_revision,item_sequence,event_type,payload) SELECT $1,$2,$3,t.revision,$4,$5,$6::jsonb FROM agent_turns t WHERE t.id=$2 AND t.session_id=$1`,[scope.sessionId,scope.turnId,counter.cursor,sequence,type,JSON.stringify(payload)])
}
export async function appendAgentExecutionItem(client: AgentCoreClient, scope: AgentTurnScope, type: 'assistant_message'|'tool_result'|'tool_call', payload: JsonObject, toolCallId: string | null): Promise<AgentItemDTO> {
  const counter = req((await client.query(`UPDATE agent_sessions SET next_item_sequence=next_item_sequence+1,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 RETURNING (next_item_sequence-1)::text AS sequence`,[scope.sessionId,scope.ownerId])).rows[0])
  const value = req((await client.query(`INSERT INTO agent_items(session_id,turn_id,sequence,item_type,tool_call_id,payload,content_digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,[scope.sessionId,scope.turnId,counter.sequence,type,toolCallId,JSON.stringify(payload),canvasAgentRequestDigest(payload)])).rows[0])
  const dto = agentItemDTO(value)
  await event(client,scope,'item.created',{ item: dto as unknown as JsonObject },dto.sequence)
  return dto
}
export async function projectAgentFinalToolResult(client: AgentCoreClient, scope: AgentTurnScope, tool: {
  id: string; tool_name: string; status: AgentToolCallStatus; result: JsonObject | null; error: AgentError | null
  provider_call_id?: unknown
}, revision: string): Promise<AgentToolResultRecord> {
  if (!finalToolStatus(tool.status) || (tool.result === null && tool.error === null)) throw new Error('AGENT_RESULT_INVALID')
  const record=await projectFinalResultPair(client,scope,tool,revision)
  // Every writer of a final media result (event settlement, recovery sweep) also
  // makes it visible on the raw call, after that writer settled the reservations.
  if (record.recorded) await projectRawProposalResult(client,scope,tool.provider_call_id,{status:tool.status,result:tool.result,error:tool.error})
  return record
}

/** The unique result item plus its tool.updated event; never mirrors another row. */
async function projectFinalResultPair(client: AgentCoreClient, scope: AgentTurnScope, tool: {
  id: string; tool_name: string; status: AgentToolCallStatus; result: JsonObject | null; error: AgentError | null
}, revision: string): Promise<AgentToolResultRecord> {
  const exists=(await client.query(`SELECT id FROM agent_items WHERE tool_call_id=$1 AND item_type='tool_result'`,[tool.id])).rows.length>0
  if (exists) return {recorded:false,finalResult:true}
  await appendAgentExecutionItem(client,scope,'tool_result',{content:JSON.stringify(tool.result ?? tool.error),status:tool.status,result:tool.result,error:tool.error as unknown as JsonObject|null},tool.id)
  await event(client,scope,'tool.updated',{tool:{id:tool.id,turnId:scope.turnId,toolName:tool.tool_name,status:tool.status,revision}})
  return {recorded:true,finalResult:true}
}

const FINAL_TOOL_STATUSES = ['completed','failed','cancelled','skipped']
const PROPOSAL_PROVIDER_CALL_PREFIX = 'agent-proposal:'
const finalToolStatus = (value: unknown): boolean => FINAL_TOOL_STATUSES.includes(String(value))

/** The internal proposal row names the raw, model-visible call it was materialized from. */
function rawToolCallIdOfProposal(providerCallId: unknown): string | null {
  if (typeof providerCallId !== 'string' || !providerCallId.startsWith(PROPOSAL_PROVIDER_CALL_PREFIX)) return null
  const id = providerCallId.slice(PROPOSAL_PROVIDER_CALL_PREFIX.length)
  return id.length ? id : null
}

interface AgentFinalToolResult { status: AgentToolCallStatus; result: JsonObject | null; error: AgentError | null }

/**
 * The canonical proposal row is internal: the model only sees the raw call whose
 * marker is in the round checkpoint. Its final result is mirrored onto that raw
 * row in the same transaction so both rows pair exactly once. Final tool rows are
 * immutable (agent_guard_tool_update), so a replay never rewrites one and the
 * unique result index keeps a second item from ever being inserted.
 */
async function projectRawProposalResult(client: AgentCoreClient, scope: AgentTurnScope, providerCallId: unknown, final: AgentFinalToolResult): Promise<void> {
  const rawId = rawToolCallIdOfProposal(providerCallId)
  if (!rawId || (final.result === null && final.error === null)) return
  // Session/Turn scoping keeps a proposal from ever mirroring across turns.
  const raw=(await client.query(`SELECT id,status,tool_name FROM agent_tool_calls WHERE id=$3 AND session_id=$1 AND turn_id=$2 FOR UPDATE`,[scope.sessionId,scope.turnId,rawId])).rows[0]
  if (!raw || finalToolStatus(raw.status)) return
  if ((await client.query(`SELECT id FROM agent_items WHERE tool_call_id=$1 AND item_type='tool_result'`,[rawId])).rows.length) return
  await client.query(`UPDATE agent_tool_calls SET status=$4,result=$5::jsonb,error=$6::jsonb,updated_at=clock_timestamp() WHERE id=$3 AND session_id=$1 AND turn_id=$2 AND status NOT IN ('completed','failed','cancelled','skipped')`,[scope.sessionId,scope.turnId,rawId,final.status,final.result ? JSON.stringify(final.result) : null,final.error ? JSON.stringify(final.error) : null])
  const revision=req((await client.query(`SELECT revision::text FROM agent_turns WHERE session_id=$1 AND id=$2`,[scope.sessionId,scope.turnId])).rows[0]).revision
  await projectFinalResultPair(client,scope,{id:rawId,tool_name:String(raw.tool_name),status:final.status,result:final.result,error:final.error},revision)
}

/** Caller holds the Session/Turn locks; the final result, its pair and the mirror commit together. */
async function recordToolResultRow(client: AgentCoreClient, scope: AgentTurnScope, input: AgentToolResultInput): Promise<AgentToolResultRecord> {
  const tool=req((await client.query(`SELECT * FROM agent_tool_calls WHERE id=$3 AND session_id=$1 AND turn_id=$2 FOR UPDATE`,[input.sessionId,input.turnId,input.toolCallId])).rows[0])
  const exists=(await client.query(`SELECT id FROM agent_items WHERE tool_call_id=$1 AND item_type='tool_result'`,[input.toolCallId])).rows.length>0
  if (exists) return {recorded:false,finalResult:true}
  // An already final row keeps its stored truth; only its missing pair is projected.
  const final: AgentFinalToolResult = finalToolStatus(tool.status)
    ? { status:tool.status, result:tool.result, error:tool.error }
    : { status:input.status, result:input.result, error:input.error }
  if (!finalToolStatus(tool.status)) {
    await client.query(`UPDATE agent_tool_calls SET status=$4,result=$5::jsonb,error=$6::jsonb,updated_at=clock_timestamp() WHERE id=$3 AND session_id=$1 AND turn_id=$2`,[input.sessionId,input.turnId,input.toolCallId,final.status,final.result ? JSON.stringify(final.result) : null,final.error ? JSON.stringify(final.error) : null])
    if (!await settleLinkedAgentMediaReservations(client,{id:tool.id,turn_id:input.turnId,session_id:input.sessionId})) await client.query(`WITH settled AS (
      UPDATE agent_budget_reservations SET status=CASE WHEN quota='concurrent_media_jobs' THEN 'released' ELSE 'settled' END,settled_at=clock_timestamp()
      WHERE session_id=$1 AND turn_id=$2 AND tool_call_id=$3 AND status='reserved' RETURNING *
    ) INSERT INTO agent_usage_entries(session_id,turn_id,reservation_id,settlement_key,usage_kind,amount,currency,details)
      SELECT session_id,turn_id,id,'reservation:'||id::text,'estimated',reserved_amount,currency,jsonb_build_object('quota',quota,'reason','tool_terminal_bound')
      FROM settled WHERE status='settled' ON CONFLICT(turn_id,settlement_key) DO NOTHING`,[input.sessionId,input.turnId,input.toolCallId])
  }
  const revision=req((await client.query(`SELECT revision::text FROM agent_turns WHERE session_id=$1 AND id=$2`,[input.sessionId,input.turnId])).rows[0]).revision
  return projectAgentFinalToolResult(client,scope,{id:tool.id,tool_name:tool.tool_name,status:final.status,result:final.result,error:final.error,provider_call_id:tool.provider_call_id},revision)
}

/** Caller already holds Session/Turn locks; this never performs settlement. */
export async function queueAgentTurnIfDependenciesTerminal(client: AgentCoreClient, scope: AgentTurnScope): Promise<AgentWakeIntent|null> {
  const result=await client.query(`UPDATE agent_turns t SET status='queued',revision=revision+1,updated_at=clock_timestamp() FROM agent_sessions s WHERE t.id=$3 AND t.session_id=$2 AND s.id=t.session_id AND s.owner_id=$1 AND s.active_turn_id=t.id AND t.status IN ('waiting_tools','waiting_approval') AND t.cancel_requested_at IS NULL AND clock_timestamp()<t.deadline_at AND EXISTS(SELECT 1 FROM agent_tool_calls x WHERE x.turn_id=t.id) AND NOT EXISTS(SELECT 1 FROM agent_tool_calls x WHERE x.turn_id=t.id AND (x.status NOT IN ('completed','failed','cancelled','skipped') OR NOT EXISTS(SELECT 1 FROM agent_items i WHERE i.tool_call_id=x.id AND i.item_type='tool_result'))) AND NOT EXISTS(SELECT 1 FROM agent_approvals a WHERE a.turn_id=t.id AND a.status='pending') AND NOT EXISTS(SELECT 1 FROM agent_budget_reservations b WHERE b.turn_id=t.id AND b.status IN ('reserved','unknown')) RETURNING t.*`,[scope.ownerId,scope.sessionId,scope.turnId])
  if (!result.rows[0]) return null
  const dto=agentTurnDTO(result.rows[0]);await event(client,scope,'turn.updated',{turn:dto as unknown as JsonObject})
  const wake={sessionId:scope.sessionId,turnId:scope.turnId,revision:dto.revision}
  await client.query(`INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key) VALUES('agent.turn.wake',$1,$2::jsonb,$3) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,[scope.turnId,JSON.stringify({schemaVersion:1,...wake}),`agent:${scope.turnId}:${dto.revision}`])
  return wake
}

export function createAgentExecutionRepository(): AgentExecutionRepository {
  return {
    async loadExecutionState(client,scope) {
      const value = req((await client.query(`SELECT t.* FROM agent_turns t JOIN agent_sessions s ON s.id=t.session_id WHERE s.owner_id=$1 AND s.id=$2 AND t.id=$3`,[scope.ownerId,scope.sessionId,scope.turnId])).rows[0])
      const rows = (await client.query(`SELECT * FROM agent_items WHERE session_id=$1 AND turn_id=$2 ORDER BY sequence`,[scope.sessionId,scope.turnId])).rows
      const tools = (await client.query(`SELECT x.* FROM agent_tool_calls x JOIN agent_model_rounds r ON r.id=x.round_id WHERE x.session_id=$1 AND x.turn_id=$2 AND x.status NOT IN ('completed','failed','cancelled','skipped') ORDER BY r.position,x.position`,[scope.sessionId,scope.turnId])).rows
      const rounds = (await client.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE status IN ('running','recorded'))::int AS running FROM agent_model_rounds WHERE session_id=$1 AND turn_id=$2`,[scope.sessionId,scope.turnId])).rows[0]
      return { turn: agentTurnDTO(value), config: value.config_snapshot, budget: value.budget_snapshot, items: rows.map(agentItemDTO), pendingToolCalls: tools.map(x => ({ id:x.id,sessionId:x.session_id,turnId:x.turn_id,roundId:x.round_id,position:x.position,providerCallId:x.provider_call_id,toolName:x.tool_name,toolSchemaVersion:x.tool_schema_version,arguments:x.arguments,argumentsHash:x.arguments_hash,status:x.status,result:x.result,error:x.error })), nextRoundPosition:Number(rounds.total)+1, runningRounds:Number(rounds.running) }
    },
    appendAssistantItem: (client,input) => appendAgentExecutionItem(client,input.scope,'assistant_message',{ content:input.content,...(input.toolCallIds?.length ? { toolCallIds:input.toolCallIds } : {}) },null),
    appendToolCallItem: (client,input) => appendAgentExecutionItem(client,input.scope,'tool_call',{ providerCallId:input.providerCallId,toolName:input.toolName,toolSchemaVersion:input.toolSchemaVersion,arguments:input.arguments },input.toolCallId),
    async recordToolResult(client,input) {
      const lookup = req((await client.query(`SELECT s.owner_id FROM agent_sessions s JOIN agent_turns t ON t.session_id=s.id WHERE s.id=$1 AND t.id=$2`,[input.sessionId,input.turnId])).rows[0])
      const scope={ownerId:lookup.owner_id,sessionId:input.sessionId,turnId:input.turnId}
      await lockAgentExecutionScope(client,scope)
      return recordToolResultRow(client,scope,input)
    },
    async queueIfDependenciesTerminal(client,scope) {
      await lockAgentExecutionScope(client,scope)
      return queueAgentTurnIfDependenciesTerminal(client,scope)
    },
  }
}

/** Media settlement also follows the control plane lock order, including a disabled owner. */
export async function lockAgentExecutionScope(client: AgentCoreClient, scope: AgentTurnScope): Promise<void> {
  req((await client.query(`SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE`,[scope.ownerId])).rows[0])
  req((await client.query(`SELECT id FROM agent_sessions WHERE owner_id=$1 AND id=$2 FOR UPDATE`,[scope.ownerId,scope.sessionId])).rows[0])
  req((await client.query(`SELECT id FROM agent_turns WHERE session_id=$1 AND id=$2 FOR UPDATE`,[scope.sessionId,scope.turnId])).rows[0])
}
