import type { AgentDecimal, AgentTurnDTO, JsonObject } from '@musecanvas/contracts'
import { agentCoreDecimal, agentTurnDTO, type AgentCoreClient, type AgentCoreTransaction } from './agent-core'

export interface AgentTurnScope {
  readonly ownerId: string
  readonly sessionId: string
  readonly turnId: string
}
export interface AgentTurnLeaseIdentity extends AgentTurnScope {
  readonly leaseOwner: string
  readonly fencingToken: AgentDecimal
}
export interface AgentTurnLease extends AgentTurnLeaseIdentity {
  readonly leaseUntil: string
  readonly revision: AgentDecimal
  readonly inputRevision: AgentDecimal
}
export interface AgentTurnExecutionFence extends AgentTurnLeaseIdentity {
  readonly expectedInputRevision: AgentDecimal
}
export class AgentRuntimeError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'LEASE_REJECTED' | 'TRANSITION_REJECTED') { super(code) }
}
export type AgentTurnTransitionTarget = 'waiting_tools' | 'waiting_approval' | 'completed' | 'failed'
interface SessionRow { id: string; owner_id: string; active_turn_id: string | null; archived_at: Date | null }
interface TurnRow {
  id: string
  session_id: string
  status: AgentTurnDTO['status']
  engine_version: string
  revision: string
  input_revision: string
  cancel_requested_at: Date | null
  terminal_at: Date | null
  deadline_at: Date
  error: Record<string, unknown> | null
  lease_owner: string | null
  lease_until: Date | null
  fencing_token: string
}
function duration(value: number) {
  // SQL uses int milliseconds, not an application-clock timestamp.
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new AgentRuntimeError('INVALID_INPUT')
}
function owner(value: string) { if (!value.trim()) throw new AgentRuntimeError('INVALID_INPUT') }
function identity(input: AgentTurnLeaseIdentity) {
  owner(input.leaseOwner)
  if (agentCoreDecimal(input.fencingToken) === '0') throw new AgentRuntimeError('INVALID_INPUT')
}
function lease(scope: AgentTurnScope, t: TurnRow): AgentTurnLease {
  if (!t.lease_owner || !t.lease_until) throw new AgentRuntimeError('LEASE_REJECTED')
  return { ownerId: scope.ownerId, sessionId: scope.sessionId, turnId: scope.turnId,
    leaseOwner: t.lease_owner, fencingToken: agentCoreDecimal(t.fencing_token),
    leaseUntil: t.lease_until.toISOString(), revision: agentCoreDecimal(t.revision), inputRevision: agentCoreDecimal(t.input_revision) }
}
async function lockScope(c: AgentCoreClient, scope: AgentTurnScope, cleanup = false): Promise<TurnRow | null> {
  // Match the control plane: actor NO KEY UPDATE -> Session -> Turn. Cleanup
  // locks even a disabled/deleted actor and archived/non-active Session.
  const actor = (await c.query<{ id: string; active: boolean }>(`SELECT id,(status='active' AND deleted_at IS NULL) AS active
    FROM users WHERE id=$1 FOR NO KEY UPDATE`, [scope.ownerId])).rows[0]
  if (!actor || (!cleanup && !actor.active)) return null
  const s = (await c.query<SessionRow>(`SELECT id,owner_id,active_turn_id,archived_at FROM agent_sessions
    WHERE owner_id=$1 AND id=$2 FOR UPDATE`, [scope.ownerId, scope.sessionId])).rows[0]
  if (!s || (!cleanup && (s.archived_at !== null || s.active_turn_id !== scope.turnId))) return null
  const t = (await c.query<TurnRow>(`SELECT * FROM agent_turns WHERE session_id=$1 AND id=$2 FOR UPDATE`,
    [scope.sessionId, scope.turnId])).rows[0]
  return t?.engine_version === 'agent-core-v1' ? t : null
}
async function executionGuard(c: AgentCoreClient, input: AgentTurnExecutionFence): Promise<AgentTurnLease> {
  // Re-read database truth, including the active pointer and actor, after SQL
  // work too. Strict comparisons reject equality at lease/deadline boundaries.
  const t = (await c.query<TurnRow>(`SELECT t.* FROM agent_turns t
    JOIN agent_sessions s ON s.id=t.session_id JOIN users u ON u.id=s.owner_id
    WHERE s.owner_id=$1 AND s.id=$2 AND t.id=$3 AND s.active_turn_id=t.id AND s.archived_at IS NULL
      AND u.status='active' AND u.deleted_at IS NULL AND t.engine_version='agent-core-v1' AND t.status='running'
      AND t.lease_owner=$4 AND t.fencing_token=$5 AND clock_timestamp()<t.lease_until
      AND t.cancel_requested_at IS NULL AND clock_timestamp()<t.deadline_at AND t.input_revision=$6`,
  [input.ownerId, input.sessionId, input.turnId, input.leaseOwner, input.fencingToken, input.expectedInputRevision])).rows[0]
  if (!t) throw new AgentRuntimeError('LEASE_REJECTED')
  return lease(input, t)
}

/**
 * Database-only lease boundary; no wake consumption, ACK, recovery or network.
 * tx must own BEGIN/COMMIT, roll back the ENTIRE transaction on every thrown
 * error, and propagate it. It must not catch a callback error and commit.
 *
 * A claim moves every non-running state (queued or waiting_tools/
 * waiting_approval) to running and that handoff changes the public
 * revision/event cursor. Running reclaims, renewals and releases are private
 * lease bookkeeping: no revision, public event, input revision or wake changes.
 * Every claim (including a same owner reclaim after expiry/release) advances the
 * fencing token exactly once.
 */
export class AgentRuntimeRepository {
  constructor(private readonly tx: AgentCoreTransaction) {}

  claimTurnLease(input: AgentTurnScope & { readonly leaseOwner: string; readonly leaseDurationMs: number }): Promise<AgentTurnLease | null> {
    const scope = { ownerId: input.ownerId, sessionId: input.sessionId, turnId: input.turnId }
    const { leaseOwner, leaseDurationMs } = input
    owner(leaseOwner); duration(leaseDurationMs)
    return this.tx(async c => {
      const previous = await lockScope(c, scope)
      if (!previous) return null
      const t = (await c.query<TurnRow>(`UPDATE agent_turns SET lease_owner=$3,
        lease_until=LEAST(deadline_at,clock_timestamp()+$4::int*interval '1 millisecond'),fencing_token=fencing_token+1,
        status='running',revision=revision+CASE WHEN status='running' THEN 0 ELSE 1 END,updated_at=clock_timestamp()
        WHERE session_id=$1 AND id=$2 AND engine_version='agent-core-v1'
          AND status IN ('queued','running','waiting_tools','waiting_approval')
          AND (lease_until IS NULL OR lease_until<=clock_timestamp())
          AND cancel_requested_at IS NULL AND clock_timestamp()<deadline_at RETURNING *`,
      [scope.sessionId, scope.turnId, leaseOwner, leaseDurationMs])).rows[0]
      if (!t) return null
      if (previous.status !== 'running') {
        const counter = (await c.query<{ cursor: string }>(`UPDATE agent_sessions SET next_event_cursor=next_event_cursor+1,updated_at=clock_timestamp()
          WHERE id=$1 AND owner_id=$2 RETURNING (next_event_cursor-1)::text AS cursor`, [scope.sessionId, scope.ownerId])).rows[0]
        if (!counter) throw new AgentRuntimeError('LEASE_REJECTED')
        await c.query(`INSERT INTO agent_session_events(session_id,turn_id,cursor,entity_revision,event_type,payload)
          VALUES($1,$2,$3,$4,'turn.updated',$5::jsonb)`,
        [scope.sessionId, scope.turnId, counter.cursor, t.revision, JSON.stringify({ turn: agentTurnDTO(t) })])
      }
      return lease(scope, t)
    })
  }

  renewTurnLease(input: AgentTurnLeaseIdentity & { readonly leaseDurationMs: number }): Promise<AgentTurnLease | null> {
    const snapshot = { ...input }
    identity(snapshot); duration(snapshot.leaseDurationMs)
    return this.tx(async c => {
      if (!await lockScope(c, snapshot)) return null
      // Steering advances public/input revision independently of lease ownership.
      // Expiry is never renewed, even for the same owner: it needs a new claim.
      const t = (await c.query<TurnRow>(`UPDATE agent_turns SET
        lease_until=LEAST(deadline_at,clock_timestamp()+$5::int*interval '1 millisecond'),updated_at=clock_timestamp()
        WHERE session_id=$1 AND id=$2 AND engine_version='agent-core-v1' AND status='running'
          AND lease_owner=$3 AND fencing_token=$4 AND clock_timestamp()<lease_until
          AND cancel_requested_at IS NULL AND clock_timestamp()<deadline_at RETURNING *`,
      [snapshot.sessionId, snapshot.turnId, snapshot.leaseOwner, snapshot.fencingToken, snapshot.leaseDurationMs])).rows[0]
      return t ? lease(snapshot, t) : null
    })
  }

  /** Cleanup is allowed after expiry, cancellation, deadline, actor disablement
   * or session archival/pointer change. Scope+engine+owner+token still must match;
   * only lease fields change, never state, active pointer or control intent. */
  releaseTurnLease(input: AgentTurnLeaseIdentity): Promise<boolean> {
    const snapshot = { ...input }
    identity(snapshot)
    return this.tx(async c => {
      if (!await lockScope(c, snapshot, true)) return false
      const result = await c.query<{ id: string }>(`UPDATE agent_turns SET lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE session_id=$1 AND id=$2 AND engine_version='agent-core-v1' AND lease_owner=$3 AND fencing_token=$4 RETURNING id`,
      [snapshot.sessionId, snapshot.turnId, snapshot.leaseOwner, snapshot.fencingToken])
      return result.rows.length === 1
    })
  }

  /** Trusted SQL-only callback, not a sandbox for arbitrary/malicious code.
   * No network, transaction control, lease/control-row mutation or out-of-scope
   * writes. Keep it short; it may write rounds/tools/ledgers while the Turn stays
   * running. Terminalization, waiting handoff and release need separate APIs.
   * The mandatory input fence blocks stale model/effect writes after steering;
   * cancel/deadline block execution, not just lease ownership. Failure of either
   * guard throws so all callback SQL rolls back. The final check is immediately
   * before returning to tx, not a guarantee that wall time cannot pass before
   * COMMIT, nor permission to perform external effects under these locks. */
  withTurnLease<T>(input: AgentTurnExecutionFence, work: (client: AgentCoreClient, lease: AgentTurnLease) => Promise<T>): Promise<T> {
    const snapshot = { ...input }
    identity(snapshot); agentCoreDecimal(snapshot.expectedInputRevision)
    return this.tx(async c => {
      if (!await lockScope(c, snapshot)) throw new AgentRuntimeError('LEASE_REJECTED')
      const current = await executionGuard(c, snapshot)
      const result = await work(c, current)
      await executionGuard(c, snapshot)
      return result
    })
  }

  /**
   * Narrow successful/failed handoff boundary added for the Worker Runner. The
   * existing withTurnLease contract is unchanged; this method adds an explicit
   * target so waiting/terminal state and its public event commit atomically.
   * No cancel, expiry, recovery or approval policy lives here; M5 owns those.
   */
  transitionWithTurnLease<T>(input: AgentTurnExecutionFence, transition: { to: AgentTurnTransitionTarget; error?: JsonObject | null }, work: (client: AgentCoreClient, lease: AgentTurnLease) => Promise<T>): Promise<{ work: T; turn: AgentTurnDTO }> {
    const snapshot = { ...input }
    identity(snapshot); agentCoreDecimal(snapshot.expectedInputRevision)
    const target = transition.to
    return this.tx(async c => {
      if (!await lockScope(c, snapshot)) throw new AgentRuntimeError('LEASE_REJECTED')
      const current = await executionGuard(c, snapshot)
      const result = await work(c, current)
      await executionGuard(c, snapshot)
      await transitionInvariants(c, snapshot, target)
      const terminal = target === 'completed' || target === 'failed'
      const t = (await c.query<TurnRow>(`UPDATE agent_turns SET status=$6,
        error=CASE WHEN $6='failed' THEN $7::jsonb ELSE NULL END,
        terminal_at=CASE WHEN $8 THEN clock_timestamp() ELSE NULL END,
        lease_owner=NULL,lease_until=NULL,revision=revision+1,updated_at=clock_timestamp()
        WHERE session_id=$1 AND id=$2 AND engine_version='agent-core-v1' AND status='running'
          AND lease_owner=$3 AND fencing_token=$4 AND clock_timestamp()<lease_until
          AND cancel_requested_at IS NULL AND clock_timestamp()<deadline_at AND input_revision=$5
        RETURNING *`,
      [snapshot.sessionId, snapshot.turnId, snapshot.leaseOwner, snapshot.fencingToken, snapshot.expectedInputRevision, target, target === 'failed' ? JSON.stringify(transition.error ?? { code: 'TOOL_FAILED', message: 'Agent turn failed', retryable: false }) : null, terminal])).rows[0]
      if (!t) throw new AgentRuntimeError('TRANSITION_REJECTED')
      if (terminal) {
        const cleared = await c.query('UPDATE agent_sessions SET active_turn_id=NULL,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND active_turn_id=$3', [snapshot.sessionId, snapshot.ownerId, snapshot.turnId])
        if (cleared.rowCount !== 1) throw new AgentRuntimeError('TRANSITION_REJECTED')
      }
      const counter = (await c.query<{ cursor: string }>(`UPDATE agent_sessions SET next_event_cursor=next_event_cursor+1,updated_at=clock_timestamp()
        WHERE id=$1 AND owner_id=$2 RETURNING (next_event_cursor-1)::text AS cursor`, [snapshot.sessionId, snapshot.ownerId])).rows[0]
      if (!counter) throw new AgentRuntimeError('TRANSITION_REJECTED')
      await c.query(`INSERT INTO agent_session_events(session_id,turn_id,cursor,entity_revision,event_type,payload)
        VALUES($1,$2,$3,$4,'turn.updated',$5::jsonb)`,
      [snapshot.sessionId, snapshot.turnId, counter.cursor, t.revision, JSON.stringify({ turn: agentTurnDTO(t) })])
      return { work: result, turn: agentTurnDTO(t) }
    })
  }
}

/** Terminal/waiting invariants read durable rows; callback claims are never trusted. */
async function transitionInvariants(c: AgentCoreClient, scope: AgentTurnScope, target: AgentTurnTransitionTarget) {
  if (!['waiting_tools','waiting_approval','completed','failed'].includes(target)) throw new AgentRuntimeError('INVALID_INPUT')
  const tools = (await c.query<{ id: string; status: string; has_result: boolean }>(`SELECT x.id,x.status,
    EXISTS(SELECT 1 FROM agent_items i WHERE i.tool_call_id=x.id AND i.item_type='tool_result') AS has_result
    FROM agent_tool_calls x WHERE x.turn_id=$1 AND x.session_id=$2 ORDER BY x.position`, [scope.turnId, scope.sessionId])).rows
  const approvals = (await c.query<{ status: string }>('SELECT status FROM agent_approvals WHERE turn_id=$1 AND session_id=$2', [scope.turnId, scope.sessionId])).rows
  const reservations = (await c.query<{ status: string }>('SELECT status FROM agent_budget_reservations WHERE turn_id=$1 AND session_id=$2', [scope.turnId, scope.sessionId])).rows
  const rounds = (await c.query<{ status: string }>('SELECT status FROM agent_model_rounds WHERE turn_id=$1 AND session_id=$2', [scope.turnId, scope.sessionId])).rows
  if (rounds.some(r=>r.status==='running' || r.status==='recorded')) throw new AgentRuntimeError('TRANSITION_REJECTED')
  if (tools.some(t=>['completed','failed','cancelled','skipped'].includes(t.status) && !t.has_result)) throw new AgentRuntimeError('TRANSITION_REJECTED')
  if (target === 'waiting_approval' && tools.some(t=>!['completed','failed','cancelled','skipped','waiting_approval','waiting_external'].includes(t.status))) throw new AgentRuntimeError('TRANSITION_REJECTED')
  if (approvals.some(a => a.status === 'pending') && target !== 'waiting_approval') throw new AgentRuntimeError('TRANSITION_REJECTED')
  if (target === 'waiting_approval' && !approvals.some(a => a.status === 'pending')) throw new AgentRuntimeError('TRANSITION_REJECTED')
  if (target === 'waiting_tools' && (!tools.some(t => t.status === 'waiting_external') || tools.some(t => ['recorded','validating','executing','waiting_approval'].includes(t.status)))) throw new AgentRuntimeError('TRANSITION_REJECTED')
  if (target === 'completed' || target === 'failed') {
    if (tools.some(t => !['completed','failed','cancelled','skipped'].includes(t.status) || !t.has_result)) throw new AgentRuntimeError('TRANSITION_REJECTED')
    if (reservations.some(r => r.status === 'reserved' || r.status === 'unknown')) throw new AgentRuntimeError('TRANSITION_REJECTED')
  }
}
