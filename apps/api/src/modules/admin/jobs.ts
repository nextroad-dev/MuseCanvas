import { db } from '../../../../../packages/database/src/index'
import { adminJobDto } from '../../shared/dto'
import { ok } from '../../shared/http'
import { decodeCursor, encodeCursor, boundedLimit } from '../../shared/pagination'
import type { AuthedContext } from '../../router/types'

/** Values `generation_jobs.status` can hold; anything else is ignored, not an error. */
const JOB_STATUSES = ['queued', 'running', 'retry_wait', 'succeeded', 'failed', 'canceled']
const UUID_TEXT = /^[0-9a-f-]{36}$/i

/**
 * GET /api/admin/jobs
 *
 * Same bare-column-then-qualify construction as `admin/users`: `values` push
 * order defines the placeholders, and the count query reuses the list minus the
 * cursor. Filters that fail their own sanity check (a non-uuid `userId`, an
 * unparseable `from`) are dropped silently rather than rejected — that is the
 * behaviour under test, so do not "fix" it into a 400 here.
 */
export async function listJobs(context: AuthedContext) {
  const { request } = context
  const limit = boundedLimit(request)
  const cursor = decodeCursor(request.nextUrl.searchParams.get('cursor'))
  const values: unknown[] = []
  const conditions = ['deleted_at IS NULL']
  const userId = request.nextUrl.searchParams.get('userId')
  const status = request.nextUrl.searchParams.get('status')
  const modelId = request.nextUrl.searchParams.get('modelId')
  const from = request.nextUrl.searchParams.get('from')
  const to = request.nextUrl.searchParams.get('to')
  if (userId && UUID_TEXT.test(userId)) { values.push(userId); conditions.push(`created_by=$${values.length}::uuid`) }
  if (status && JOB_STATUSES.includes(status)) { values.push(status); conditions.push(`status=$${values.length}`) }
  if (modelId && UUID_TEXT.test(modelId)) { values.push(modelId); conditions.push(`model_id=$${values.length}::uuid`) }
  if (from && !Number.isNaN(Date.parse(from))) { values.push(from); conditions.push(`created_at>=$${values.length}::timestamptz`) }
  if (to && !Number.isNaN(Date.parse(to))) { values.push(to); conditions.push(`created_at<=$${values.length}::timestamptz`) }
  if (cursor) { values.push(cursor.createdAt, cursor.id); conditions.push(`(created_at,id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`) }
  const where = conditions.join(' AND ')
  const totalValues = values.slice(0, cursor ? -2 : undefined)
  const totalWhere = cursor ? conditions.slice(0, -1).join(' AND ') : where
  values.push(limit + 1)
  const page = await db().query(`SELECT j.id,j.created_by,j.model_id,j.model_name,j.status,j.phase,j.error_code,j.provider_error,j.provider_reference_id,j.created_at,j.started_at,j.completed_at,po.template_name_snapshot,po.language_model_name_snapshot,po.language_model_vendor_id_snapshot,po.language_model_protocol_snapshot FROM generation_jobs j LEFT JOIN prompt_optimizations po ON po.id=j.prompt_optimization_id WHERE ${where.replaceAll('deleted_at', 'j.deleted_at').replaceAll('created_by', 'j.created_by').replaceAll('status=', 'j.status=').replaceAll('model_id', 'j.model_id').replaceAll('created_at', 'j.created_at').replaceAll('(j.created_at,id)', '(j.created_at,j.id)')} ORDER BY j.created_at DESC,j.id DESC LIMIT $${values.length}`, values)
  const total = await db().query(`SELECT count(*)::int total FROM generation_jobs WHERE ${totalWhere}`, totalValues)
  const hasMore = page.rows.length > limit
  const rows = page.rows.slice(0, limit)
  return ok({ items: rows.map(adminJobDto), total: total.rows[0].total, hasMore, nextCursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : undefined })
}
