import { randomUUID } from 'node:crypto'
import type { JsonObject, CanvasAgentEditMetadata } from '@musecanvas/contracts'
import { canvasAgentPendingIdentity, canvasAgentRequestDigest, lockCanvasAgentTurn, type CanvasAgentClient, type CanvasAgentScope, type CanvasAgentLease } from './canvas-agent'

export interface CanvasAgentPreparationArtifact { checksum: string; sourceChecksum: string; sizeBytes: number; width: number; height: number }
export interface CanvasAgentPreparedEdit { normalizedRequest: JsonObject; editMetadata: CanvasAgentEditMetadata }
export interface CanvasAgentEditPreparation {
  id: string; sessionId: string; canvasId: string; createdBy: string; turnId: string; toolCallId: string
  requestDigest: string; requestSnapshot: JsonObject; maskUploadId: string; expiresAt: string
  status: 'preparing' | 'ready'; leaseToken: string | null; leaseExpiresAt: string | null
  artifact: CanvasAgentPreparationArtifact | null; readySnapshot: CanvasAgentPreparedEdit | null
}
function entity(row: Record<string, unknown>): CanvasAgentEditPreparation {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value instanceof Date ? value.toISOString() : value])) as unknown as CanvasAgentEditPreparation
}
const scoped = `FROM canvas_agent_preparations p JOIN canvas_agent_sessions s ON s.id=p.session_id
  JOIN canvas_documents c ON c.id=s.canvas_id AND c.created_by=s.created_by AND c.deleted_at IS NULL
  WHERE p.created_by=$1 AND p.canvas_id=$2 AND p.session_id=$3 AND c.created_by=$1 AND p.turn_id=$4 AND p.id=$5`
const values = (scope: CanvasAgentScope, lease: CanvasAgentLease, id: string) => [scope.actorId, scope.canvasId, scope.sessionId, lease.turnId, id]
/** SHORT transaction, shared session → turn → canvas lock order; fence current turn lease. */
async function active(client: CanvasAgentClient, scope: CanvasAgentScope, lease: CanvasAgentLease): Promise<boolean> {
  if (!await lockCanvasAgentTurn(client, scope, lease.turnId)) return false
  return !!(await client.query(`SELECT s.id FROM canvas_agent_sessions s JOIN canvas_agent_turns t ON t.id=s.running_turn_id
    WHERE s.id=$1 AND s.running_turn_id=$2 AND s.running_lease_token=$3 AND t.lease_token=$3
    AND t.status='running' AND s.running_lease_expires_at>clock_timestamp() AND t.lease_expires_at>clock_timestamp()`, [scope.sessionId, lease.turnId, lease.leaseToken])).rows[0]
}
export async function reserveCanvasAgentEditPreparation(client: CanvasAgentClient, scope: CanvasAgentScope, lease: CanvasAgentLease, input: { toolCallId: string; requestSnapshot: JsonObject; leaseMs: number; ttlSeconds: number }): Promise<CanvasAgentEditPreparation> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 60000 || !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 900) throw new Error('Invalid preparation bounds')
  if (!await active(client, scope, lease)) throw new Error('PREPARATION_LEASE_LOST')
  const id = canvasAgentPendingIdentity(scope.canvasId, canvasAgentRequestDigest(['preparation', input.toolCallId])).id
  const maskId = canvasAgentPendingIdentity(scope.canvasId, canvasAgentRequestDigest(['mask', input.toolCallId])).id
  const requestDigest = canvasAgentRequestDigest(input.requestSnapshot)
  const prior = (await client.query(`SELECT p.*,p.expires_at>clock_timestamp() AS unexpired,p.lease_expires_at>clock_timestamp() AS leased ${scoped} FOR UPDATE OF p`, values(scope, lease, id))).rows[0]
  if (prior) {
    if (prior.request_digest !== requestDigest) throw new Error('PREPARATION_CONFLICT')
    if (!prior.unexpired) throw new Error('PREPARATION_EXPIRED')
    if (prior.status === 'ready') return entity(prior)
    if (prior.leased) throw new Error('PREPARATION_BUSY')
    const row = (await client.query(`UPDATE canvas_agent_preparations SET lease_token=$2,lease_expires_at=clock_timestamp()+($3*interval '1 millisecond'),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [id, randomUUID(), input.leaseMs])).rows[0]
    return entity(row)
  }
  const row = (await client.query(`INSERT INTO canvas_agent_preparations(id,created_by,canvas_id,session_id,turn_id,tool_call_id,request_digest,request_snapshot,mask_upload_id,expires_at,lease_token,lease_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,clock_timestamp()+($12*interval '1 second'),$10,clock_timestamp()+($11*interval '1 millisecond')) RETURNING *`,
  [id, scope.actorId, scope.canvasId, scope.sessionId, lease.turnId, input.toolCallId, requestDigest, JSON.stringify(input.requestSnapshot), maskId, randomUUID(), input.leaseMs, input.ttlSeconds])).rows[0]
  return entity(row)
}
export async function fenceCanvasAgentEditPreparation(client: CanvasAgentClient, scope: CanvasAgentScope, lease: CanvasAgentLease, preparation: CanvasAgentEditPreparation): Promise<boolean> {
  if (!await active(client, scope, lease)) return false
  return !!(await client.query(`SELECT p.id ${scoped} AND p.status='preparing' AND p.lease_token=$6
    AND p.lease_expires_at>clock_timestamp() AND p.expires_at>clock_timestamp() FOR UPDATE OF p`, [...values(scope, lease, preparation.id), preparation.leaseToken])).rows[0]
}
export async function freezeCanvasAgentPreparationArtifact(client: CanvasAgentClient, scope: CanvasAgentScope, lease: CanvasAgentLease, preparation: CanvasAgentEditPreparation, artifact: CanvasAgentPreparationArtifact): Promise<void> {
  if (!await fenceCanvasAgentEditPreparation(client, scope, lease, preparation)) throw new Error('PREPARATION_LEASE_LOST')
  if (artifact.sourceChecksum !== preparation.requestSnapshot.sourceChecksum) throw new Error('PREPARATION_CONFLICT')
  await client.query('UPDATE canvas_agent_preparations SET artifact=$2::jsonb,updated_at=clock_timestamp() WHERE id=$1', [preparation.id, JSON.stringify(artifact)])
}
export async function completeCanvasAgentEditPreparation(client: CanvasAgentClient, scope: CanvasAgentScope, lease: CanvasAgentLease, preparation: CanvasAgentEditPreparation, snapshot: CanvasAgentPreparedEdit): Promise<CanvasAgentEditPreparation> {
  if (!await fenceCanvasAgentEditPreparation(client, scope, lease, preparation)) throw new Error('PREPARATION_LEASE_LOST')
  const row = (await client.query(`UPDATE canvas_agent_preparations SET status='ready',ready_snapshot=$2::jsonb,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [preparation.id, JSON.stringify(snapshot)])).rows[0]
  return entity(row)
}
