import { NextResponse, type NextRequest } from 'next/server'
import { db, transaction } from '../../../../../packages/database/src/index'
import { hashToken, randomToken } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { userDto } from '../../shared/dto'
import { limited, redisSet, redisGetDel } from '../../shared/redis'
import { oauthSetting } from './oauth-settings'
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

const loginRedirect = (code: string) =>
  NextResponse.redirect(
    `${(process.env.OAUTH_REDIRECT_BASE_URL || '').replace(/\/$/, '')}/login?error=${encodeURIComponent(code)}`,
  )

/** Attach a fresh session cookie for the given user to a redirect response. */
async function issueSession(userId: string, response: NextResponse): Promise<NextResponse> {
  const token = randomToken()
  await db().query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')", [userId, hashToken(token)])
  response.cookies.set('muse_session', token, { httpOnly: true, secure: process.env.COOKIE_SECURE === 'true', sameSite: 'lax', path: '/', maxAge: 30 * 86400 })
  return response
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
  const successUrl = (role: string) =>
    `${(process.env.OAUTH_REDIRECT_BASE_URL || '').replace(/\/$/, '')}${role === 'admin' ? '/admin' : '/generate'}`
  // 1. Existing identity → its (active) user logs in.
  const identity = await db().query(
    `SELECT u.id,u.role,u.status FROM oauth_identities oi JOIN users u ON u.id=oi.user_id WHERE oi.provider=$1 AND oi.provider_subject=$2 AND oi.deleted_at IS NULL AND u.deleted_at IS NULL`,
    [provider, profile.providerSubject],
  )
  if (identity.rows[0]) {
    if (identity.rows[0].status !== 'active') return loginRedirect('OAUTH_ACCOUNT_UNAVAILABLE')
    await db().query('UPDATE oauth_identities SET last_login_at=now() WHERE provider=$1 AND provider_subject=$2', [provider, profile.providerSubject])
    return issueSession(identity.rows[0].id, NextResponse.redirect(successUrl(identity.rows[0].role)))
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
    return issueSession(existing.rows[0].id, NextResponse.redirect(successUrl(existing.rows[0].role)))
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
    const base = (process.env.OAUTH_REDIRECT_BASE_URL || '').replace(/\/$/, '')
    return NextResponse.redirect(
      `${base}/login?oauth_challenge=${challengeId}&email=${encodeURIComponent(profile.email)}&provider=${provider}`,
    )
  }
  const created = await transaction(async (client) => {
    const user = await client.query('INSERT INTO users(email) VALUES($1) RETURNING id,role', [profile.email])
    await client.query('INSERT INTO oauth_identities(user_id,provider,provider_subject,email_at_link,email_verified,display_name,avatar_url) VALUES($1,$2,$3,$4,$5,$6,$7)', [user.rows[0].id, provider, profile.providerSubject, profile.email, profile.emailVerified, profile.displayName || null, profile.avatarUrl || null])
    return user.rows[0]
  })
  return issueSession(created.id, NextResponse.redirect(successUrl(created.role)))
}

async function linkIdentity(
  userId: string,
  provider: OAuthProvider,
  profile: OAuthProfile,
): Promise<NextResponse> {
  const base = (process.env.OAUTH_REDIRECT_BASE_URL || '').replace(/\/$/, '')
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
  return accountRedirect()
}

export async function completeOAuthInvitation(
  request: NextRequest,
  input: Record<string, unknown>,
): Promise<NextResponse> {
  const challengeId = typeof input.challengeId === 'string' ? input.challengeId : ''
  const invitationCode = typeof input.invitationCode === 'string' ? input.invitationCode.trim() : ''
  if (!challengeId || !invitationCode) return fail('INVALID_INPUT', '缺少注册参数')
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown'
  if (await limited(`oauth-invite:${ip}`, 10, 600)) return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
  const challenge = await redisGetDel<OAuthChallengeRecord>(`oauth:challenge:${challengeId}`)
  if (!challenge) return fail('OAUTH_REGISTRATION_EXPIRED', '注册会话已过期，请重新登录', 410)
  const result = await transaction(async (client) => {
    const invite = await client.query('UPDATE invitations SET consumed_at=now() WHERE code_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING id', [hashToken(invitationCode)])
    if (!invite.rows[0]) return null
    const existing = await client.query('SELECT id FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [challenge.email])
    const userId = existing.rows[0]?.id || (await client.query('INSERT INTO users(email) VALUES($1) RETURNING id', [challenge.email])).rows[0].id
    await client.query('INSERT INTO oauth_identities(user_id,provider,provider_subject,email_at_link,email_verified,display_name,avatar_url) VALUES($1,$2,$3,$4,true,$5,$6)', [userId, challenge.provider, challenge.providerSubject, challenge.email, challenge.displayName || null, challenge.avatarUrl || null])
    const token = randomToken()
    await client.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')", [userId, hashToken(token)])
    const userRow = await client.query('SELECT id,email,role,status,created_at FROM users WHERE id=$1', [userId])
    return { token, user: userRow.rows[0] }
  })
  if (!result) return fail('INVALID_INVITATION', '邀请码无效或已过期')
  const response = ok({ user: userDto(result.user) })
  response.cookies.set('muse_session', result.token, { httpOnly: true, secure: process.env.COOKIE_SECURE === 'true', sameSite: 'lax', path: '/', maxAge: 30 * 86400 })
  return response
}