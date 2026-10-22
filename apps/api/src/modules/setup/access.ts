import type { NextRequest, NextResponse } from 'next/server'
import { db, getOnboardingState, getValidSetupSession } from '@musecanvas/database'
import { hmacForPurpose } from '@musecanvas/providers'
import { actorFrom } from '../../auth/security'
import { fail } from '../../shared/http'
import { resolveClaimRequired } from './claim-required'

// Shared by handlers.ts and database.ts so neither has to import the other.
export const SETUP_COOKIE = 'muse_setup'

export interface SetupOpenFacts {
  onboardingComplete: boolean
  activeAdminCount: number
}

/**
 * Open mode for deployments that set SETUP_CLAIM_REQUIRED=false: setup needs no cookie
 * while onboarding is incomplete and no active admin exists. Any failure to read the
 * facts, or a required claim, keeps setup closed. Facts are injected so the matrix is testable.
 */
export async function setupOpenWithoutClaim(
  claimRequired: boolean,
  readFacts: () => Promise<SetupOpenFacts>,
): Promise<boolean> {
  if (claimRequired) return false
  try {
    const facts = await readFacts()
    return !facts.onboardingComplete && facts.activeAdminCount === 0
  } catch {
    return false
  }
}

async function readSetupOpenFacts(): Promise<SetupOpenFacts> {
  const [state, admins] = await Promise.all([
    getOnboardingState(db()),
    db().query("SELECT count(*)::int AS cnt FROM users WHERE role='admin' AND deleted_at IS NULL"),
  ])
  // A missing onboarding row is treated as incomplete, matching setupStatus.
  return { onboardingComplete: state?.status === 'complete', activeAdminCount: admins.rows[0].cnt }
}

async function setupSessionValid(raw: string | undefined): Promise<boolean> {
  if (!raw) return false
  try {
    return !!(await getValidSetupSession(db(), hmacForPurpose(raw, 'setup-session')))
  } catch {
    return false
  }
}

export async function hasSetupAccess(request: NextRequest): Promise<boolean> {
  if (await setupOpenWithoutClaim(resolveClaimRequired(process.env), readSetupOpenFacts)) return true
  if (await setupSessionValid(request.cookies.get(SETUP_COOKIE)?.value)) {
    // A setup session only grants access while onboarding is open; after
    // completion, leftover sessions fall through to the admin role check.
    const state = await getOnboardingState(db()).catch((): null => null)
    if (state?.status !== 'complete') return true
  }
  try {
    const actor = await actorFrom(request)
    return !!actor && actor.role === 'admin'
  } catch {
    return false
  }
}

export async function requireSetupAccess(request: NextRequest): Promise<NextResponse | null> {
  if (await hasSetupAccess(request)) return null
  return fail('SETUP_SESSION_INVALID', '无初始化访问权限，请先验证一次性验证码', 401)
}
