import { db, transaction } from '../../../../../packages/database/src/index'
import { writeAudit } from '../../shared/audit'
import { userDto } from '../../shared/dto'
import { fail, ok } from '../../shared/http'
import { decodeCursor, encodeCursor, boundedLimit } from '../../shared/pagination'
import type { AuthedContext } from '../../router/types'

/**
 * GET /api/admin/users
 *
 * The condition list is written against bare column names and then qualified for
 * the `users u` alias by string substitution. That is fragile and it is also the
 * current behaviour: the push order of `values` determines every `$n` placeholder,
 * and the count query deliberately reuses the same list minus the cursor. Any
 * edit here must keep both orders intact.
 */
export async function listUsers(context: AuthedContext) {
  const { request } = context
  const limit = boundedLimit(request)
  const cursor = decodeCursor(request.nextUrl.searchParams.get('cursor'))
  const values: unknown[] = []
  const conditions = ['deleted_at IS NULL']
  const status = request.nextUrl.searchParams.get('status')
  const email = request.nextUrl.searchParams.get('email')?.trim()
  if (status === 'active' || status === 'disabled') { values.push(status); conditions.push(`status=$${values.length}`) }
  if (email) { values.push(`%${email}%`); conditions.push(`email ILIKE $${values.length}`) }
  if (cursor) { values.push(cursor.createdAt, cursor.id); conditions.push(`(created_at,id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`) }
  const where = conditions.join(' AND ')
  const totalValues = values.slice(0, cursor ? -2 : undefined)
  const totalWhere = cursor ? conditions.slice(0, -1).join(' AND ') : where
  values.push(limit + 1)
  const page = await db().query(`SELECT u.id,u.email,u.role,u.status,u.created_at FROM users u WHERE ${where.replaceAll('deleted_at', 'u.deleted_at').replaceAll('created_at', 'u.created_at').replaceAll('(u.created_at,id)', '(u.created_at,u.id)')} ORDER BY u.created_at DESC,u.id DESC LIMIT $${values.length}`, values)
  const total = await db().query(`SELECT count(*)::int total FROM users WHERE ${totalWhere}`, totalValues)
  const hasMore = page.rows.length > limit
  const rows = page.rows.slice(0, limit)
  return ok({
    items: rows.map(row => userDto(row)),
    total: total.rows[0].total,
    hasMore,
    nextCursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : undefined,
  })
}

/**
 * PATCH /api/admin/users/:id (and the identical `/:id/status` alias).
 *
 * Disabling a user revokes their sessions in the same transaction and bumps
 * `session_version`, so an in-flight request cannot keep an old token alive.
 */
export async function setUserStatus(context: AuthedContext) {
  const { actor } = context
  const input = await context.json()
  const id = context.params.id
  if (input.status !== 'active' && input.status !== 'disabled') return fail('INVALID_INPUT', '用户状态无效')
  if (id === actor.id && input.status === 'disabled') return fail('INVALID_OPERATION', '不能停用当前管理员')
  const updated = await transaction(async client => {
    const result = await client.query('UPDATE users SET status=$1,session_version=session_version+1,updated_at=now() WHERE id=$2 AND deleted_at IS NULL RETURNING *', [input.status, id])
    if (input.status === 'disabled') await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id])
    if (result.rows[0]) await writeAudit(client, actor.id, 'user.status', 'user', id, { status: input.status })
    return result.rows[0]
  })
  return updated ? ok(userDto(updated)) : fail('NOT_FOUND', '用户不存在', 404)
}

/**
 * DELETE /api/admin/users/:id
 *
 * Soft-deletes and hands the byte cleanup to the worker via `deletion_jobs`;
 * the request never touches object storage itself.
 */
export async function deleteUser(context: AuthedContext) {
  const { actor } = context
  const id = context.params.id
  if (id === actor.id) return fail('INVALID_OPERATION', '不能删除当前管理员')
  const deleted = await transaction(async client => {
    const result = await client.query('UPDATE users SET deleted_at=now(),deletion_requested_at=now(),session_version=session_version+1,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id', [id])
    if (!result.rows[0]) return false
    await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id])
    await client.query("UPDATE generation_jobs SET status='canceled',completed_at=now() WHERE created_by=$1 AND status IN('queued','retry_wait','running')", [id])
    await client.query('INSERT INTO deletion_jobs(user_id) VALUES($1) ON CONFLICT DO NOTHING', [id])
    await client.query("UPDATE generation_input_images SET status='deleted',deleted_at=now() WHERE created_by=$1", [id])
    await writeAudit(client, actor.id, 'user.delete', 'user', id)
    return true
  })
  return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '用户不存在', 404)
}
