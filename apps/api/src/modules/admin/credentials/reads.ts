import { db } from '@musecanvas/database'
import { providerCredentialDto } from '../../../shared/dto'
import { ok } from '../../../shared/http'

/**
 * GET /api/admin/provider-credentials
 *
 * The list projection only: writes live in `service.ts` and connectivity tests in
 * `connectivity.ts`, the two places that ever handle a plaintext secret. Newest
 * first, soft-deleted rows never shown.
 */
export async function listProviderCredentials() {
  const result = await db().query('SELECT * FROM provider_credentials WHERE deleted_at IS NULL ORDER BY created_at DESC')
  return ok(result.rows.map(providerCredentialDto))
}
