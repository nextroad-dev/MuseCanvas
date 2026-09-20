import { db, getOnboardingState } from '../../../../../packages/database/src/index'
import { derivePurposeKey } from '../../../../../packages/providers/src/index'
import { fail, ok } from '../../shared/http'

/**
 * GET /api/health/ready.
 *
 * `deploy/compose.yaml` polls this as the api service healthcheck, so the three
 * distinct 503 conditions (database unreachable, key derivation unavailable) and
 * the `setupComplete` flag are all operator-visible contract, not incidental.
 */
export async function readiness() {
  try {
    await db().query('SELECT 1')
  } catch {
    return fail('DEPENDENCY_UNAVAILABLE', '服务尚未就绪', 503)
  }
  try {
    derivePurposeKey('session-hmac')
  } catch {
    return fail('DEPENDENCY_UNAVAILABLE', '服务尚未就绪', 503)
  }
  let setupComplete = false
  try {
    setupComplete = (await getOnboardingState(db()))?.status === 'complete'
  } catch {
    setupComplete = false
  }
  return ok({ status: 'ready', setupComplete })
}
