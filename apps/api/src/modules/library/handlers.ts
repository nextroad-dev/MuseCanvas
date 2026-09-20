import { db } from '../../../../../packages/database/src/index'
import { decodeCursor, encodeCursor, boundedLimit } from '../../shared/pagination'
import { fail, ok } from '../../shared/http'
import { signedAssetUrl } from '../../shared/services'
import type { AuthedContext } from '../../router/types'
import { deleteJobWithAssets } from '../generations/handlers'
import { libraryAssetDto } from './dto'
import { LIBRARY_FROM_CLAUSE, LIBRARY_SELECT_COLUMNS } from './queries'

/** GET /api/library — keyset-paginated, owner-scoped, filterable gallery. */
export async function listLibrary(context: AuthedContext) {
  const { request, actor } = context
  const limit = boundedLimit(request)
  const cursor = decodeCursor(request.nextUrl.searchParams.get('cursor'))
  const search = (request.nextUrl.searchParams.get('q') || '').trim().slice(0, 100)
  const kind = request.nextUrl.searchParams.get('kind')
  const eligibleOnly = request.nextUrl.searchParams.get('eligible') === 'true'

  // One owner-scoped predicate list, reused verbatim by the page query and the
  // count, so a filter can never be applied to one and forgotten in the other.
  const values: unknown[] = [actor.id]
  const conditions = ['a.created_by=$1', 'a.deleted_at IS NULL', 'j.deleted_at IS NULL']
  if (kind === 'image' || kind === 'video') { values.push(kind); conditions.push(`a.media_kind=$${values.length}`) }
  if (eligibleOnly) {
    // Only PNG/JPEG bytes can become a generation input (`inspectImageBytes`), so
    // the picker can ask for what it is actually able to use. Without this a page
    // of 30 could hold two selectable rows and read as a broken gallery.
    conditions.push(`a.media_kind='image' AND a.mime_type IN ('image/png','image/jpeg')`)
  }
  if (search) {
    // `assets` has no filename or tag columns — the prompt is the only label that
    // exists, so search means the prompt and nothing else.
    values.push(`%${search}%`)
    conditions.push(`(COALESCE(po.input_prompt,a.prompt) ILIKE $${values.length} OR po.final_prompt ILIKE $${values.length})`)
  }
  // Keyset on (created_at,id): `id` breaks ties, which a plain created_at cursor
  // cannot, and a batch of same-instant inserts would skip or repeat rows.
  if (cursor) { values.push(cursor.createdAt, cursor.id); conditions.push(`(a.created_at,a.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`) }
  const where = conditions.join(' AND ')
  // The cursor says where we are, not how many match: drop it from the total.
  const totalValues = cursor ? values.slice(0, -2) : values
  const totalWhere = cursor ? conditions.slice(0, -1).join(' AND ') : where
  values.push(limit + 1)
  const page = await db().query(`${LIBRARY_SELECT_COLUMNS}
      ${LIBRARY_FROM_CLAUSE} WHERE ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT $${values.length}`, values)
  const total = await db().query(`SELECT count(*)::int total ${LIBRARY_FROM_CLAUSE} WHERE ${totalWhere}`, totalValues)
  const hasMore = page.rows.length > limit
  const rows = page.rows.slice(0, limit)
  return ok({
    items: await Promise.all(rows.map(libraryAssetDto)),
    total: total.rows[0]?.total ?? rows.length,
    hasMore,
    nextCursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : undefined,
  })
}

/** GET /api/library/:id/download */
export async function downloadAsset(context: AuthedContext) {
  const result = await db().query('SELECT id,object_key,media_kind,mime_type,duration_seconds FROM assets WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL', [context.params.id, context.actor.id])
  if (!result.rows[0]) return fail('NOT_FOUND', '资源不存在', 404)
  const row = result.rows[0]
  const url = await signedAssetUrl(row.object_key as string)
  return ok({ url, downloadUrl: url, mediaKind: (row.media_kind as string) || 'image', mimeType: row.mime_type })
}

/**
 * DELETE /api/library/:id
 *
 * Deleting an asset deletes its whole job, because outputs are only ever
 * reachable through one. An already-deleted row answers the same as a freshly
 * deleted one so a double click is not an error.
 */
export async function deleteAsset(context: AuthedContext) {
  const owned = await db().query('SELECT job_id,deleted_at FROM assets WHERE id=$1 AND created_by=$2', [context.params.id, context.actor.id])
  if (!owned.rows[0]) return fail('NOT_FOUND', '图片不存在', 404)
  if (owned.rows[0].deleted_at) return ok({ deleted: true })
  await deleteJobWithAssets(context.actor.id, owned.rows[0].job_id)
  return ok({ deleted: true })
}
