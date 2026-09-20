import { db } from '../../../../../packages/database/src/index'
import { modelDto, publicModelDto } from '../../shared/dto'
import { ok } from '../../shared/http'

/**
 * Model catalog reads.
 *
 * `handlers.ts` beside this file owns the admin write path; reads live here so
 * the SELECT that feeds every picker in the console has one home. Both queries
 * bind to `latest_revision_id`, which is what makes the immutable revision the
 * authority for capabilities instead of the mutable `model_configs` columns.
 */

export async function listPublicModels() {
  const result = await db().query(
    `SELECT m.*, rev.capabilities, rev.defaults, rev.revision, rev.id AS revision_id
       FROM model_configs m LEFT JOIN model_config_revisions rev ON rev.id = m.latest_revision_id
       WHERE m.model_kind IN ('image','video') AND m.enabled=true AND m.deleted_at IS NULL ORDER BY m.sort_order,m.created_at`,
  )
  return ok(result.rows.map(publicModelDto))
}

export async function listAdminModels() {
  const result = await db().query('SELECT m.*, pc.display_name AS provider_credential_name, rev.capabilities, rev.defaults, rev.revision FROM model_configs m LEFT JOIN provider_credentials pc ON pc.id=m.provider_credential_id AND pc.deleted_at IS NULL LEFT JOIN model_config_revisions rev ON rev.id=m.latest_revision_id WHERE m.deleted_at IS NULL ORDER BY m.sort_order,m.created_at')
  return ok(result.rows.map(modelDto))
}
