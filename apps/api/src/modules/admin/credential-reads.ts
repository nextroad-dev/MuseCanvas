import { db } from '../../../../../packages/database/src/index'
import { providerCredentialDto } from '../../shared/dto'
import { ok } from '../../shared/http'

/**
 * GET /api/admin/provider-credentials
 *
 * Reads live in their own file because `provider-credentials.ts` holds the write
 * path (create/update/delete/test) and returns responses built from decrypted
 * envelopes; this is the list projection only. Newest first, soft-deleted rows
 * never shown.
 */
export async function listProviderCredentials() {
  const result = await db().query('SELECT * FROM provider_credentials WHERE deleted_at IS NULL ORDER BY created_at DESC')
  return ok(result.rows.map(providerCredentialDto))
}
