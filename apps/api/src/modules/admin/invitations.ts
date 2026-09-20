import { decryptForPurpose, encryptForPurpose } from '../../../../../packages/providers/src/index'
import { db } from '../../../../../packages/database/src/index'
import { hashToken, randomToken } from '../../auth/security'
import { writeAudit } from '../../shared/audit'
import { fail, ok } from '../../shared/http'
import type { AuthedContext } from '../../router/types'

/**
 * Invitation codes are stored twice on purpose: `code_hash` lets a login redeem
 * one without ever decrypting it, and `code_encrypted` exists solely so the admin
 * list can re-display a code an operator lost. A row whose ciphertext cannot be
 * decrypted (different key since it was issued) reads back with no code rather
 * than failing the whole list.
 */
export async function listInvitations() {
  const result = await db().query('SELECT id,consumed_at,revoked_at,created_at,code_encrypted FROM invitations ORDER BY created_at DESC LIMIT 100')
  return ok({
    items: result.rows.map(row => {
      let code: string | undefined
      if (row.code_encrypted) {
        try {
          code = decryptForPurpose(row.code_encrypted as string, 'invitation-codes')
        } catch {
          code = undefined
        }
      }
      return { id: row.id, code, used: !!row.consumed_at, revoked: !!row.revoked_at, createdAt: row.created_at.toISOString() }
    }),
    total: result.rowCount,
    hasMore: false,
  })
}

/** POST /api/admin/invitations — the plaintext code is returned exactly once. */
export async function createInvitation(context: AuthedContext) {
  const code = randomToken(18)
  const envelope = encryptForPurpose(code, 'invitation-codes')
  const result = await db().query("INSERT INTO invitations(email,code_hash,code_encrypted,expires_at,created_by) VALUES(NULL,$1,$2,now()+interval '7 days',$3) RETURNING id,created_at", [hashToken(code), envelope.ciphertext, context.actor.id])
  await writeAudit(db(), context.actor.id, 'invitation.create', 'invitation', result.rows[0].id)
  return ok({ id: result.rows[0].id, code, used: false, createdAt: result.rows[0].created_at.toISOString() })
}

/** DELETE /api/admin/invitations/:id — revoke only an unconsumed, live code. */
export async function revokeInvitation(context: AuthedContext) {
  const id = context.params.id
  const result = await db().query('UPDATE invitations SET revoked_at=now() WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id', [id])
  if (result.rows[0]) await writeAudit(db(), context.actor.id, 'invitation.revoke', 'invitation', id)
  return result.rows[0] ? ok({ revoked: true }) : fail('NOT_FOUND', '邀请码不存在', 404)
}
