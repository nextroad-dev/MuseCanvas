import type pg from 'pg'
import type {
  AgentApprovalDTO, AgentApprovalSummaryDTO, AgentDecimal, AgentEventEnvelope, AgentEventsPageDTO,
  AgentItemDTO, AgentItemsPageDTO, AgentMessageAcceptedDTO, AgentSessionDTO, AgentSessionSnapshotDTO,
  AgentSessionsPageDTO, AgentToolSummaryDTO, AgentTurnDTO, CreateAgentMessageRequest,
  CreateAgentSessionRequest, ResolveAgentApprovalRequest, JsonObject, AgentBudgetDTO,
} from '@musecanvas/contracts'
import { canvasAgentRequestDigest } from './canvas-agent'

export type AgentCoreClient = Pick<pg.PoolClient, 'query'>
export type AgentCoreTransaction = <T>(work: (client: AgentCoreClient) => Promise<T>, readOnly?: boolean) => Promise<T>
// Rows never leave this module. DTO projections below are explicit allowlists.
type Row = Record<string, any>
export class AgentCoreError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'UNAVAILABLE' | 'CURSOR_AHEAD' | 'INVALID_INPUT') { super(code) }
}
export interface AgentAdmissionSnapshot { config: JsonObject; budget: Omit<AgentBudgetDTO, 'deadlineAt'>; timeoutMs: number }
export type AgentDefinitionValidator = (client: AgentCoreClient, definition: Row) => Promise<AgentAdmissionSnapshot>
const decimal = (value: unknown) => String(value) as AgentDecimal
const iso = (value: any): string => value instanceof Date ? value.toISOString() : String(value)
const nullableTime = (value: any) => value == null ? null : iso(value)
const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status)
function required<T>(value: T | undefined | null): T { if (value == null) throw new AgentCoreError('NOT_FOUND'); return value }
function bound(limit: number) { if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AgentCoreError('INVALID_INPUT') }
export function agentCoreDecimal(value: string): AgentDecimal {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) throw new AgentCoreError('INVALID_INPUT')
  return value as AgentDecimal
}
export function agentSessionDTO(r: Row): AgentSessionDTO {
  return { id: r.id, ownerId: r.owner_id, agentDefinitionId: r.agent_definition_id, definitionVersion: r.definition_version,
    defaultCanvasId: r.default_canvas_id, activeTurnId: r.active_turn_id, inputRevision: decimal(r.input_revision),
    nextItemSequence: decimal(r.next_item_sequence), nextEventCursor: decimal(r.next_event_cursor),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), archivedAt: nullableTime(r.archived_at) }
}
export function agentTurnDTO(r: Row): AgentTurnDTO {
  return { id: r.id, sessionId: r.session_id, status: r.status, engineVersion: r.engine_version,
    revision: decimal(r.revision), inputRevision: decimal(r.input_revision), cancelRequestedAt: nullableTime(r.cancel_requested_at),
    terminalAt: nullableTime(r.terminal_at), deadlineAt: iso(r.deadline_at),
    error: r.error ? { code: 'TOOL_FAILED', message: 'Agent turn failed', retryable: false } : null }
}
/** Only public display text is admitted. Tool arguments/results, URLs and arbitrary JSON never pass through. */
function displayPayload(value: Row): JsonObject {
  const output: JsonObject = {}
  for (const key of ['content', 'message']) if (typeof value?.[key] === 'string') output[key] = value[key].slice(0, 32000)
  return output
}
export function agentItemDTO(r: Row): AgentItemDTO {
  return { id: r.id, sessionId: r.session_id, turnId: r.turn_id, sequence: decimal(r.sequence), type: r.item_type,
    toolCallId: r.tool_call_id, payload: displayPayload(r.payload), createdAt: iso(r.created_at) }
}
function approvalDTO(r: Row): AgentApprovalDTO {
  return { id: r.id, sessionId: r.session_id, turnId: r.turn_id, toolCallId: r.tool_call_id, argumentsHash: r.arguments_hash,
    modelRevision: r.model_revision, pricingRevision: r.pricing_revision, reservationId: r.reservation_id, status: r.status,
    expiresAt: iso(r.expires_at), resolvedBy: r.resolved_by, resolvedAt: nullableTime(r.resolved_at) }
}
function toolSummary(r: Row): AgentToolSummaryDTO {
  return { id: r.id, turnId: r.turn_id, toolName: r.tool_name, status: r.status, revision: decimal(r.revision) }
}
/** Re-project stored camelCase display DTOs; a future broad SQL row insert cannot expose config/leases. */
function publicEvent(r: Row): AgentEventEnvelope {
  const base = { schemaVersion: 1 as const, eventId: r.id, sessionId: r.session_id, turnId: r.turn_id,
    createdAt: iso(r.created_at), cursor: decimal(r.cursor), itemSequence: r.item_sequence == null ? null : decimal(r.item_sequence),
    entityRevision: r.entity_revision == null ? null : decimal(r.entity_revision) }
  const p = r.payload
  if (r.event_type === 'item.created') {
    const i = p.item
    return { ...base, type: 'item.created', payload: { item: agentItemDTO({ id: i.id, session_id: i.sessionId,
      turn_id: i.turnId, sequence: i.sequence, item_type: i.type, tool_call_id: i.toolCallId, payload: i.payload, created_at: i.createdAt }) } }
  }
  if (r.event_type === 'turn.updated') {
    const t = p.turn
    return { ...base, type: 'turn.updated', payload: { turn: agentTurnDTO({ id: t.id, session_id: t.sessionId, status: t.status,
      engine_version: t.engineVersion, revision: t.revision, input_revision: t.inputRevision, cancel_requested_at: t.cancelRequestedAt,
      terminal_at: t.terminalAt, deadline_at: t.deadlineAt, error: t.error }) } }
  }
  if (r.event_type === 'tool.updated') {
    const t = p.tool
    return { ...base, type: 'tool.updated', payload: { tool: { id: t.id, turnId: t.turnId, toolName: t.toolName, status: t.status, revision: decimal(t.revision) } } }
  }
  if (r.event_type === 'approval.required') {
    const a = p.approval
    return { ...base, type: 'approval.required', payload: { approval: { ...approvalDTO({ id: a.id, session_id: a.sessionId,
      turn_id: a.turnId, tool_call_id: a.toolCallId, arguments_hash: a.argumentsHash, model_revision: a.modelRevision,
      pricing_revision: a.pricingRevision, reservation_id: a.reservationId, status: a.status, expires_at: a.expiresAt,
      resolved_by: a.resolvedBy, resolved_at: a.resolvedAt }), revision: decimal(a.revision) } } }
  }
  throw new AgentCoreError('UNAVAILABLE')
}
async function one(c: AgentCoreClient, sql: string, args: unknown[] = []): Promise<Row | undefined> { return (await c.query(sql, args)).rows[0] }
async function actorLock(c: AgentCoreClient, owner: string) {
  // Serialize actor changes without blocking audit/owner FK key-share locks.
  required(await one(c, "SELECT id FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL FOR NO KEY UPDATE", [owner]))
}
async function session(c: AgentCoreClient, owner: string, id: string, lock = false) {
  return required(await one(c, `SELECT * FROM agent_sessions WHERE owner_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [owner, id]))
}
async function turn(c: AgentCoreClient, owner: string, id: string, lock = false) {
  return required(await one(c, `SELECT t.* FROM agent_turns t JOIN agent_sessions s ON s.id=t.session_id
    WHERE s.owner_id=$1 AND t.id=$2${lock ? ' FOR UPDATE OF t' : ''}`, [owner, id]))
}
async function lockTurn(c: AgentCoreClient, owner: string, id: string) {
  const lookup = await turn(c, owner, id)
  const s = await session(c, owner, lookup.session_id, true)
  return { s, t: await turn(c, owner, id, true) }
}
async function definition(c: AgentCoreClient, owner: string, id: string, version: number) {
  const d = await one(c, `SELECT id,owner_id,version,model_policy,instructions,tool_allowlist,budget_policy FROM agent_definitions
    WHERE id=$1 AND version=$2 AND status='active' AND (owner_id IS NULL OR owner_id=$3) FOR SHARE`, [id, version, owner])
  if (!d) throw new AgentCoreError('UNAVAILABLE')
  return d
}
async function wake(c: AgentCoreClient, t: Row) {
  await c.query(`INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key)
    VALUES('agent.turn.wake',$1,$2::jsonb,$3) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
  [t.id, JSON.stringify({ schemaVersion: 1, sessionId: t.session_id, turnId: t.id, revision: decimal(t.revision) }), `agent:${t.id}:${t.revision}`])
}
async function event(c: AgentCoreClient, s: Row, t: Row, type: AgentEventEnvelope['type'], payload: object, itemSequence: string | null = null) {
  const counter = required(await one(c, `UPDATE agent_sessions SET next_event_cursor=next_event_cursor+1,updated_at=clock_timestamp()
    WHERE id=$1 AND owner_id=$2 RETURNING (next_event_cursor-1)::text AS cursor`, [s.id, s.owner_id]))
  await c.query(`INSERT INTO agent_session_events(session_id,turn_id,cursor,entity_revision,item_sequence,event_type,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [s.id, t.id, counter.cursor, t.revision, itemSequence, type, JSON.stringify(payload)])
}
async function itemPage(c: AgentCoreClient, s: Row, after: string, limit: number): Promise<AgentItemsPageDTO> {
  const rows = (await c.query(`SELECT * FROM agent_items WHERE session_id=$1 AND sequence>$2 AND sequence<$3 ORDER BY sequence LIMIT $4`,
    [s.id, after, s.next_item_sequence, limit + 1])).rows
  const items = rows.slice(0, limit).map(agentItemDTO)
  return { items, nextCursor: items.at(-1)?.sequence ?? decimal(after), hasMore: rows.length > limit,
    lastItemSequence: decimal(BigInt(s.next_item_sequence) - 1n) }
}

/** All mutations own a short transaction. Lock order: actor -> Session -> Turn -> Tool -> Approval -> Reservation.
 * Read transactions must use REPEATABLE READ READ ONLY; never hold a connection while SSE waits. */
export class AgentCoreRepository {
  constructor(private readonly tx: AgentCoreTransaction, private readonly validate: AgentDefinitionValidator) {}
  createSession(owner: string, input: CreateAgentSessionRequest, admit = true): Promise<AgentSessionDTO> {
    return this.tx(async c => {
      await actorLock(c, owner)
      const digest = canvasAgentRequestDigest({ agentDefinitionId: input.agentDefinitionId, definitionVersion: input.definitionVersion, defaultCanvasId: input.defaultCanvasId ?? null })
      const receipt = await one(c, 'SELECT request_digest,accepted_response FROM agent_session_requests WHERE owner_id=$1 AND client_request_key=$2', [owner, input.clientRequestId])
      if (receipt) { if (receipt.request_digest !== digest) throw new AgentCoreError('CONFLICT'); return receipt.accepted_response }
      if (!admit) throw new AgentCoreError('UNAVAILABLE')
      await this.validate(c, await definition(c, owner, input.agentDefinitionId, input.definitionVersion))
      if (input.defaultCanvasId) required(await one(c, 'SELECT id FROM canvas_documents WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL FOR SHARE', [input.defaultCanvasId, owner]))
      const s = required(await one(c, `INSERT INTO agent_sessions(owner_id,agent_definition_id,definition_version,default_canvas_id)
        VALUES($1,$2,$3,$4) RETURNING *`, [owner, input.agentDefinitionId, input.definitionVersion, input.defaultCanvasId ?? null]))
      const dto = agentSessionDTO(s)
      await c.query(`INSERT INTO agent_session_requests(owner_id,client_request_key,request_digest,session_id,accepted_response)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [owner, input.clientRequestId, digest, s.id, JSON.stringify(dto)])
      return dto
    })
  }
  listSessions(owner: string, limit: number, after?: string): Promise<AgentSessionsPageDTO> {
    bound(limit)
    return this.tx(async c => {
      if (after) await session(c, owner, after)
      const rows = (await c.query(`SELECT * FROM agent_sessions WHERE owner_id=$1
        AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM agent_sessions WHERE id=$2 AND owner_id=$1))
        ORDER BY created_at DESC,id DESC LIMIT $3`,
      [owner, after ?? null, limit + 1])).rows
      const sessions = rows.slice(0, limit).map(agentSessionDTO)
      return { sessions, nextCursor: rows.length > limit ? sessions.at(-1)!.id : null }
    }, true)
  }
  snapshot(owner: string, id: string, limit: number): Promise<AgentSessionSnapshotDTO> {
    bound(limit)
    return this.tx(async c => {
      const s = await session(c, owner, id)
      const t = s.active_turn_id ? await turn(c, owner, s.active_turn_id) : null
      const page = await itemPage(c, s, '0', limit)
      const tools = t ? (await c.query(`SELECT x.id,x.turn_id,x.tool_name,x.status,t.revision FROM agent_tool_calls x JOIN agent_turns t ON t.id=x.turn_id
        WHERE x.session_id=$1 AND x.turn_id=$2 ORDER BY x.id LIMIT 1001`, [id, t.id])).rows : []
      const approvals = t ? (await c.query(`SELECT a.*,t.revision FROM agent_approvals a JOIN agent_turns t ON t.id=a.turn_id
        WHERE a.session_id=$1 AND a.turn_id=$2 ORDER BY a.id LIMIT 1001`, [id, t.id])).rows : []
      if (tools.length > 1000 || approvals.length > 1000) throw new AgentCoreError('UNAVAILABLE')
      return { session: agentSessionDTO(s), activeTurn: t ? agentTurnDTO(t) : null, items: page.items,
        eventCursor: decimal(BigInt(s.next_event_cursor) - 1n), lastItemSequence: page.lastItemSequence,
        itemsHasMore: page.hasMore, nextItemsCursor: page.nextCursor, tools: tools.map(toolSummary),
        approvals: approvals.map(a => ({ ...approvalDTO(a), revision: decimal(a.decision_revision ?? a.revision) })),
        summariesTruncated: false }
    }, true)
  }
  items(owner: string, id: string, after: string, limit: number): Promise<AgentItemsPageDTO> {
    bound(limit); agentCoreDecimal(after)
    return this.tx(async c => {
      const s = await session(c, owner, id)
      if (BigInt(after) >= BigInt(s.next_item_sequence)) throw new AgentCoreError('CURSOR_AHEAD')
      return itemPage(c, s, after, limit)
    }, true)
  }
  events(owner: string, id: string, after: string, limit: number): Promise<AgentEventsPageDTO> {
    bound(limit); agentCoreDecimal(after)
    return this.tx(async c => {
      const s = await session(c, owner, id)
      const high = BigInt(s.next_event_cursor) - 1n, floor = BigInt(s.event_retention_floor)
      if (BigInt(after) > high) throw new AgentCoreError('CURSOR_AHEAD')
      const rows = BigInt(after) < floor ? [] : (await c.query(`SELECT * FROM agent_session_events
        WHERE session_id=$1 AND cursor>$2 AND cursor<=$3 ORDER BY cursor LIMIT $4`, [id, after, high.toString(), limit + 1])).rows
      let expected = BigInt(after) + 1n
      const gap = rows.some(r => BigInt(r.cursor) !== expected++) || (!rows.length && BigInt(after) < high)
      const resync = BigInt(after) < floor || gap
      return { events: resync ? [] : rows.slice(0, limit).map(publicEvent), highWater: decimal(high), retentionFloor: decimal(floor),
        hasMore: rows.length > limit, resyncRequired: resync }
    }, true)
  }
  getTurn(owner: string, id: string): Promise<AgentTurnDTO> { return this.tx(async c => agentTurnDTO(await turn(c, owner, id)), true) }
  message(owner: string, id: string, input: CreateAgentMessageRequest, admit = true, targetTurnId?: string): Promise<AgentMessageAcceptedDTO> {
    return this.tx(async c => {
      await actorLock(c, owner)
      const s = await session(c, owner, id, true)
      const digest = canvasAgentRequestDigest({ sessionId: id, content: input.content })
      const receipt = await one(c, 'SELECT request_digest,accepted_response,turn_id FROM agent_message_receipts WHERE session_id=$1 AND client_message_id=$2', [id, input.clientMessageId])
      if (receipt) {
        if (receipt.request_digest !== digest || (targetTurnId && receipt.turn_id !== targetTurnId)) throw new AgentCoreError('CONFLICT')
        return receipt.accepted_response
      }
      if (s.archived_at) throw new AgentCoreError('CONFLICT')
      let t = s.active_turn_id ? await turn(c, owner, s.active_turn_id, true) : undefined
      if (targetTurnId && (!t || t.id !== targetTurnId)) throw new AgentCoreError('CONFLICT')
      if (t?.cancel_requested_at || (t && terminal(t.status))) throw new AgentCoreError('CONFLICT')
      if (!t && !admit) throw new AgentCoreError('UNAVAILABLE')
      let config: AgentAdmissionSnapshot | undefined
      if (!t) config = await this.validate(c, await definition(c, owner, s.agent_definition_id, s.definition_version))
      const counters = required(await one(c, `UPDATE agent_sessions SET input_revision=input_revision+1,next_item_sequence=next_item_sequence+1,updated_at=clock_timestamp()
        WHERE id=$1 AND owner_id=$2 RETURNING input_revision::text,(next_item_sequence-1)::text AS sequence`, [id, owner]))
      if (!t) {
        t = required(await one(c, `WITH deadline AS (SELECT clock_timestamp()+$6*interval '1 millisecond' AS at)
          INSERT INTO agent_turns(session_id,client_idempotency_key,request_digest,status,config_snapshot,budget_snapshot,engine_version,input_revision,deadline_at)
          SELECT $1,$2,$3,'queued',$4::jsonb,$5::jsonb || jsonb_build_object('deadlineAt',at),'agent-core-v1',$7,at FROM deadline RETURNING *`,
        [id, input.clientMessageId, digest, JSON.stringify(config!.config), JSON.stringify(config!.budget), config!.timeoutMs, counters.input_revision]))
        await c.query('UPDATE agent_sessions SET active_turn_id=$3 WHERE id=$1 AND owner_id=$2', [id, owner, t.id])
      } else {
        t = required(await one(c, `UPDATE agent_turns SET input_revision=$3,revision=revision+1,updated_at=clock_timestamp()
          WHERE id=$1 AND session_id=$2 RETURNING *`, [t.id, id, counters.input_revision]))
      }
      const i = required(await one(c, `INSERT INTO agent_items(session_id,turn_id,sequence,item_type,payload,content_digest)
        VALUES($1,$2,$3,'user_message',$4::jsonb,$5) RETURNING *`, [id, t.id, counters.sequence, JSON.stringify({ content: input.content }), digest]))
      await event(c, s, t, 'item.created', { item: agentItemDTO(i) }, counters.sequence)
      await event(c, s, t, 'turn.updated', { turn: agentTurnDTO(t) })
      await wake(c, t)
      const accepted = { turn: agentTurnDTO(t), acceptedInputRevision: decimal(counters.input_revision) }
      await c.query(`INSERT INTO agent_message_receipts(session_id,client_message_id,request_digest,turn_id,item_id,accepted_input_revision,accepted_response)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [id, input.clientMessageId, digest, t.id, i.id, counters.input_revision, JSON.stringify(accepted)])
      return accepted
    })
  }
  async steer(owner: string, turnId: string, input: CreateAgentMessageRequest): Promise<AgentMessageAcceptedDTO> {
    const t = await this.getTurn(owner, turnId)
    return this.message(owner, t.sessionId, input, false, turnId)
  }
  cancel(owner: string, id: string): Promise<AgentTurnDTO> {
    return this.tx(async c => {
      await actorLock(c, owner)
      const { s, t: prior } = await lockTurn(c, owner, id)
      if (terminal(prior.status) || prior.cancel_requested_at) return agentTurnDTO(prior)
      // Only known settled dependencies permit local completion. Unknown/retained state belongs to the future Runner.
      const tools = (await c.query('SELECT id,status FROM agent_tool_calls WHERE turn_id=$1 AND session_id=$2 ORDER BY id FOR UPDATE', [id, s.id])).rows
      const approvals = (await c.query('SELECT id,status FROM agent_approvals WHERE turn_id=$1 AND session_id=$2 ORDER BY id FOR UPDATE', [id, s.id])).rows
      const reservations = (await c.query('SELECT id,status FROM agent_budget_reservations WHERE turn_id=$1 AND session_id=$2 ORDER BY id FOR UPDATE', [id, s.id])).rows
      const local = ['queued', 'waiting_tools', 'waiting_approval'].includes(prior.status) && prior.lease_owner == null && prior.lease_until == null
        && tools.every(x => ['completed', 'failed', 'skipped', 'cancelled'].includes(x.status))
        && approvals.every(x => ['approved', 'rejected', 'expired'].includes(x.status))
        && reservations.every(x => ['settled', 'released'].includes(x.status))
      const t = required(await one(c, `UPDATE agent_turns SET cancel_requested_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp(),
        status=CASE WHEN $3 THEN 'cancelled' ELSE status END,terminal_at=CASE WHEN $3 THEN clock_timestamp() ELSE terminal_at END
        WHERE id=$1 AND session_id=$2 RETURNING *`, [id, s.id, local]))
      if (local) await c.query('UPDATE agent_sessions SET active_turn_id=NULL WHERE id=$1 AND owner_id=$2 AND active_turn_id=$3', [s.id, owner, id])
      await event(c, s, t, 'turn.updated', { turn: agentTurnDTO(t) })
      if (!local) await wake(c, t)
      return agentTurnDTO(t)
    })
  }
  resolveApproval(owner: string, id: string, input: ResolveAgentApprovalRequest): Promise<{ approval: AgentApprovalSummaryDTO; expired: boolean }> {
    return this.tx(async c => {
      await actorLock(c, owner)
      const lookup = required(await one(c, `SELECT a.turn_id,a.tool_call_id FROM agent_approvals a JOIN agent_sessions s ON s.id=a.session_id
        WHERE s.owner_id=$1 AND a.id=$2`, [owner, id]))
      const { s, t: prior } = await lockTurn(c, owner, lookup.turn_id)
      const tool = required(await one(c, 'SELECT * FROM agent_tool_calls WHERE id=$1 AND turn_id=$2 AND session_id=$3 FOR UPDATE', [lookup.tool_call_id, prior.id, s.id]))
      let a = required(await one(c, 'SELECT *,expires_at<=clock_timestamp() AS expired FROM agent_approvals WHERE id=$1 AND turn_id=$2 AND session_id=$3 FOR UPDATE', [id, prior.id, s.id]))
      if (a.arguments_hash !== input.expectedArgumentsHash || tool.arguments_hash !== input.expectedArgumentsHash) throw new AgentCoreError('CONFLICT')
      if (a.status !== 'pending') {
        if (a.status !== input.decision && a.status !== 'expired') throw new AgentCoreError('CONFLICT')
        return { approval: { ...approvalDTO(a), revision: decimal(a.decision_revision ?? prior.revision) }, expired: a.status === 'expired' }
      }
      if (terminal(prior.status) || prior.cancel_requested_at || s.active_turn_id !== prior.id) throw new AgentCoreError('CONFLICT')
      const reservation = required(await one(c, `SELECT * FROM agent_budget_reservations WHERE id=$1 AND tool_call_id=$2 AND turn_id=$3 AND session_id=$4 FOR UPDATE`, [a.reservation_id, tool.id, prior.id, s.id]))
      if (canvasAgentRequestDigest(tool.arguments) !== tool.arguments_hash || tool.status !== 'waiting_approval' || reservation.status !== 'reserved' || reservation.pricing_revision !== a.pricing_revision
        || prior.config_snapshot.modelRevisionId !== a.model_revision) throw new AgentCoreError('CONFLICT')
      a = required(await one(c, `WITH decision_time AS (SELECT clock_timestamp() AS at)
        UPDATE agent_approvals SET status=CASE WHEN expires_at<=decision_time.at THEN 'expired' ELSE $4 END,
        resolved_by=CASE WHEN expires_at<=decision_time.at THEN NULL ELSE $5::uuid END,resolved_at=decision_time.at,decision_revision=$6
        FROM decision_time WHERE id=$1 AND turn_id=$2 AND session_id=$3 RETURNING agent_approvals.*`,
      [id, prior.id, s.id, input.decision, owner, (BigInt(prior.revision) + 1n).toString()]))
      const t = required(await one(c, 'UPDATE agent_turns SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND session_id=$2 RETURNING *', [prior.id, s.id]))
      const dto = { ...approvalDTO(a), revision: decimal(a.decision_revision ?? t.revision) }
      await event(c, s, t, 'approval.required', { approval: dto })
      await event(c, s, t, 'turn.updated', { turn: agentTurnDTO(t) })
      // Decision is durable intent only. Never queue the turn or execute a subset of a tool round here.
      await wake(c, t)
      return { approval: dto, expired: a.status === 'expired' }
    })
  }
}
