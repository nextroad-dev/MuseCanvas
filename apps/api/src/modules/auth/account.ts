import { db } from '../../../../../packages/database/src/index'
import { writeAudit } from '../../shared/audit'
import { oauthIdentityDto } from '../../shared/dto'
import { fail, ok } from '../../shared/http'
import type { OAuthProvider } from '../../auth/oauth'
import type { AuthedContext } from '../../router/types'
import { startOAuth } from './oauth-flow'

/** GET /api/account/oauth — linked identities, oldest link first. */
export async function listLinkedIdentities(context: AuthedContext) {
  const result = await db().query('SELECT * FROM oauth_identities WHERE user_id=$1 AND deleted_at IS NULL ORDER BY linked_at', [context.actor.id])
  return ok(result.rows.map(oauthIdentityDto))
}

/** GET /api/account/oauth/:oauth/link/start */
export function startLink(context: AuthedContext) {
  return startOAuth(context.params.oauth as OAuthProvider, 'link', context.actor.id)
}

/**
 * DELETE /api/account/oauth/:oauth
 *
 * Soft-deletes the link only; the user row and its sessions are untouched, since
 * password/OTP login remains available.
 */
export async function unlinkIdentity(context: AuthedContext) {
  const provider = context.params.oauth as OAuthProvider
  const result = await db().query('UPDATE oauth_identities SET deleted_at=now() WHERE user_id=$1 AND provider=$2 AND deleted_at IS NULL RETURNING id', [context.actor.id, provider])
  if (result.rows[0]) await writeAudit(db(), context.actor.id, 'oauth.unlink', 'oauth_identity', result.rows[0].id, { provider })
  return result.rows[0] ? ok({ unlinked: true }) : fail('NOT_FOUND', '未绑定该第三方账户', 404)
}
