import { canvasAgentRequestDigest } from './canvas-agent'
import type { AgentDecimal, JsonObject, JsonValue } from '@musecanvas/contracts'

/** All writes use an existing caller-owned transaction; this module never commits. */
export interface AgentMediaSql {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>
}
export interface AgentMediaScope { ownerId: string; sessionId: string; turnId: string }
export class AgentMediaError extends Error {
  constructor(readonly code: 'APPROVAL_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'INVALID_TRANSITION') { super(code) }
}

/** Include the exact terminal timestamp: manual retry resets attempt and started_at. */
export async function appendMediaJobCompleted(client: AgentMediaSql, jobId: string): Promise<void> {
  await client.query(`INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key)
    SELECT 'media.job.completed',id,jsonb_build_object('schemaVersion',1,'jobId',id,'status',status,
      'completedAt',completed_at::text),'media.job.completed:' || id || ':' || completed_at::text
    FROM generation_jobs WHERE id=$1 AND status IN ('succeeded','failed','canceled') AND completed_at IS NOT NULL
    ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`, [jobId])
}

export interface AgentMediaApprovalBinding {
  argumentsHash: string
  modelRevision: string
  pricingRevision: string
  reservationId: string
  amount: AgentDecimal
  currency: string
}
/**
 * Enforcement only; M5 owns creating, resolving and expiring approvals.
 * The approved model revision is the Turn's frozen model revision; the media
 * model revision is separately frozen inside `argumentsHash`.
 */
export async function assertAgentMediaApproval(client: AgentMediaSql, scope: AgentMediaScope, toolCallId: string,
  roundId: string, argumentsHash: string, expected?: Pick<AgentMediaApprovalBinding, 'modelRevision' | 'pricingRevision' | 'reservationId' | 'amount' | 'currency'>): Promise<AgentMediaApprovalBinding> {
  const tool = (await client.query(`SELECT c.id,c.arguments FROM agent_tool_calls c JOIN agent_turns t ON t.id=c.turn_id AND t.session_id=c.session_id
    WHERE c.id=$1 AND c.turn_id=$2 AND c.session_id=$3 AND c.round_id=$4 AND c.arguments_hash=$5
      AND c.status='executing' FOR UPDATE OF c`,
  [toolCallId, scope.turnId, scope.sessionId, roundId, argumentsHash])).rows[0]
  if (!tool || !tool.arguments || canvasAgentRequestDigest(tool.arguments as JsonValue) !== argumentsHash) throw new AgentMediaError('APPROVAL_CONFLICT')
  const approval = (await client.query(`SELECT a.id,a.model_revision,a.pricing_revision,a.reservation_id,b.reserved_amount::text AS amount,b.currency
    FROM agent_approvals a
    JOIN agent_turns t ON t.id=a.turn_id AND t.session_id=a.session_id
    JOIN agent_sessions s ON s.id=a.session_id AND s.owner_id=$5
    JOIN agent_budget_reservations b ON b.id=a.reservation_id AND b.tool_call_id=a.tool_call_id
      AND b.turn_id=a.turn_id AND b.session_id=a.session_id AND b.pricing_revision=a.pricing_revision
    WHERE a.tool_call_id=$1 AND a.turn_id=$2 AND a.session_id=$3 AND a.arguments_hash=$4
      AND a.model_revision=t.config_snapshot->>'modelRevisionId' AND a.status='approved'
      AND a.resolved_by IS NOT NULL AND a.resolved_at IS NOT NULL AND clock_timestamp()<a.expires_at
      AND b.status='reserved' AND b.quota='estimated_cost' AND b.currency IS NOT NULL
      AND ($6::text IS NULL OR (a.model_revision=$6 AND a.pricing_revision=$7 AND a.reservation_id=$8::uuid
        AND b.reserved_amount=$9::numeric AND b.currency=$10)) FOR UPDATE OF a,b`,
  [toolCallId, scope.turnId, scope.sessionId, argumentsHash, scope.ownerId ?? null,
    expected?.modelRevision ?? null, expected?.pricingRevision ?? null, expected?.reservationId ?? null,
    expected?.amount ?? null, expected?.currency ?? null])).rows[0]
  if (!approval) throw new AgentMediaError('APPROVAL_CONFLICT')
  return { argumentsHash, modelRevision: String(approval.model_revision), pricingRevision: String(approval.pricing_revision),
    reservationId: String(approval.reservation_id), amount: String(approval.amount) as AgentDecimal, currency: String(approval.currency) }
}

export async function linkAgentMediaJob(client: AgentMediaSql, scope: AgentMediaScope, toolCallId: string, jobId: string): Promise<void> {
  const result = await client.query(`INSERT INTO agent_tool_job_links(tool_call_id,session_id,turn_id,owner_id,media_job_id,position,dependency_role)
    VALUES($1,$2,$3,$4,$5,0,'output') ON CONFLICT(tool_call_id,position) DO NOTHING RETURNING media_job_id`,
  [toolCallId, scope.sessionId, scope.turnId, scope.ownerId, jobId])
  if (result.rows.length) return
  const existing = (await client.query(`SELECT media_job_id FROM agent_tool_job_links
    WHERE tool_call_id=$1 AND session_id=$2 AND turn_id=$3 AND owner_id=$4 AND position=0`,
  [toolCallId, scope.sessionId, scope.turnId, scope.ownerId])).rows[0]
  if (existing?.media_job_id !== jobId) throw new AgentMediaError('IDEMPOTENCY_CONFLICT')
}

export interface AgentMediaToolDependency extends AgentMediaScope { toolCallId: string }
/** Verify the actual Outbox identity and terminal cycle; stream payloads are untrusted hints. */
export async function mediaCompletionDependencies(client: AgentMediaSql, eventId: string, jobId: string): Promise<AgentMediaToolDependency[]> {
  const rows = (await client.query(`SELECT DISTINCT l.owner_id,l.session_id,l.turn_id,l.tool_call_id
    FROM outbox_events e JOIN generation_jobs j ON j.id=e.aggregate_id
    JOIN agent_tool_job_links l ON l.media_job_id=j.id AND l.owner_id=j.created_by
    JOIN agent_tool_calls c ON c.id=l.tool_call_id AND c.turn_id=l.turn_id AND c.session_id=l.session_id
    JOIN agent_sessions s ON s.id=l.session_id AND s.owner_id=l.owner_id
    WHERE e.id=$1 AND e.event_type='media.job.completed' AND j.id=$2 AND e.payload->>'jobId'=j.id::text
      AND e.payload->>'schemaVersion'='1' AND e.payload->>'status'=j.status::text
      AND e.payload->>'completedAt'=j.completed_at::text AND j.status IN ('succeeded','failed','canceled')
    ORDER BY l.owner_id,l.session_id,l.turn_id,l.tool_call_id`, [eventId, jobId])).rows
  return rows.map(r => ({ ownerId: String(r.owner_id), sessionId: String(r.session_id), turnId: String(r.turn_id), toolCallId: String(r.tool_call_id) }))
}

export type AgentMediaDependencyResult =
  | { kind: 'skip' }
  /** A linked job is not terminal yet; its own event will settle the tool. */
  | { kind: 'ack' }
  /** The tool row is not waiting_external yet; redeliver instead of losing the completion. */
  | { kind: 'wait' }
  | { kind: 'final'; status: 'completed' | 'failed' | 'cancelled'; result: JsonObject }
/** Actor -> Session -> Turn -> Tool -> Jobs. Re-read current truth after every lock. */
export async function terminalAgentMediaTool(client: AgentMediaSql, scope: AgentMediaToolDependency): Promise<AgentMediaDependencyResult> {
  const actor = (await client.query(`SELECT id,status,deleted_at FROM users WHERE id=$1 FOR NO KEY UPDATE`, [scope.ownerId])).rows[0]
  if (!actor || actor.status !== 'active' || actor.deleted_at != null) return { kind: 'skip' }
  const session = (await client.query(`SELECT active_turn_id,archived_at FROM agent_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [scope.sessionId, scope.ownerId])).rows[0]
  if (!session || session.active_turn_id !== scope.turnId || session.archived_at != null) return { kind: 'skip' }
  const turn = (await client.query(`SELECT status,cancel_requested_at FROM agent_turns
    WHERE id=$1 AND session_id=$2 AND engine_version='agent-core-v1' FOR UPDATE`, [scope.turnId, scope.sessionId])).rows[0]
  if (!turn || !['running', 'waiting_tools', 'waiting_approval'].includes(String(turn.status)) || turn.cancel_requested_at != null) return { kind: 'skip' }
  const tool = (await client.query(`SELECT status FROM agent_tool_calls WHERE id=$1 AND turn_id=$2 AND session_id=$3 FOR UPDATE`,
    [scope.toolCallId, scope.turnId, scope.sessionId])).rows[0]
  if (!tool) return { kind: 'skip' }
  if (tool.status !== 'waiting_external') {
    return ['completed', 'failed', 'cancelled', 'skipped'].includes(String(tool.status)) ? { kind: 'skip' } : { kind: 'wait' }
  }
  // FK-backed job rows stay locked against manual retry through settlement.
  const jobs = (await client.query(`SELECT l.media_job_id AS id,j.status,j.completed_at,j.created_by,l.owner_id
    FROM agent_tool_job_links l JOIN generation_jobs j ON j.id=l.media_job_id
    WHERE l.tool_call_id=$1 AND l.turn_id=$2 AND l.session_id=$3 ORDER BY l.position FOR SHARE OF j`,
  [scope.toolCallId, scope.turnId, scope.sessionId])).rows
  if (!jobs.length || jobs.some(j => j.owner_id !== scope.ownerId || j.created_by !== scope.ownerId)) return { kind: 'skip' }
  if (jobs.some(j => !['succeeded', 'failed', 'canceled'].includes(String(j.status)) || j.completed_at == null)) return { kind: 'ack' }
  const outputs: JsonObject[] = []
  for (const job of jobs) {
    const assets = (await client.query(`SELECT a.id FROM generation_outputs o JOIN assets a ON a.id=o.asset_id
      WHERE o.job_id=$1 AND a.job_id=$1 AND a.created_by=$2 ORDER BY a.id`, [job.id, scope.ownerId])).rows
    // A success cannot settle until its outputs exist in the same committed snapshot.
    if (job.status === 'succeeded' && !assets.length) return { kind: 'wait' }
    outputs.push({ jobId: String(job.id), status: String(job.status), assetIds: assets.map(a => String(a.id)) })
  }
  const status = jobs.some(j => j.status === 'failed') ? 'failed' : jobs.some(j => j.status === 'canceled') ? 'cancelled' : 'completed'
  return { kind: 'final', status, result: { content: status === 'completed'
    ? `Media generation completed: ${outputs.map(o => o.jobId).join(', ')}`
    : status === 'failed' ? 'Media generation failed.' : 'Media generation cancelled.', jobs: outputs } }
}
