import { randomInt } from 'node:crypto'
import { db, transaction } from '../../../../../packages/database/src/index'
import { actorFrom, hashOtp, hashToken, randomToken, shouldUseSecureCookie, verifyOtpHash } from '../../auth/security'
import { findActiveInvitationHash } from '../../auth/invitations'
import { writeAudit } from '../../shared/audit'
import { clientIpFromRequest, emailValid, fail, ok } from '../../shared/http'
import { userDto } from '../../shared/dto'
import { sendMail } from '../../shared/services'
import { limited } from '../../shared/redis'
import { resolvePublicOrigin } from '../settings/runtime'
import type { PublicContext } from '../../router/types'

/**
 * POST /api/auth/otp/request.
 *
 * The body is read by the dispatcher and handed in, because this route runs
 * before the session gate: an anonymous visitor must be able to ask for a code.
 */
export async function requestOtp(context: PublicContext) {
  const input = await context.json()
  if (!emailValid(input.email)) return fail('INVALID_INPUT', '邮箱格式不正确')
  const email = input.email.trim().toLowerCase()
  const ip = clientIpFromRequest(context.request)
  if (await limited(`otp:${email}:${ip}`, 5, 600)) return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
  const existing = await db().query('SELECT id,status,deleted_at FROM users WHERE lower(email)=$1 ORDER BY deleted_at NULLS FIRST LIMIT 1', [email])
  const account = existing.rows[0]
  if (account && (account.deleted_at || account.status !== 'active')) return fail('ACCOUNT_UNAVAILABLE', '账户当前不可用', 403)
  const setting = await db().query('SELECT mode FROM registration_settings WHERE singleton=true')
  const requiresInvitation = !account && setting.rows[0]?.mode === 'invite_only'
  let invitationHash: string | null = null
  if (requiresInvitation) {
    if (typeof input.invitationCode !== 'string' || !input.invitationCode.trim()) return ok({ accepted: false, nextStep: 'invitation' as const })
    invitationHash = await findActiveInvitationHash(db(), input.invitationCode)
    if (!invitationHash) return fail('INVALID_INVITATION', '邀请码无效或已过期')
  }
  const code = randomInt(100000, 1000000).toString()
  await db().query('UPDATE otp_challenges SET consumed_at=now() WHERE lower(email)=$1 AND consumed_at IS NULL', [email])
  const challenge = await db().query("INSERT INTO otp_challenges(email,code_hash,invitation_code_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes') RETURNING id", [email, hashOtp(email, code), invitationHash])
  try {
    await sendMail(email, 'MuseCanvas 登录验证码', `你的 MuseCanvas 验证码是：${code}。10 分钟内有效。`)
  } catch (error) {
    // A code that was never delivered must not stay redeemable.
    await db().query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.rows[0].id])
    console.error('otp delivery failed', { code: error instanceof Error ? error.message : 'SMTP_ERROR' })
    return fail('EMAIL_DELIVERY_FAILED', '验证码发送失败，请稍后重试', 503)
  }
  return ok({ accepted: true, nextStep: 'otp' as const })
}

/** POST /api/auth/otp/verify — creates the account on first login when open. */
export async function verifyOtp(context: PublicContext) {
  const input = await context.json()
  if (!emailValid(input.email) || typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)) return fail('INVALID_OTP', '验证码无效')
  const email = input.email.trim().toLowerCase()
  if (await limited(`verify:${email}`, 10, 600)) return fail('RATE_LIMITED', '验证尝试过多，请稍后再试', 429)
  const result = await transaction(async client => {
    const challengeResult = await client.query('SELECT * FROM otp_challenges WHERE lower(email)=$1 AND consumed_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [email])
    const challenge = challengeResult.rows[0]
    if (!challenge || challenge.attempts >= 5 || !verifyOtpHash(challenge.code_hash, email, input.code as string)) {
      if (challenge) await client.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id])
      return null
    }
    let userResult = await client.query('SELECT * FROM users WHERE lower(email)=$1 AND deleted_at IS NULL FOR UPDATE', [email])
    let user = userResult.rows[0]
    if (!user) {
      const setting = await client.query('SELECT mode FROM registration_settings WHERE singleton=true FOR UPDATE')
      if (setting.rows[0].mode === 'invite_only') {
        if (!challenge.invitation_code_hash) return null
        const invite = await client.query('UPDATE invitations SET consumed_at=now() WHERE code_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING id', [challenge.invitation_code_hash])
        if (!invite.rows[0]) return null
      }
      userResult = await client.query('INSERT INTO users(email) VALUES($1) RETURNING *', [email])
      user = userResult.rows[0]
    }
    if (user.status !== 'active') return null
    await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id])
    const token = randomToken()
    await client.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')", [user.id, hashToken(token)])
    await writeAudit(client, user.id, 'auth.otp.login', 'user', user.id)
    return { user, token }
  })
  if (!result) return fail('INVALID_OTP', '验证码无效或已过期', 401)
  const response = ok({ user: userDto(result.user) })
  response.cookies.set('muse_session', result.token, { httpOnly: true, secure: shouldUseSecureCookie(await resolvePublicOrigin()), sameSite: 'lax', path: '/', maxAge: 30 * 86400 })
  return response
}

/**
 * POST /api/auth/logout — succeeds for an anonymous caller, and clears the setup
 * cookie as well, so a half-finished wizard cannot leave a usable token behind.
 */
export async function logout(context: PublicContext) {
  const logoutActor = await actorFrom(context.request)
  const token = context.request.cookies.get('muse_session')?.value
  if (token) await db().query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [hashToken(token)])
  if (logoutActor) {
    try {
      await writeAudit(db(), logoutActor.id, 'auth.logout', 'user', logoutActor.id)
    } catch (error) {
      console.error('audit write failed', error)
    }
  }
  const response = ok({ loggedOut: true })
  response.cookies.delete('muse_session')
  response.cookies.delete('muse_setup')
  return response
}
