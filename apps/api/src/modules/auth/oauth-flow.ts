import { NextResponse, type NextRequest } from 'next/server'
import { db, transaction } from '../../../../../packages/database/src/index'
import { hashToken, hashTokenCandidates, randomToken, shouldUseSecureCookie } from '../../auth/security'
import { clientIpFromRequest, fail, ok } from '../../shared/http'
import { writeAudit } from '../../shared/audit'
import { userDto } from '../../shared/dto'
import { limited, redisSet, redisGetDel } from '../../shared/redis'
import { oauthSetting } from './oauth-settings'
import { resolvePublicOrigin } from '../settings/runtime'
import {
  authorizeUrlWithConfig,
  createPkceVerifier,
  exchangeCodeWithConfig,
  fetchProfileWithConfig,
  pkceChallenge,
  type OAuthProfile,
  type OAuthProvider,
} from '../../auth/oauth'

const OAUTH_STATE_TTL = 600

type OAuthStateRecord = {
  mode: 'login' | 'link'
  provider: OAuthProvider
  pkceVerifier: string
  nonce: string
  userId?: string
}

type OAuthChallengeRecord = {
  email: string
  provider: OAuthProvider
  providerSubject: string
  displayName?: string
  avatarUrl?: string
}

async function loginRedirect(code: string): Promise<NextResponse> {
  const origin = await resolvePublicOrigin()
  return NextResponse.redirect(
    `${origin.replace(/\/$/, '')}/login?error=${encodeURIComponent(code)}`,
  )
}

/** Attach a fresh session cookie for the given user to a redirect response. */
async function issueSession(userId: string, response: NextResponse): Promise<NextResponse> {
  const token = randomToken()
  await db().query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')", [userId, hashToken(token)])
  response.cookies.set('muse_session', token, { httpOnly: true, secure: shouldUseSecureCookie(await resolvePublicOrigin()), sameSite: 'lax', path: '/', maxAge: 30 * 86400 })
  return response
}

/** Best-effort audit for paths outside any transaction; must never fail the response. */
async function auditBestEffort(actorId: string, action: string, targetId: string, summary: object): Promise<void> {
  try {
    await writeAudit(db(), actorId, action, 'user', targetId, summary)
  } catch (error) {
    console.error('audit write failed', error)
  }
}

export async function startOAuth(
  provider: OAuthProvider,
  mode: 'login' | 'link',
  userId?: string,
): Promise<NextResponse> {
  const setting = await oauthSetting(provider)
  if (!setting.enabled) return loginRedirect('OAUTH_PROVIDER_DISABLED')
  const state = randomToken(24)
  const pkceVerifier = createPkceVerifier()
  const nonce = randomToken(16)
  const record: OAuthStateRecord = { mode, provider, pkceVerifier, nonce, userId }
  try {
    await redisSet(`oauth:state:${state}`, record, OAUTH_STATE_TTL)
  } catch {
    return loginRedirect('OAUTH_STATE_FAILED')
  }
  return NextResponse.redirect(
    authorizeUrlWithConfig(provider, setting.config, {
      state,
      pkceChallenge: pkceChallenge(pkceVerifier),
      nonce,
    }),
  )
}

export async function handleOAuthCallback(
  request: NextRequest,
  provider: OAuthProvider,
): Promise<NextResponse> {
  const setting = await oauthSetting(provider)
  if (!setting.enabled) return loginRedirect('OAUTH_PROVIDER_DISABLED')
  const params = request.nextUrl.searchParams
  if (params.get('error')) return loginRedirect('OAUTH_DENIED')
  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) return loginRedirect('OAUTH_INVALID_CALLBACK')

  const record = await redisGetDel<OAuthStateRecord>(`oauth:state:${state}`)
  if (!record || record.provider !== provider) return loginRedirect('OAUTH_STATE_EXPIRED')

  let profile: OAuthProfile
  try {
    const tokens = await exchangeCodeWithConfig(provider, setting.config, code, record.pkceVerifier)
    profile = await fetchProfileWithConfig(provider, setting.config, tokens, record.nonce)
  } catch (error) {
    const known =
      error instanceof Error && /^OAUTH_/.test(error.message) ? error.message : 'OAUTH_PROFILE_FAILED'
    return loginRedirect(known)
  }
  if (!profile.emailVerified) return loginRedirect('OAUTH_EMAIL_UNVERIFIED')

  return record.mode === 'link' && record.userId
    ? linkIdentity(record.userId, provider, profile)
    : loginWithIdentity(provider, profile)
}

async function loginWithIdentity(
  provider: OAuthProvider,
  profile: OAuthProfile,
): Promise<NextResponse> {
  const origin = await resolvePublicOrigin()
  const successUrl = (role: string) =>
    `${origin.replace(/\/$/, '')}${role === 'admin' ? '/admin' : '/generate'}`
  // 1. Existing identity → its (active) user logs in.
  const identity = await db().query(
    `SELECT u.id,u.role,u.status FROM oauth_identities oi JOIN users u ON u.id=oi.user_id WHERE oi.provider=$1 AND oi.provider_subject=$2 AND oi.deleted_at IS NULL AND u.deleted_at IS NULL`,
    [provider, profile.providerSubject],
  )
  if (identity.rows[0]) {
    if (identity.rows[0].status !== 'active') return loginRedirect('OAUTH_ACCOUNT_UNAVAILABLE')
    await db().query('UPDATE oauth_identities SET last_login_at=now() WHERE provider=$1 AND provider_subject=$2', [provider, profile.providerSubject])
    const response = await issueSession(identity.rows[0].id, NextResponse.redirect(successUrl(identity.rows[0].role)))
    await auditBestEffort(identity.rows[0].id, 'auth.oauth.login', identity.rows[0].id, { provider, role: identity.rows[0].role })
    return response
  }
  // 2/3. Email matches an existing user.
  const existing = await db().query('SELECT id,role,status FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [profile.email])
  if (existing.rows[0]) {
    if (existing.rows[0].status !== 'active') return loginRedirect('OAUTH_ACCOUNT_UNAVAILABLE')
    try {
      await db().query('INSERT INTO oauth_identities(user_id,provider,provider_subject,email_at_link,email_verified,display_name,avatar_url) VALUES($1,$2,$3,$4,$5,$6,$7)', [existing.rows[0].id, provider, profile.providerSubject, profile.email, profile.emailVerified, profile.displayName || null, profile.avatarUrl || null])
    } catch {
      return loginRedirect('OAUTH_IDENTITY_CONFLICT')
    }
    await auditBestEffort(existing.rows[0].id, 'auth.oauth.identity.auto_merge', existing.rows[0].id, { provider, emailAtLink: profile.email })
    const response = await issueSession(existing.rows[0].id, NextResponse.redirect(successUrl(existing.rows[0].role)))
    await auditBestEffort(existing.rows[0].id, 'auth.oauth.login', existing.rows[0].id, { provider, role: existing.rows[0].role })
    return response
  }
  // 4/5. New email — depends on registration mode.
  const setting = await db().query('SELECT mode FROM registration_settings WHERE singleton=true')
  if (setting.rows[0]?.mode === 'invite_only') {
    const challengeId = randomToken(18)
    const challenge: OAuthChallengeRecord = {
      email: profile.email,
      provider,
      providerSubject: profile.providerSubject,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
    }
    try {
      await redisSet(`oauth:challenge:${challengeId}`, challenge, OAUTH_STATE_TTL)
    } catch {
      return loginRedirect('OAUTH_STATE_FAILED')
    }
    const base = origin.replace(/\/$/, '')
    return NextResponse.redirect(
      `${base}/login?oauth_challenge=${challengeId}&email=${encodeURIComponent(profile.email)}&provider=${provider}`,
    )
  }
  const created = await transaction(async (client) => {
    const user = await client.query('INSERT INTO users(email) VALUES($1) RETURNING id,role', [profile.email])
    await client.query('INSERT INTO oauth_identities(user_id,provider,provider_subject,email_at_link,email_verified,display_name,avatar_url) VALUES($1,$2,$3,$4,$5,$6,$7)', [user.rows[0].id, provider, profile.providerSubject, profile.email, profile.emailVerified, profile.displayName || null, profile.avatarUrl || null])
    return user.rows[0]
  })
  const response = await issueSession(created.id, NextResponse.redirect(successUrl(created.role)))
  await auditBestEffort(created.id, 'auth.oauth.login', created.id, { provider, role: created.role })
  return response
}

async function linkIdentity(
  userId: string,
  provider: OAuthProvider,
  profile: OAuthProfile,
): Promise<NextResponse> {
  const base = (await resolvePublicOrigin()).replace(/\/$/, '')
  const accountRedirect = (code?: string) =>
    NextResponse.redirect(`${base}/account${code ? `?error=${encodeURIComponent(code)}` : '?linked=1'}`)
  // The OAuth email must match the logged-in account's email.
  const user = await db().query('SELECT id FROM users WHERE id=$1 AND lower(email)=$2 AND deleted_at IS NULL', [userId, profile.email])
  if (!user.rows[0]) return accountRedirect('OAUTH_EMAIL_MISMATCH')
  try {
    await db().query('INSERT INTO oauth_identities(user_id,provider,provider_subject,email_at_link,email_verified,display_name,avatar_url) VALUES($1,$2,$3,$4,$5,$6,$7)', [userId, provider, profile.providerSubject, profile.email, profile.emailVerified, profile.displayName || null, profile.avatarUrl || null])
  } catch {
    return accountRedirect('OAUTH_IDENTITY_CONFLICT')
  }
  await auditBestEffort(userId, 'auth.oauth.identity.link', userId, { provider, emailAtLink: profile.email })
  return accountRedirect()
}

/** Thrown inside the invitation transaction to roll everything back and answer with a prepared response. */
class InvitationFlowAbort extends Error {
  constructor(readonly response: NextResponse) {
    super('invitation flow aborted')
    this.name = 'InvitationFlowAbort'
  }
}

export async function completeOAuthInvitation(
  request: NextRequest,
  input: Record<string, unknown>,
): Promise<NextResponse> {
  const challengeId = typeof input.challengeId === 'string' ? input.challengeId : ''
  const invitationCode = typeof input.invitationCode === 'string' ? input.invitationCode.trim() : ''
  if (!challengeId || !invitationCode) return fail('INVALID_INPUT', '缺少注册参数')
  const ip = clientIpFromRequest(request)
  if (await limited(`oauth-invite:${ip}`, 10, 600)) return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
  const challenge = await redisGetDel<OAuthChallengeRecord>(`oauth:challenge:${challengeId}`)
  if (!challenge) return fail('OAUTH_REGISTRATION_EXPIRED', '注册会话已过期，请重新登录', 410)
  let result: { token: string; user: Record<string, unknown> } | null = null
  try {
    result = await transaction(async (client) => {
      const invite = await client.query('UPDATE invitations SET consumed_at=now() WHERE code_hash = ANY($1) AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING id', [hashTokenCandidates(invitationCode)])
      if (!invite.rows[0]) return null
      const existing = await client.query('SELECT id,status FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [challenge.email])
      let userId: string
      if (existing.rows[0]) {
        // The account was disabled after the OAuth challenge was issued; do not fall through to the new-user branch.
        if (existing.rows[0].status !== 'active') throw new InvitationFlowAbort(fail('ACCOUNT_UNAVAILABLE', '账户当前不可用', 403))
        userId = existing.rows[0].id
      } else {
        const newUser = await client.query('INSERT INTO users(email) VALUES($1) RETURNING id', [challenge.email])
        userId = newUser.rows[0].id
      }
      try {
        await client.query('INSERT INTO oauth_identities(user_id,provider,provider_subject,email_at_link,email_verified,display_name,avatar_url) VALUES($1,$2,$3,$4,true,$5,$6)', [userId, challenge.provider, challenge.providerSubject, challenge.email, challenge.displayName || null, challenge.avatarUrl || null])
      } catch {
        // oauth_provider_subject_active_key conflict: the subject is already linked to another account.
        throw new InvitationFlowAbort(fail('OAUTH_IDENTITY_CONFLICT', '该第三方账号已绑定其他用户', 409))
      }
      const token = randomToken()
      await client.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')", [userId, hashToken(token)])
      const userRow = await client.query('SELECT id,email,role,status,created_at FROM users WHERE id=$1', [userId])
      await writeAudit(client, userId, 'auth.oauth.login', 'user', userId, { via: 'invitation', provider: challenge.provider, role: userRow.rows[0].role })
      return { token, user: userRow.rows[0] }
    })
  } catch (error) {
    if (error instanceof InvitationFlowAbort) return error.response
    throw error
  }
  if (!result) return fail('INVALID_INVITATION', '邀请码无效或已过期')
  const response = ok({ user: userDto(result.user) })
  response.cookies.set('muse_session', result.token, { httpOnly: true, secure: shouldUseSecureCookie(await resolvePublicOrigin()), sameSite: 'lax', path: '/', maxAge: 30 * 86400 })
  return response
}