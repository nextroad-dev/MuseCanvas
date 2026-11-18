import type { AgentDecimal } from '@musecanvas/contracts'
import {
  AgentCoreError, agentCoreDecimal, agentTurnDTO, type AgentCoreClient, type AgentCoreTransaction,
} from './agent-core'
import { AgentRuntimeError } from './agent-runtime'
import { projectAgentFinalToolResult, queueAgentTurnIfDependenciesTerminal } from './agent-execution'

export type AgentRecoveryKind = 'deadline' | 'approval' | 'cancel' | 'lease' | 'media'
export interface AgentRecoveryOutcome {
  kind: AgentRecoveryKind
  processed: number
  remaining: boolean
}
export interface AgentOutboxBacklog {
  pending: number
  oldestAgeMs: number | null
  quarantined: number
}

type Row = Record<string, any>
type FinalToolRow = Parameters<typeof projectAgentFinalToolResult>[2]
const NON_TERMINAL_TURNS = "('queued','running','waiting_tools','waiting_approval')"
const LOCAL_TOOL_CALLS = "('recorded','validating','waiting_approval','executing')"
const TERMINAL_TOOL_CALLS = "('completed','failed','cancelled','skipped')"
const DEADLINE_ERROR = { code: 'DEADLINE_EXCEEDED', message: 'Agent turn deadline exceeded', retryable: false }
const APPROVAL_ERROR = { code: 'APPROVAL_EXPIRED', message: 'Agent approval expired', retryable: false }
const UNOBSERVED_MEDIA_ERROR = { code: 'TOOL_FAILED', message: 'Media outcome was not observed before the turn ended', retryable: false }
const json = (value: object) => JSON.stringify(value)

function bound(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new AgentRuntimeError('INVALID_INPUT')
}
function decimal(value: unknown): AgentDecimal { return agentCoreDecimal(String(value)) }

/** Allocate the next Session cursor exactly like AgentCoreRepository.event. */
async function event(c: AgentCoreClient, sessionId: string, turn: Row, type: 'tool.updated' | 'turn.updated' | 'approval.required', payload: object) {
  const counter = (await c.query<{ cursor: string }>(`UPDATE agent_sessions SET next_event_cursor=next_event_cursor+1,updated_at=clock_timestamp()
    WHERE id=$1 RETURNING (next_event_cursor-1)::text AS cursor`, [sessionId])).rows[0]
  if (!counter) throw new AgentCoreError('UNAVAILABLE')
  await c.query(`INSERT INTO agent_session_events(session_id,turn_id,cursor,entity_revision,event_type,payload)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
  [sessionId, turn.id, counter.cursor, turn.revision, type, json(payload)])
}
function approvalProjection(approval: Row) {
  const iso=(value: unknown)=>value instanceof Date?value.toISOString():String(value)
  return {approval:{id:approval.id,sessionId:approval.session_id,turnId:approval.turn_id,toolCallId:approval.tool_call_id,
    argumentsHash:approval.arguments_hash,modelRevision:approval.model_revision,pricingRevision:approval.pricing_revision,reservationId:approval.reservation_id,
    status:approval.status,expiresAt:iso(approval.expires_at),resolvedBy:approval.resolved_by??null,resolvedAt:iso(approval.resolved_at),revision:decimal(approval.decision_revision)}}
}
/** Admitted model intents cannot prove non-submission; retain their upper bound. */
async function settleInterruptedModel(c: AgentCoreClient, turn: Row, reason: string) {
  await c.query(`WITH uncertain AS (
    UPDATE agent_budget_reservations r SET status='unknown',settled_at=clock_timestamp()
    WHERE r.turn_id=$1 AND r.session_id=$2 AND r.status='reserved' AND r.tool_call_id IS NULL AND r.round_id IS NOT NULL
    RETURNING *
  ) INSERT INTO agent_usage_entries(session_id,turn_id,reservation_id,settlement_key,usage_kind,amount,currency,details)
    SELECT session_id,turn_id,id,'recovery:model:'||id::text,'unknown',reserved_amount,currency,jsonb_build_object('quota',quota,'reason',$3::text)
    FROM uncertain ON CONFLICT(turn_id,settlement_key) DO NOTHING`,[turn.id,turn.session_id,reason])
  await c.query(`UPDATE agent_model_rounds SET status='failed',completed_at=clock_timestamp()
    WHERE turn_id=$1 AND session_id=$2 AND status IN ('running','recorded')`,[turn.id,turn.session_id])
}
function wake(c: AgentCoreClient, turn: Row, dedupeKey: string) {
  return c.query(`INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key)
    VALUES('agent.turn.wake',$1,$2::jsonb,$3) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
  [turn.id, json({ schemaVersion: 1, sessionId: turn.session_id, turnId: turn.id, revision: decimal(turn.revision) }), dedupeKey])
}
/** Every writer follows actor -> Session -> Turn -> Tool -> Approval -> Reservation. */
async function lockSession(c: AgentCoreClient, sessionId: string): Promise<Row | undefined> {
  return (await c.query<Row>('SELECT * FROM agent_sessions WHERE id=$1 FOR UPDATE SKIP LOCKED', [sessionId])).rows[0]
}

/**
 * Coordinator persistence only: deadline/approval/cancel settlement and expired
 * lease wake re-emission. It never executes tools, consumes wakes or touches
 * media jobs. Each sweep is one caller-owned transaction; candidates are read
 * with a bounded LIMIT and then re-checked under Session -> Turn locks so
 * concurrent coordinators split work without stealing claims. Public
 * revision/event changes are committed together with their turn/tool
 * projections; private lease cleanup is not a public revision.
 */
export class AgentRecoveryRepository {
  constructor(private readonly tx: AgentCoreTransaction) {}

  expireDeadlines(limit: number): Promise<AgentRecoveryOutcome> {
    bound(limit)
    return this.tx(async c => {
      const candidates = (await c.query<Row>(`SELECT id,session_id FROM agent_turns t
        WHERE t.status IN ${NON_TERMINAL_TURNS} AND t.deadline_at<=clock_timestamp()
        ORDER BY t.deadline_at,t.id LIMIT $1`, [limit])).rows
      let processed = 0
      for (const candidate of candidates) {
        const session=await lockSession(c,candidate.session_id)
        if (!session) continue
        const turn = (await c.query<Row>(`SELECT * FROM agent_turns
          WHERE id=$1 AND session_id=$2 AND status IN ${NON_TERMINAL_TURNS}
            AND deadline_at<=clock_timestamp() FOR UPDATE SKIP LOCKED`,
        [candidate.id, candidate.session_id])).rows[0]
        if (!turn) continue
        const nextRevision = (BigInt(turn.revision) + 1n).toString()
        // Lock/update local tools before approvals so every writer follows the
        // shared Turn -> Tool -> Approval -> Reservation order used by resolve.
        const tools = (await c.query<Row & FinalToolRow>(`UPDATE agent_tool_calls SET status='failed',error=$3::jsonb,updated_at=clock_timestamp()
          WHERE turn_id=$1 AND session_id=$2 AND status IN ${LOCAL_TOOL_CALLS}
          RETURNING *`,
        [turn.id, turn.session_id, json(DEADLINE_ERROR)])).rows
        // A waiting_external row without a media job link is the raw mirror of a
        // proposal still in flight; the terminal turn can never observe it, so
        // it must become a paired failure instead of a dangling context entry.
        const unobservedMedia = (await c.query<Row & FinalToolRow>(`UPDATE agent_tool_calls x SET status='failed',error=$3::jsonb,updated_at=clock_timestamp()
          WHERE x.turn_id=$1 AND x.session_id=$2 AND x.status='waiting_external'
            AND NOT EXISTS (SELECT 1 FROM agent_tool_job_links l
              WHERE l.tool_call_id=x.id AND l.turn_id=x.turn_id AND l.session_id=x.session_id)
          RETURNING x.*`,
        [turn.id, turn.session_id, json(UNOBSERVED_MEDIA_ERROR)])).rows
        // Approval decisions freeze the Turn revision reached by this sweep.
        const decisions=(await c.query(`UPDATE agent_approvals SET status='expired',resolved_at=clock_timestamp(),decision_revision=$3
          WHERE turn_id=$1 AND session_id=$2 AND status='pending' RETURNING *`, [turn.id, turn.session_id, nextRevision])).rows
        // Media-owned reservations stay reserved until the media reconciler
        // settles real usage, even though the Turn is terminal.
        await c.query(`UPDATE agent_budget_reservations r SET status='released',settled_at=clock_timestamp()
          WHERE r.turn_id=$1 AND r.session_id=$2 AND r.status='reserved'
            AND ((r.tool_call_id IS NULL AND r.round_id IS NULL) OR EXISTS (SELECT 1 FROM agent_tool_calls x
              WHERE x.id=r.tool_call_id AND x.turn_id=r.turn_id AND x.session_id=r.session_id
                AND x.status IN ${TERMINAL_TOOL_CALLS}))`, [turn.id, turn.session_id])
        await settleInterruptedModel(c,turn,'deadline_model_outcome_unknown')
        // One UPDATE sets the terminal state, error, cleared lease and single
        // public revision so the turn guard sees a valid terminal transition.
        const updated = (await c.query<Row>(`UPDATE agent_turns SET status='failed',terminal_at=clock_timestamp(),error=$3::jsonb,
          lease_owner=NULL,lease_until=NULL,revision=revision+1,updated_at=clock_timestamp()
          WHERE id=$1 AND session_id=$2 AND status IN ${NON_TERMINAL_TURNS} RETURNING *`,
        [turn.id, turn.session_id, json(DEADLINE_ERROR)])).rows[0]
        if (!updated) continue
        await c.query(`UPDATE agent_sessions SET active_turn_id=NULL WHERE id=$1 AND active_turn_id=$2`, [turn.session_id, turn.id])
        for (const tool of [...tools, ...unobservedMedia]) await projectAgentFinalToolResult(c,{ownerId:session.owner_id,sessionId:updated.session_id,turnId:updated.id},tool,updated.revision)
        for (const decision of decisions) await event(c,updated.session_id,updated,'approval.required',approvalProjection(decision))
        await event(c, updated.session_id, updated, 'turn.updated', { turn: agentTurnDTO(updated) })
        processed++
      }
      return { kind: 'deadline', processed, remaining: candidates.length === limit }
    })
  }

  expireApprovals(limit: number): Promise<AgentRecoveryOutcome> {
    bound(limit)
    return this.tx(async c => {
      // Candidate rows are read without locks. Each row is then re-checked
      // under Session -> Turn -> Tool -> Approval locks, matching resolveApproval.
      const rows = (await c.query<Row>(`SELECT a.id,a.turn_id,a.session_id,a.tool_call_id,a.reservation_id
        FROM agent_approvals a
        JOIN agent_turns t ON t.id=a.turn_id AND t.session_id=a.session_id
        WHERE a.status='pending' AND a.expires_at<=clock_timestamp()
          AND t.status IN ${NON_TERMINAL_TURNS}
        ORDER BY a.expires_at,a.id LIMIT $1`, [limit])).rows
      let processed = 0
      for (const approval of rows) {
        const session=await lockSession(c,approval.session_id)
        if (!session) continue
        const turn = (await c.query<Row>(`SELECT * FROM agent_turns
          WHERE id=$1 AND session_id=$2 AND status IN ${NON_TERMINAL_TURNS} FOR UPDATE SKIP LOCKED`,
        [approval.turn_id, approval.session_id])).rows[0]
        if (!turn) continue
        const tool = (await c.query<Row>(`SELECT * FROM agent_tool_calls
          WHERE id=$1 AND turn_id=$2 AND session_id=$3 FOR UPDATE`,
        [approval.tool_call_id, approval.turn_id, approval.session_id])).rows[0]
        if (!tool) continue
        // The candidate read was unlocked; re-check under the approval lock.
        const current = (await c.query<Row>(`SELECT * FROM agent_approvals
          WHERE id=$1 AND turn_id=$2 AND session_id=$3 AND status='pending' AND expires_at<=clock_timestamp() FOR UPDATE`,
        [approval.id, approval.turn_id, approval.session_id])).rows[0]
        if (!current) continue
        const updated = (await c.query<Row>(`UPDATE agent_turns SET revision=revision+1,updated_at=clock_timestamp()
          WHERE id=$1 AND session_id=$2 AND status IN ${NON_TERMINAL_TURNS} RETURNING *`,
        [approval.turn_id, approval.session_id])).rows[0]
        if (!updated) continue
        const decision=(await c.query(`UPDATE agent_approvals SET status='expired',resolved_at=clock_timestamp(),decision_revision=$4
          WHERE id=$1 AND turn_id=$2 AND session_id=$3 AND status='pending' RETURNING *`,
        [approval.id, approval.turn_id, approval.session_id, updated.revision])).rows[0]
        const failedTool = (await c.query<Row & FinalToolRow>(`UPDATE agent_tool_calls SET status='failed',error=$4::jsonb,updated_at=clock_timestamp()
          WHERE id=$1 AND turn_id=$2 AND session_id=$3 AND status='waiting_approval'
          RETURNING *`,
        [approval.tool_call_id, approval.turn_id, approval.session_id, json(APPROVAL_ERROR)])).rows[0]
        await c.query(`UPDATE agent_budget_reservations SET status='released',settled_at=clock_timestamp()
          WHERE id=$1 AND turn_id=$2 AND session_id=$3 AND status='reserved'`,
        [approval.reservation_id, approval.turn_id, approval.session_id])
        if (failedTool) await projectAgentFinalToolResult(c,{ownerId:session.owner_id,sessionId:updated.session_id,turnId:updated.id},failedTool,updated.revision)
        if (decision) await event(c,updated.session_id,updated,'approval.required',approvalProjection(decision))
        await event(c, updated.session_id, updated, 'turn.updated', { turn: agentTurnDTO(updated) })
        processed++
        await queueAgentTurnIfDependenciesTerminal(c,{ownerId:session.owner_id,sessionId:updated.session_id,turnId:updated.id})
      }
      return { kind: 'approval', processed, remaining: rows.length === limit }
    })
  }

  finalizeCancellations(limit: number): Promise<AgentRecoveryOutcome> {
    bound(limit)
    return this.tx(async c => {
      const candidates = (await c.query<Row>(`SELECT id,session_id FROM agent_turns t
        WHERE t.status IN ${NON_TERMINAL_TURNS} AND t.cancel_requested_at IS NOT NULL
          AND (t.lease_owner IS NULL OR t.lease_until<=clock_timestamp())
        ORDER BY t.cancel_requested_at,t.id LIMIT $1`, [limit])).rows
      let processed = 0
      for (const candidate of candidates) {
        const session=await lockSession(c,candidate.session_id)
        if (!session) continue
        const turn = (await c.query<Row>(`SELECT * FROM agent_turns
          WHERE id=$1 AND session_id=$2 AND status IN ${NON_TERMINAL_TURNS}
            AND cancel_requested_at IS NOT NULL
            AND (lease_owner IS NULL OR lease_until<=clock_timestamp()) FOR UPDATE SKIP LOCKED`,
        [candidate.id, candidate.session_id])).rows[0]
        if (!turn) continue
        const nextRevision = (BigInt(turn.revision) + 1n).toString()
        // Tool before Approval keeps the shared lock order.
        const tools = (await c.query<Row & FinalToolRow>(`UPDATE agent_tool_calls SET status='cancelled',error=$3::jsonb,updated_at=clock_timestamp()
          WHERE turn_id=$1 AND session_id=$2 AND status IN ${LOCAL_TOOL_CALLS}
          RETURNING *`, [turn.id, turn.session_id,json({code:'TOOL_FAILED',message:'Agent tool cancelled',retryable:false})])).rows
        // Same rule as the deadline sweep: an unlinked waiting_external mirror
        // cannot outlive the cancelled turn, while a linked row keeps its job.
        const unobservedMedia = (await c.query<Row & FinalToolRow>(`UPDATE agent_tool_calls x SET status='failed',error=$3::jsonb,updated_at=clock_timestamp()
          WHERE x.turn_id=$1 AND x.session_id=$2 AND x.status='waiting_external'
            AND NOT EXISTS (SELECT 1 FROM agent_tool_job_links l
              WHERE l.tool_call_id=x.id AND l.turn_id=x.turn_id AND l.session_id=x.session_id)
          RETURNING x.*`,
        [turn.id, turn.session_id, json(UNOBSERVED_MEDIA_ERROR)])).rows
        const decisions=(await c.query(`UPDATE agent_approvals SET status='expired',resolved_at=clock_timestamp(),decision_revision=$3
          WHERE turn_id=$1 AND session_id=$2 AND status='pending' RETURNING *`, [turn.id, turn.session_id, nextRevision])).rows
        // Media-owned reservations stay reserved until the media reconciler
        // settles them; only linked waiting_external tools keep waiting.
        await c.query(`UPDATE agent_budget_reservations r SET status='released',settled_at=clock_timestamp()
          WHERE r.turn_id=$1 AND r.session_id=$2 AND r.status='reserved'
            AND ((r.tool_call_id IS NULL AND r.round_id IS NULL) OR EXISTS (SELECT 1 FROM agent_tool_calls x
              WHERE x.id=r.tool_call_id AND x.turn_id=r.turn_id AND x.session_id=r.session_id
                AND x.status IN ${TERMINAL_TOOL_CALLS}))`, [turn.id, turn.session_id])
        await settleInterruptedModel(c,turn,'cancel_model_outcome_unknown')
        const updated = (await c.query<Row>(`UPDATE agent_turns SET status='cancelled',terminal_at=clock_timestamp(),
          lease_owner=NULL,lease_until=NULL,revision=revision+1,updated_at=clock_timestamp()
          WHERE id=$1 AND session_id=$2 AND status IN ${NON_TERMINAL_TURNS} RETURNING *`,
        [turn.id, turn.session_id])).rows[0]
        if (!updated) continue
        await c.query(`UPDATE agent_sessions SET active_turn_id=NULL WHERE id=$1 AND active_turn_id=$2`, [turn.session_id, turn.id])
        for (const tool of [...tools, ...unobservedMedia]) await projectAgentFinalToolResult(c,{ownerId:session.owner_id,sessionId:updated.session_id,turnId:updated.id},tool,updated.revision)
        for (const decision of decisions) await event(c,updated.session_id,updated,'approval.required',approvalProjection(decision))
        await event(c, updated.session_id, updated, 'turn.updated', { turn: agentTurnDTO(updated) })
        processed++
      }
      return { kind: 'cancel', processed, remaining: candidates.length === limit }
    })
  }

  recoverExpiredLeases(limit: number): Promise<AgentRecoveryOutcome> {
    bound(limit)
    return this.tx(async c => {
      const candidates = (await c.query<Row>(`SELECT id,session_id FROM agent_turns
        WHERE status='running' AND lease_owner IS NOT NULL AND lease_until<=clock_timestamp()
          AND deadline_at>clock_timestamp() AND cancel_requested_at IS NULL
        ORDER BY lease_until,id LIMIT $1`, [limit])).rows
      let processed = 0
      for (const candidate of candidates) {
        const session=await lockSession(c,candidate.session_id)
        if (!session) continue
        const turn = (await c.query<Row>(`SELECT * FROM agent_turns
          WHERE id=$1 AND session_id=$2 AND status='running' AND lease_owner IS NOT NULL
            AND lease_until<=clock_timestamp() AND deadline_at>clock_timestamp() AND cancel_requested_at IS NULL
            FOR UPDATE SKIP LOCKED`, [candidate.id, candidate.session_id])).rows[0]
        if (!turn) continue
        // Lease cleanup is private bookkeeping: no revision, fence or public
        // event. A fresh wake lets any claimant reclaim after expiry.
        const updated = (await c.query<Row>(`UPDATE agent_turns SET lease_owner=NULL,lease_until=NULL,
          next_action_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE id=$1 AND session_id=$2 AND status='running' AND lease_owner IS NOT NULL
            AND lease_until<=clock_timestamp() AND deadline_at>clock_timestamp() AND cancel_requested_at IS NULL
          RETURNING *`, [turn.id, turn.session_id])).rows[0]
        if (!updated) continue
        await wake(c, updated, `agent-recovery:lease:${updated.id}:${updated.fencing_token}`)
        processed++
      }
      return { kind: 'lease', processed, remaining: candidates.length === limit }
    })
  }

  outboxBacklog(): Promise<AgentOutboxBacklog> {
    return this.tx(async c => {
      const row = (await c.query<Row>(`SELECT
        COUNT(*) FILTER (WHERE dispatched_at IS NULL AND quarantined_at IS NULL)::text AS pending,
        EXTRACT(EPOCH FROM (clock_timestamp()-MIN(created_at) FILTER (WHERE dispatched_at IS NULL AND quarantined_at IS NULL)))*1000 AS oldest_age_ms,
        COUNT(*) FILTER (WHERE quarantined_at IS NOT NULL)::text AS quarantined
        FROM outbox_events`)).rows[0]
      if (!row) throw new AgentCoreError('UNAVAILABLE')
      return {
        pending: Number(row.pending),
        oldestAgeMs: row.oldest_age_ms == null ? null : Number(row.oldest_age_ms),
        quarantined: Number(row.quarantined),
      }
    })
  }
}
