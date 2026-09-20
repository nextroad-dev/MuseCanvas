import { db, transaction } from '../../../../../packages/database/src/index'
import { writeAudit } from '../../shared/audit'
import type { AuthedContext, PublicContext } from '../../router/types'
import { fail, ok } from '../../shared/http'

/**
 * `GET /api/registration` and `GET /api/admin/registration` answer from the same
 * query with the same payload; only the access gate differs, so the query lives
 * here once and the route table carries the two access levels.
 */
export async function registrationMode(_context: PublicContext | AuthedContext) {
  const result = await db().query('SELECT mode FROM registration_settings WHERE singleton=true')
  return ok({ requiresInvitation: result.rows[0]?.mode === 'invite_only' })
}

/** GET /api/session — the real session endpoint; `/auth/me` has never existed. */
export function readSession(context: AuthedContext) {
  return ok({ user: context.actor })
}

/**
 * PATCH /api/admin/registration
 *
 * Echoes back exactly the boolean it was given rather than re-reading the row, so
 * the response is the caller's own value and not a race with another writer.
 */
export async function setRegistrationMode(context: AuthedContext) {
  const input = await context.json()
  if (typeof input.requiresInvitation !== 'boolean') return fail('INVALID_INPUT', '注册模式无效')
  const mode = input.requiresInvitation ? 'invite_only' : 'open'
  await transaction(async client => {
    await client.query('UPDATE registration_settings SET mode=$1,updated_at=now(),updated_by=$2 WHERE singleton=true', [mode, context.actor.id])
    await writeAudit(client, context.actor.id, 'registration.update', 'registration', 'singleton', { requiresInvitation: input.requiresInvitation })
  })
  return ok({ requiresInvitation: input.requiresInvitation })
}
