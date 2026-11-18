import {
  AgentCoreError, type AgentCoreTransaction,
} from './agent-core'
import { AgentRuntimeError } from './agent-runtime'
import type { AgentRecoveryOutcome } from './agent-recovery'
import { projectAgentFinalToolResult, queueAgentTurnIfDependenciesTerminal } from './agent-execution'
import { settleLinkedAgentMediaReservations } from './agent-media-settlement'

/** This file's sweep outcome; the shared recovery union owns the `kind` vocabulary. */
export type AgentMediaRecoveryOutcome = AgentRecoveryOutcome

type Row = Record<string, any>
type FinalToolRow = Parameters<typeof projectAgentFinalToolResult>[2]
const TERMINAL_JOBS = "('succeeded','failed','canceled')"
const TERMINAL_TURNS = "('completed','failed','cancelled')"
const MEDIA_FAILED = { code: 'TOOL_FAILED', message: 'Media job failed', retryable: false }
// Same Tool errors the media event path stores for a terminal Job.
const FINAL_MEDIA_FAILED = { code: 'TOOL_FAILED', message: 'Media generation failed', retryable: false }
const FINAL_MEDIA_CANCELLED = { code: 'TOOL_FAILED', message: 'Media generation cancelled', retryable: false }
const json = (value: object) => JSON.stringify(value)

function bound(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new AgentRuntimeError('INVALID_INPUT')
}
/**
 * Media terminal reconciliation for externally waiting ToolCalls. This is
 * coordinator persistence only: it reads the authoritative generation job and
 * asset rows, settles already-reserved budget, projects the final ToolCall state
 * and resumes a Turn only when every dependency is terminal. It never submits or
 * cancels media, executes a Runner, consumes wakes or creates assets.
 *
 * Each sweep is one caller-owned transaction. Candidate ToolCalls are locked with
 * FOR UPDATE OF x SKIP LOCKED so concurrent coordinators split work; the parent
 * Turn revision update serializes candidates of the same Turn. A SQL or callback
 * failure propagates and rolls back the whole sweep.
 */
export class AgentMediaRecoveryRepository {
  constructor(private readonly tx: AgentCoreTransaction) {}

  reconcileMediaJobs(limit: number): Promise<AgentMediaRecoveryOutcome> {
    bound(limit)
    return this.tx(async c => {
      // Unlocked candidate read only. Every mutation then locks Turn -> Tool,
      // matching resolveApproval's order and avoiding a lock cycle.
      const candidates = (await c.query<Row>(`SELECT x.id,x.turn_id,x.session_id FROM agent_tool_calls x
        WHERE x.status='waiting_external'
          AND EXISTS (SELECT 1 FROM agent_tool_job_links l
            WHERE l.tool_call_id=x.id AND l.turn_id=x.turn_id AND l.session_id=x.session_id)
          AND NOT EXISTS (SELECT 1 FROM agent_tool_job_links l
            JOIN generation_jobs j ON j.id=l.media_job_id
            WHERE l.tool_call_id=x.id AND l.turn_id=x.turn_id AND l.session_id=x.session_id
              AND j.status NOT IN ${TERMINAL_JOBS})
        ORDER BY x.updated_at,x.id LIMIT $1`, [limit])).rows
      let processed = 0
      for (const candidate of candidates) {
        const session = (await c.query(`SELECT * FROM agent_sessions WHERE id=$1 FOR UPDATE SKIP LOCKED`,
          [candidate.session_id])).rows[0]
        if (!session) continue
        const turn = (await c.query<Row>(`SELECT * FROM agent_turns
          WHERE id=$1 AND session_id=$2 FOR UPDATE SKIP LOCKED`, [candidate.turn_id, candidate.session_id])).rows[0]
        if (!turn) continue
        const call = (await c.query<Row>(`SELECT * FROM agent_tool_calls
          WHERE id=$1 AND turn_id=$2 AND session_id=$3 AND status='waiting_external' FOR UPDATE`,
        [candidate.id, candidate.turn_id, candidate.session_id])).rows[0]
        if (!call) continue
        const links = (await c.query<Row>(`SELECT l.media_job_id,l.owner_id,l.position,j.status
          FROM agent_tool_job_links l
          JOIN generation_jobs j ON j.id=l.media_job_id AND j.created_by=l.owner_id
          WHERE l.tool_call_id=$1 AND l.turn_id=$2 AND l.session_id=$3
          ORDER BY l.position`, [call.id, call.turn_id, call.session_id])).rows
        if (!links.length) continue
        // Re-check under locks: a stale candidate may have gained a new job or
        // lost terminal status since the unlocked candidate read.
        if (links.some(link => !['succeeded', 'failed', 'canceled'].includes(link.status))) continue
        const jobIds = links.map(link => link.media_job_id)
        const outputs = (await c.query<Row>(`SELECT o.job_id,o.asset_id FROM generation_outputs o
          JOIN assets a ON a.id=o.asset_id AND a.created_by=$2
          WHERE o.job_id=ANY($1::uuid[]) AND a.deleted_at IS NULL
          ORDER BY o.job_id,o.asset_id`, [jobIds, links[0]!.owner_id])).rows
        const assetsByJob = new Map<string, string[]>()
        for (const output of outputs) {
          const assetIds = assetsByJob.get(output.job_id) ?? []
          assetIds.push(output.asset_id)
          assetsByJob.set(output.job_id, assetIds)
        }
        const assetIds: string[] = []
        for (const link of links) {
          const linked = assetsByJob.get(link.media_job_id) ?? []
          assetIds.push(...linked)
        }
        const status = links.some(link => link.status === 'failed') ? 'failed'
          : links.some(link => link.status === 'canceled') ? 'cancelled' : 'completed'
        const result = status === 'completed' ? { jobIds, assetIds } : null
        const error = status === 'failed' ? MEDIA_FAILED : status === 'cancelled' ? {code:'TOOL_FAILED',message:'Media generation cancelled',retryable:false} : null

        const updatedTurn = (await c.query<Row>(`UPDATE agent_turns SET revision=revision+1,updated_at=clock_timestamp()
          WHERE id=$1 AND session_id=$2 RETURNING *`, [call.turn_id, call.session_id])).rows[0]
        if (!updatedTurn) throw new AgentCoreError('UNAVAILABLE')
        const tool = (await c.query<Row & FinalToolRow>(`UPDATE agent_tool_calls SET status=$2,result=$3::jsonb,error=$4::jsonb,updated_at=clock_timestamp()
          WHERE id=$1 AND session_id=$5 AND turn_id=$6 AND status='waiting_external'
          RETURNING *`,
        [call.id, status, result ? json(result) : null, error ? json(error) : null, call.session_id, call.turn_id])).rows[0]
        if (!tool) throw new AgentCoreError('UNAVAILABLE')

        await settleLinkedAgentMediaReservations(c,{id:call.id,turn_id:call.turn_id,session_id:call.session_id})
        await projectAgentFinalToolResult(c,{ownerId:session.owner_id,sessionId:call.session_id,turnId:call.turn_id},tool,updatedTurn.revision)
        processed++

        await queueAgentTurnIfDependenciesTerminal(c,{ownerId:session.owner_id,sessionId:call.session_id,turnId:call.turn_id})
      }
      return { kind: 'media', processed, remaining: candidates.length === limit }
    })
  }

  /**
   * Settle media Tools abandoned by a terminal Turn. The event path refuses a
   * terminal Turn, so a cancelled/completed/failed Turn can keep a
   * `waiting_external` Tool whose linked Jobs are already terminal. This sweep
   * settles those reservations and projects the same final media result once;
   * the terminal Turn is never requeued and its status, cancel request and
   * Session active pointer are never touched.
   *
   * The candidate read is unlocked. Every mutation then locks
   * actor -> Session -> Turn -> Tool -> Jobs, matching the media event path.
   */
  settleAbandonedMedia(limit: number): Promise<AgentRecoveryOutcome> {
    bound(limit)
    return this.tx(async c => {
      const candidates = (await c.query<Row>(`SELECT x.id,x.turn_id,x.session_id,s.owner_id
        FROM agent_tool_calls x
        JOIN agent_turns t ON t.id=x.turn_id AND t.session_id=x.session_id
        JOIN agent_sessions s ON s.id=x.session_id
        WHERE x.status='waiting_external' AND t.status IN ${TERMINAL_TURNS}
          AND EXISTS (SELECT 1 FROM agent_tool_job_links l
            WHERE l.tool_call_id=x.id AND l.turn_id=x.turn_id AND l.session_id=x.session_id)
          AND NOT EXISTS (SELECT 1 FROM agent_tool_job_links l
            JOIN generation_jobs j ON j.id=l.media_job_id
            WHERE l.tool_call_id=x.id AND l.turn_id=x.turn_id AND l.session_id=x.session_id
              AND j.status NOT IN ${TERMINAL_JOBS})
        ORDER BY x.turn_id,(SELECT MIN(l.position) FROM agent_tool_job_links l
          WHERE l.tool_call_id=x.id AND l.turn_id=x.turn_id AND l.session_id=x.session_id),x.id
        LIMIT $1`, [limit])).rows
      let processed = 0
      for (const candidate of candidates) {
        // The actor lock only imposes the shared order; a terminal Turn is
        // settled even when its owner is no longer active.
        const actor = (await c.query(`SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE`,
          [candidate.owner_id])).rows[0]
        if (!actor) continue
        const session = (await c.query<Row>(`SELECT * FROM agent_sessions
          WHERE id=$1 AND owner_id=$2 FOR UPDATE SKIP LOCKED`,
        [candidate.session_id, candidate.owner_id])).rows[0]
        if (!session) continue
        const turn = (await c.query<Row>(`SELECT * FROM agent_turns
          WHERE id=$1 AND session_id=$2 AND status IN ${TERMINAL_TURNS} FOR UPDATE SKIP LOCKED`,
        [candidate.turn_id, candidate.session_id])).rows[0]
        if (!turn) continue
        const call = (await c.query<Row>(`SELECT * FROM agent_tool_calls
          WHERE id=$1 AND turn_id=$2 AND session_id=$3 AND status='waiting_external' FOR UPDATE`,
        [candidate.id, candidate.turn_id, candidate.session_id])).rows[0]
        if (!call) continue
        // A paired Tool already settled its reservations with that pair.
        if ((await c.query(`SELECT id FROM agent_items WHERE tool_call_id=$1 AND item_type='tool_result'`,
          [call.id])).rows.length) continue
        // Re-check under locks: a stale candidate may have gained a Job or lost
        // the terminal status read without locks.
        const links = (await c.query<Row>(`SELECT l.media_job_id,l.owner_id,l.position,j.status
          FROM agent_tool_job_links l
          JOIN generation_jobs j ON j.id=l.media_job_id AND j.created_by=l.owner_id
          WHERE l.tool_call_id=$1 AND l.turn_id=$2 AND l.session_id=$3
          ORDER BY l.position FOR SHARE OF j`, [call.id, call.turn_id, call.session_id])).rows
        if (!links.length) continue
        if (links.some(link => !['succeeded', 'failed', 'canceled'].includes(link.status))) continue
        const jobs: { jobId: string; status: string; assetIds: string[] }[] = []
        let outputsMissing = false
        for (const link of links) {
          const assets = (await c.query<Row>(`SELECT a.id FROM generation_outputs o JOIN assets a ON a.id=o.asset_id
            WHERE o.job_id=$1 AND a.job_id=$1 AND a.created_by=$2 ORDER BY a.id`,
          [link.media_job_id, link.owner_id])).rows
          // Same gate as the event path: a success cannot settle before its outputs exist.
          if (link.status === 'succeeded' && !assets.length) { outputsMissing = true; break }
          jobs.push({ jobId: String(link.media_job_id), status: String(link.status),
            assetIds: assets.map(asset => String(asset.id)) })
        }
        if (outputsMissing) continue
        const status = jobs.some(job => job.status === 'failed') ? 'failed'
          : jobs.some(job => job.status === 'canceled') ? 'cancelled' : 'completed'
        const result = { content: status === 'completed'
          ? `Media generation completed: ${jobs.map(job => job.jobId).join(', ')}`
          : status === 'failed' ? 'Media generation failed.' : 'Media generation cancelled.', jobs }
        const error = status === 'failed' ? FINAL_MEDIA_FAILED
          : status === 'cancelled' ? FINAL_MEDIA_CANCELLED : null

        await settleLinkedAgentMediaReservations(c, { id: call.id, turn_id: call.turn_id, session_id: call.session_id })
        const tool = (await c.query<Row & FinalToolRow>(`UPDATE agent_tool_calls SET status=$2,result=$3::jsonb,error=$4::jsonb,updated_at=clock_timestamp()
          WHERE id=$1 AND session_id=$5 AND turn_id=$6 AND status='waiting_external'
          RETURNING *`,
        [call.id, status, json(result), error ? json(error) : null, call.session_id, call.turn_id])).rows[0]
        if (!tool) throw new AgentCoreError('UNAVAILABLE')
        // The Turn already reached its final revision: the pair is projected at
        // that revision, without a turn update or a dependency wake.
        await projectAgentFinalToolResult(c,
          { ownerId: session.owner_id, sessionId: call.session_id, turnId: call.turn_id }, tool, turn.revision)
        processed++
      }
      return { kind: 'media', processed, remaining: candidates.length === limit }
    })
  }
}
