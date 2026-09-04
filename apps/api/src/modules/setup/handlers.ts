import { randomInt } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { db, transaction } from '../../../../../packages/database/src/index'
import { hashOtp, hashToken, randomToken, safeEqual } from '../../auth/security'
import { body, emailValid, fail, ok } from '../../shared/http'
import { userDto } from '../../shared/dto'
import { sendMail } from '../../shared/services'
import { limited } from '../../shared/redis'

async function noAdminGuard(): Promise<NextResponse | null> {
  const r = await db().query("SELECT count(*)::int AS cnt FROM users WHERE role='admin' AND deleted_at IS NULL")
  if (r.rows[0].cnt > 0) return fail('SETUP_ALREADY_COMPLETE', '系统已初始化', 409)
  return null
}

export async function setupStatus(): Promise<NextResponse> {
  const r = await db().query("SELECT count(*)::int AS cnt FROM users WHERE role='admin' AND deleted_at IS NULL")
  return ok({ setupComplete: r.rows[0].cnt > 0 })
}

export async function setupAdminRequest(request: NextRequest): Promise<NextResponse> {
  const guard = await noAdminGuard()
  if (guard) return guard

  const input = await body(request)
  if (!emailValid(input.email)) return fail('INVALID_INPUT', '邮箱格式不正确')

  const email = input.email.trim().toLowerCase()
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown'
  if (await limited(`setup:${email}:${ip}`, 5, 600))
    return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)

  const code = randomInt(100000, 1000000).toString()
  await db().query('UPDATE otp_challenges SET consumed_at=now() WHERE lower(email)=$1 AND consumed_at IS NULL', [email])
  await db().query("INSERT INTO otp_challenges(email,code_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')", [email, hashOtp(email, code)])

  try {
    await sendMail(email, 'MuseCanvas 管理员设置验证码', `你的 MuseCanvas 管理后台验证码是：${code}。10 分钟内有效。`)
  } catch (error) {
    console.error('setup otp delivery failed', { code: error instanceof Error ? error.message : 'SMTP_ERROR' })
    return fail('EMAIL_DELIVERY_FAILED', '验证码发送失败，请稍后重试', 503)
  }

  return ok({ accepted: true })
}

export async function setupAdminVerify(request: NextRequest): Promise<NextResponse> {
  const guard = await noAdminGuard()
  if (guard) return guard

  const input = await body(request)
  if (!emailValid(input.email) || typeof input.code !== 'string' || !/^\d{6}$/.test(input.code))
    return fail('INVALID_OTP', '验证码无效')

  const email = input.email.trim().toLowerCase()
  if (await limited(`setup-verify:${email}`, 10, 600))
    return fail('RATE_LIMITED', '验证尝试过多，请稍后再试', 429)

  const result = await transaction(async (client) => {
    const adminCheck = await client.query("SELECT count(*)::int AS cnt FROM users WHERE role='admin' AND deleted_at IS NULL")
    if (adminCheck.rows[0].cnt > 0) return null
    const challengeResult = await client.query(
      "SELECT * FROM otp_challenges WHERE lower(email)=$1 AND consumed_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [email],
    )
    const challenge = challengeResult.rows[0]
    if (!challenge || challenge.attempts >= 5 || !safeEqual(challenge.code_hash, hashOtp(email, input.code as string))) {
      if (challenge) await client.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id])
      return null
    }

    const userResult = await client.query(
      "INSERT INTO users(email,role) VALUES($1,'admin') RETURNING *",
      [email],
    )
    const user = userResult.rows[0]
    await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id])
    const token = randomToken()
    await client.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')", [user.id, hashToken(token)])
    return { user, token }
  })

  if (!result) return fail('INVALID_OTP', '验证码无效或已过期', 401)

  const response = ok({ user: userDto(result.user) })
  response.cookies.set('muse_session', result.token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 86400,
  })
  return response
}