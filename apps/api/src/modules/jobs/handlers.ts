import { db, transaction } from '../../../../../packages/database/src/index'
import { fail, ok } from '../../shared/http'
import { jobDto } from '../../shared/dto'
import { limited } from '../../shared/redis'
import { loadJobInputs, loadSingleJobInputs, userJobSelect } from '../../shared/pagination'
import { retryPreparation } from '../../generation/job-retry'
import { validateRetryRequest, type RetryRejection } from '../../generation/retry-validation'
import type { AuthedContext } from '../../router/types'
import { deleteJobWithAssets } from '../generations/handlers'
import { jobOutputSelect } from './queries'

/** GET /api/jobs — the owning user's most recent fifty jobs. */
export async function listJobs(context: AuthedContext) {
  const result = await db().query(`${userJobSelect} WHERE j.created_by=$1 AND j.deleted_at IS NULL ORDER BY j.created_at DESC LIMIT 50`, [context.actor.id])
  const jobIds = result.rows.map(row => row.id)
  const inputsByJobId = await loadJobInputs(db(), jobIds)
  return ok({
    items: await Promise.all(result.rows.map(async row => jobDto(row, (await db().query(jobOutputSelect, [row.id])).rows, inputsByJobId[row.id as string] || []))),
    total: result.rowCount,
    hasMore: false,
  })
}

/** GET /api/jobs/:id */
export async function getJob(context: AuthedContext) {
  const id = context.params.id
  const result = await db().query(`${userJobSelect} WHERE j.id=$1 AND j.created_by=$2 AND j.deleted_at IS NULL`, [id, context.actor.id])
  if (!result.rows[0]) return fail('NOT_FOUND', '任务不存在', 404)
  const outputs = await db().query(jobOutputSelect, [id])
  const inputs = await loadSingleJobInputs(db(), id)
  return ok(await jobDto(result.rows[0], outputs.rows, inputs))
}

/**
 * POST /api/jobs/:id/cancel — cooperative.
 *
 * A queued or waiting job is cancelled outright. An active one only records local
 * intent plus an outbox event: the worker owns the provider call, and claiming
 * success here would be a lie the UI would have to walk back.
 */
export async function cancelJob(context: AuthedContext) {
  const id = context.params.id
  const { actor } = context
  if (await limited(`gen:cancel:${actor.id}`, 60, 60)) return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
  const outcome = await transaction(async client => {
    const current = await client.query('SELECT id,status,attempt FROM generation_jobs WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL FOR UPDATE', [id, actor.id])
    const job = current.rows[0]
    if (!job) return { kind: 'not_found' as const }
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
      return { kind: 'not_cancelable' as const }
    }
    if (job.status === 'queued' || job.status === 'retry_wait') {
      await client.query("UPDATE generation_jobs SET status='canceled',completed_at=now(),updated_at=now() WHERE id=$1", [id])
      return { kind: 'canceled' as const }
    }
    // Active job: cooperative cancel. Record local intent and enqueue provider
    // cancel work; never claim success on local intent alone.
    await client.query('UPDATE generation_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now() WHERE id=$1', [id])
    await client.query("INSERT INTO outbox_events(event_type,aggregate_id,payload,dedupe_key) VALUES('generation.cancel.requested',$1,$2,$3) ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING", [id, { jobId: id }, `cancel:${id}:a${job.attempt}`])
    try {
      await client.query("UPDATE provider_runs SET operation_state='canceling',next_action_at=now(),updated_at=now() WHERE job_id=$1 AND operation_state IN ('submitting','submission_unknown','waiting','importing')", [id])
    } catch {
      // provider_runs table may not exist on older databases; outbox carries the intent.
    }
    return { kind: 'cancel_requested' as const }
  })
  if (outcome.kind === 'not_found' || outcome.kind === 'not_cancelable') {
    return fail('JOB_NOT_CANCELABLE', '任务无法取消', 409)
  }
  const responseRow = await db().query(`${userJobSelect} WHERE j.id=$1 AND j.created_by=$2`, [id, actor.id])
  const jobInputs = await loadSingleJobInputs(db(), id)
  const outputs = outcome.kind === 'canceled' ? [] : (await db().query(jobOutputSelect, [id])).rows
  return ok(await jobDto(responseRow.rows[0] || { id }, outputs, jobInputs))
}

type RetryOutcome =
  | { kind: 'not-found' }
  | { kind: 'rejected'; rejection: RetryRejection }
  | { kind: 'retried'; row: Record<string, unknown> }

/** POST /api/jobs/:id/retry — requeues the same job row, never creates a new one. */
export async function retryJob(context: AuthedContext) {
  const id = context.params.id
  const { actor } = context
  if (await limited(`gen:retry:${actor.id}`, 30, 60)) return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
  // The transaction reports *why* it produced no row rather than writing to a
  // captured outer variable: an outer `let` narrowed to `null` at its
  // declaration is invisible to control-flow analysis across the callback, and
  // "no row" would otherwise be reported as a plain not-retryable for a job
  // that was actually refused on validation.
  const outcome = await transaction<RetryOutcome>(async client => {
    const current = await client.query(`SELECT j.id,j.model_id,j.model_revision_id,j.normalized_request,j.prompt_optimization_id,j.optimization_mode,po.final_prompt,po.template_instruction_snapshot
      FROM generation_jobs j LEFT JOIN prompt_optimizations po ON po.id=j.prompt_optimization_id AND po.deleted_at IS NULL
      WHERE j.id=$1 AND j.created_by=$2 AND j.status=$3 AND j.deleted_at IS NULL FOR UPDATE OF j`, [id, actor.id, 'failed'])
    const job = current.rows[0]
    if (!job) return { kind: 'not-found' }

    // A retry is a resubmit, so the stored parameters are checked again rather
    // than waved through because they once passed. Bailing out before any
    // UPDATE leaves the rejected job exactly as it was.
    const validation = await validateRetryRequest(client, {
      id: job.id as string,
      modelId: job.model_id as string,
      revisionId: (job.model_revision_id as string) ?? null,
      normalizedRequest: job.normalized_request,
    })
    if (!validation.ok) return { kind: 'rejected', rejection: validation }

    const preparation = retryPreparation(job)
    if (preparation.resetOptimization) await client.query("UPDATE prompt_optimizations SET status='pending',attempt=0,error_code=NULL,started_at=NULL,completed_at=NULL,updated_at=now() WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL", [job.prompt_optimization_id, actor.id])
    const updated = await client.query("UPDATE generation_jobs SET status='queued',phase=$3,attempt=0,progress=0,cancel_requested_at=NULL,error_code=NULL,provider_error=NULL,provider_reference_id=NULL,started_at=NULL,completed_at=NULL,updated_at=now() WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL RETURNING *", [id, actor.id, preparation.phase])
    await client.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('generation.retry.manual',$1,$2)", [id, { jobId: id }])
    return { kind: 'retried', row: updated.rows[0] as Record<string, unknown> }
  })
  if (!outcome || outcome.kind === 'not-found') return fail('JOB_NOT_RETRYABLE', '任务无法重试', 409)
  if (outcome.kind === 'rejected') {
    const { code, message, status, details } = outcome.rejection
    return fail(code, message, status, details)
  }
  const row = outcome.row
  const responseRow = await db().query(`${userJobSelect} WHERE j.id=$1 AND j.created_by=$2`, [row.id, actor.id])
  const jobInputs = await loadSingleJobInputs(db(), row.id as string)
  return ok(await jobDto(responseRow.rows[0] || row, [], jobInputs), { status: 202 })
}

/** DELETE /api/jobs/:id */
export async function deleteJob(context: AuthedContext) {
  const deleted = await deleteJobWithAssets(context.actor.id, context.params.id)
  return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '任务不存在', 404)
}
