import { randomInt, randomUUID } from 'node:crypto'
import { createClient } from 'redis'
import { NextResponse, type NextRequest } from 'next/server'
import { db, transaction } from '../../../../../packages/database/src/index'
import { validateModelInput } from '../../../../../packages/domain/src/index'
import { actorFrom, decryptOAuthSecret, encryptOAuthSecret, encryptSecret, hashOtp, hashToken, randomToken, safeEqual, encryptApiKey, decryptApiKey, fingerprintApiKey, type Actor } from '../../../src/security'
import { body, emailValid, fail, mutationOriginValid, ok } from '../../../src/http'
import { adminJobDto, jobDto, modelDto, publicModelDto, userDto, providerCredentialDto, oauthIdentityDto } from '../../../src/dto'
import { sendMail, signedAssetUrl } from '../../../src/services'
import { modelPresets } from '../../../src/model-presets'
import { authorizeUrlWithConfig, createPkceVerifier, envOAuthConfig, exchangeCodeWithConfig, fetchProfileWithConfig, pkceChallenge, runtimeProviderConfigured, type OAuthProfile, type OAuthProvider, type OAuthRuntimeConfig } from '../../../src/oauth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ path: string[] }> }
let redis: ReturnType<typeof createClient> | undefined

async function limited(key: string, max: number, seconds: number): Promise<boolean> {
  try {
    redis ??= createClient({ url: process.env.REDIS_URL }); if (!redis.isOpen) await redis.connect()
    const count = await redis.incr(`rate:${key}`); if (count === 1) await redis.expire(`rate:${key}`, seconds)
    return count > max
  } catch { return false }
}
async function redisClient() { redis ??= createClient({ url: process.env.REDIS_URL }); if (!redis.isOpen) await redis.connect(); return redis }
async function redisSet(key: string, value: object, ttlSeconds: number): Promise<void> {
  const client = await redisClient(); await client.set(key, JSON.stringify(value), { EX: ttlSeconds })
}
async function redisGetDel<T>(key: string): Promise<T | null> {
  const client = await redisClient(); const raw = await client.getDel(key)
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { return null }
}
const OAUTH_STATE_TTL = 600
type OAuthStateRecord = { mode: 'login' | 'link'; provider: OAuthProvider; pkceVerifier: string; nonce: string; userId?: string }
type OAuthChallengeRecord = { email: string; provider: OAuthProvider; providerSubject: string; displayName?: string; avatarUrl?: string }
const loginRedirect = (code: string) => NextResponse.redirect(`${(process.env.OAUTH_REDIRECT_BASE_URL || '').replace(/\/$/, '')}/login?error=${encodeURIComponent(code)}`)
const oauthProviderLabels: Record<OAuthProvider, string> = { github: 'GitHub', google: 'Google' }
type OAuthSettingRow = { provider: OAuthProvider; client_id?: string | null; client_secret_encrypted?: string | null; enabled?: boolean }
async function requireActor(request: NextRequest, admin = false): Promise<Actor | NextResponse> {
  const actor = await actorFrom(request)
  if (!actor) return fail('UNAUTHORIZED', '请先登录', 401)
  if (admin && actor.role !== 'admin') return fail('FORBIDDEN', '无权执行该操作', 403)
  return actor
}
function isResponse(value: Actor | NextResponse): value is NextResponse { return value instanceof NextResponse }
const cleanPath = (context: Context) => context.params.then(value => value.path.join('/'))
const audit = (client: any, actor: Actor, action: string, type: string, id: string, summary: object = {}) => client.query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,summary) VALUES($1,$2,$3,$4,$5)', [actor.id, action, type, id, summary])
function decryptOptionalSecret(value?: string | null): string {
  if (!value) return ''
  try { return decryptOAuthSecret(value) } catch { return '' }
}
async function oauthSetting(provider: OAuthProvider): Promise<{ row?: OAuthSettingRow; config: OAuthRuntimeConfig; enabled: boolean; source: 'database' | 'environment' | 'none' }> {
  const result = await db().query('SELECT provider,client_id,client_secret_encrypted,enabled FROM oauth_provider_settings WHERE provider=$1', [provider])
  const row = result.rows[0] as OAuthSettingRow | undefined
  const env = envOAuthConfig(provider)
  const dbConfig = row ? { clientId: row.client_id || '', clientSecret: decryptOptionalSecret(row.client_secret_encrypted), redirectBaseUrl: env.redirectBaseUrl } : env
  if (row?.enabled && runtimeProviderConfigured(dbConfig)) return { row, config: dbConfig, enabled: true, source: 'database' }
  if (runtimeProviderConfigured(env)) return { row, config: env, enabled: true, source: 'environment' }
  return { row, config: dbConfig, enabled: false, source: 'none' }
}
async function oauthProviderList() {
  const providers: OAuthProvider[] = ['github', 'google']
  return Promise.all(providers.map(async provider => {
    const setting = await oauthSetting(provider)
    return { provider, label: oauthProviderLabels[provider], enabled: setting.enabled }
  }))
}
async function adminOAuthSettings() {
  const providers: OAuthProvider[] = ['github', 'google']
  return Promise.all(providers.map(async provider => {
    const setting = await oauthSetting(provider)
    const row = setting.row
    return {
      provider,
      label: oauthProviderLabels[provider],
      enabled: setting.enabled,
      configuredInDatabase: !!row?.enabled,
      source: setting.source,
      clientId: row?.client_id || '',
      hasClientSecret: !!row?.client_secret_encrypted,
      redirectUri: `${setting.config.redirectBaseUrl.replace(/\/$/, '')}/api/auth/oauth/${provider}/callback`,
    }
  }))
}
type Cursor = { createdAt: string; id: string }
function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor
    return typeof parsed.createdAt === 'string' && /^[0-9a-f-]{36}$/i.test(parsed.id) && !Number.isNaN(Date.parse(parsed.createdAt)) ? parsed : null
  } catch { return null }
}
const encodeCursor = (row: { created_at: Date; id: string }) => Buffer.from(JSON.stringify({ createdAt: row.created_at.toISOString(), id: row.id })).toString('base64url')
const boundedLimit = (request: NextRequest) => Math.min(100, Math.max(1, Number(request.nextUrl.searchParams.get('limit') || 50) || 50))
function normalizedProviderBaseUrl(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === '') return ''
  if (typeof value !== 'string' || value.length > 500) return null
  try {
    const url = new URL(value)
    const insecureAllowed = process.env.ALLOW_INSECURE_PROVIDER_BASE_URL === 'true'
    if (url.protocol !== 'https:' && !(insecureAllowed && url.protocol === 'http:')) return null
    if (url.username || url.password || url.search || url.hash) return null
    const host = url.hostname.toLowerCase(); const privateHost = host === 'localhost' || host === '0.0.0.0' || host === '::1' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    if (privateHost && process.env.ALLOW_PRIVATE_PROVIDER_BASE_URL !== 'true') return null
    return url.toString().replace(/\/$/, '')
  } catch { return null }
}

export async function GET(request: NextRequest, context: Context) {
  const path = await cleanPath(context)
  if (path === 'health/live') return ok({ status: 'ok' })
  if (path === 'health/ready') { try { await db().query('SELECT 1'); return ok({ status: 'ready' }) } catch { return fail('DEPENDENCY_UNAVAILABLE', '服务尚未就绪', 503) } }
  if (path === 'registration') { const r = await db().query('SELECT mode FROM registration_settings WHERE singleton=true'); return ok({ mode: r.rows[0]?.mode || 'open' }) }
  if (path === 'session') { const actor = await requireActor(request); return isResponse(actor) ? actor : ok({ user: actor }) }

  if (path === 'auth/oauth/providers') return ok({ providers: await oauthProviderList() })
  const oauthStart = path.match(/^auth\/oauth\/(github|google)\/start$/)
  if (oauthStart) return startOAuth(oauthStart[1] as OAuthProvider, 'login')
  const oauthCallback = path.match(/^auth\/oauth\/(github|google)\/callback$/)
  if (oauthCallback) return handleOAuthCallback(request, oauthCallback[1] as OAuthProvider)

  const actor = await requireActor(request, path.startsWith('admin/'))
  if (isResponse(actor)) return actor
  if (path === 'account/oauth') { const r = await db().query('SELECT * FROM oauth_identities WHERE user_id=$1 AND deleted_at IS NULL ORDER BY linked_at', [actor.id]); return ok(r.rows.map(oauthIdentityDto)) }
  const linkStart = path.match(/^account\/oauth\/(github|google)\/link\/start$/)
  if (linkStart) return startOAuth(linkStart[1] as OAuthProvider, 'link', actor.id)
  if (path === 'models') { const r = await db().query('SELECT * FROM model_configs WHERE enabled=true AND deleted_at IS NULL ORDER BY sort_order,created_at'); return ok(r.rows.map(publicModelDto)) }
  if (path === 'jobs') {
    const r = await db().query('SELECT * FROM generation_jobs WHERE created_by=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50', [actor.id])
    return ok({ items: await Promise.all(r.rows.map(async row => jobDto(row, (await db().query('SELECT go.asset_id,a.object_key FROM generation_outputs go JOIN assets a ON a.id=go.asset_id WHERE go.job_id=$1 AND a.deleted_at IS NULL', [row.id])).rows))), total: r.rowCount, hasMore: false })
  }
  const jobMatch = path.match(/^jobs\/([0-9a-f-]+)$/)
  if (jobMatch) {
    const r = await db().query('SELECT * FROM generation_jobs WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL', [jobMatch[1], actor.id]); if (!r.rows[0]) return fail('NOT_FOUND', '任务不存在', 404)
    const outputs = await db().query('SELECT go.asset_id,a.object_key FROM generation_outputs go JOIN assets a ON a.id=go.asset_id WHERE go.job_id=$1 AND a.deleted_at IS NULL', [jobMatch[1]])
    return ok(await jobDto(r.rows[0], outputs.rows))
  }
  if (path === 'library') {
    const r = await db().query('SELECT id,prompt,object_key,mime_type,width,height,size_bytes,created_at FROM assets WHERE created_by=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50', [actor.id])
    return ok({ items: await Promise.all(r.rows.map(async row => ({ id: row.id, prompt: row.prompt, imageUrl: await signedAssetUrl(row.object_key), mimeType: row.mime_type, width: row.width, height: row.height, sizeBytes: row.size_bytes, createdAt: row.created_at.toISOString() }))), total: r.rowCount, hasMore: false })
  }
  const downloadMatch = path.match(/^library\/([0-9a-f-]+)\/download$/)
  if (downloadMatch) { const r = await db().query('SELECT object_key FROM assets WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL', [downloadMatch[1], actor.id]); return r.rows[0] ? ok({ url: await signedAssetUrl(r.rows[0].object_key) }) : fail('NOT_FOUND', '图片不存在', 404) }

  if (path === 'admin/dashboard') {
    const r = await db().query(`SELECT (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) total_users,(SELECT count(*)::int FROM generation_jobs WHERE deleted_at IS NULL) total_jobs,(SELECT count(*)::int FROM generation_jobs WHERE status='failed' AND created_at>now()-interval '7 days') failed_jobs_7d,(SELECT COALESCE(round(100.0*count(*) FILTER(WHERE status='succeeded')/NULLIF(count(*) FILTER(WHERE status IN('succeeded','failed')),0),1),0)::float FROM generation_jobs WHERE created_at>now()-interval '7 days') success_rate_7d`)
    const x = r.rows[0]; return ok({ totalUsers: x.total_users, totalJobs: x.total_jobs, failedJobs7d: x.failed_jobs_7d, successRate7d: x.success_rate_7d })
  }
  if (path === 'admin/registration') { const r = await db().query('SELECT mode FROM registration_settings WHERE singleton=true'); return ok({ mode: r.rows[0]?.mode || 'open' }) }
  if (path === 'admin/users') {
    const limit = boundedLimit(request); const cursor = decodeCursor(request.nextUrl.searchParams.get('cursor')); const values: unknown[] = []; const conditions = ['deleted_at IS NULL']
    const status = request.nextUrl.searchParams.get('status'); const email = request.nextUrl.searchParams.get('email')?.trim()
    if (status === 'active' || status === 'disabled') { values.push(status); conditions.push(`status=$${values.length}`) }
    if (email) { values.push(`%${email}%`); conditions.push(`email ILIKE $${values.length}`) }
    if (cursor) { values.push(cursor.createdAt, cursor.id); conditions.push(`(created_at,id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`) }
    const where = conditions.join(' AND '); const totalValues = values.slice(0, cursor ? -2 : undefined); const totalWhere = cursor ? conditions.slice(0, -1).join(' AND ') : where
    values.push(limit + 1); const r = await db().query(`SELECT id,email,role,status,created_at FROM users WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${values.length}`, values)
    const total = await db().query(`SELECT count(*)::int total FROM users WHERE ${totalWhere}`, totalValues); const hasMore = r.rows.length > limit; const rows = r.rows.slice(0, limit)
    return ok({ items: rows.map(userDto), total: total.rows[0].total, hasMore, nextCursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : undefined })
  }
  if (path === 'admin/model-presets') return ok(modelPresets)
  if (path === 'admin/models') { const r = await db().query('SELECT m.*, pc.display_name AS provider_credential_name FROM model_configs m LEFT JOIN provider_credentials pc ON pc.id=m.provider_credential_id AND pc.deleted_at IS NULL WHERE m.deleted_at IS NULL ORDER BY m.sort_order,m.created_at'); return ok(r.rows.map(modelDto)) }
  if (path === 'admin/jobs') {
    const limit = boundedLimit(request); const cursor = decodeCursor(request.nextUrl.searchParams.get('cursor')); const values: unknown[] = []; const conditions = ['deleted_at IS NULL']
    const userId = request.nextUrl.searchParams.get('userId'); const status = request.nextUrl.searchParams.get('status'); const modelId = request.nextUrl.searchParams.get('modelId'); const from = request.nextUrl.searchParams.get('from'); const to = request.nextUrl.searchParams.get('to')
    if (userId && /^[0-9a-f-]{36}$/i.test(userId)) { values.push(userId); conditions.push(`created_by=$${values.length}::uuid`) }
    if (status && ['queued','running','retry_wait','succeeded','failed','canceled'].includes(status)) { values.push(status); conditions.push(`status=$${values.length}`) }
    if (modelId && /^[0-9a-f-]{36}$/i.test(modelId)) { values.push(modelId); conditions.push(`model_id=$${values.length}::uuid`) }
    if (from && !Number.isNaN(Date.parse(from))) { values.push(from); conditions.push(`created_at>=$${values.length}::timestamptz`) }
    if (to && !Number.isNaN(Date.parse(to))) { values.push(to); conditions.push(`created_at<=$${values.length}::timestamptz`) }
    if (cursor) { values.push(cursor.createdAt, cursor.id); conditions.push(`(created_at,id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`) }
    const where = conditions.join(' AND '); const totalValues = values.slice(0, cursor ? -2 : undefined); const totalWhere = cursor ? conditions.slice(0, -1).join(' AND ') : where
    values.push(limit + 1); const r = await db().query(`SELECT id,created_by,model_id,model_name,status,error_code,provider_reference_id,created_at,started_at,completed_at FROM generation_jobs WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${values.length}`, values)
    const total = await db().query(`SELECT count(*)::int total FROM generation_jobs WHERE ${totalWhere}`, totalValues); const hasMore = r.rows.length > limit; const rows = r.rows.slice(0, limit)
    return ok({ items: rows.map(adminJobDto), total: total.rows[0].total, hasMore, nextCursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : undefined })
  }
  if (path === 'admin/invitations') { const r = await db().query('SELECT id,email,consumed_at,revoked_at,created_at FROM invitations ORDER BY created_at DESC LIMIT 100'); return ok({ items: r.rows.map(row => ({ id: row.id, email: row.email, used: !!row.consumed_at, revoked: !!row.revoked_at, createdAt: row.created_at.toISOString() })), total: r.rowCount, hasMore: false }) }
  if (path === 'admin/smtp') { const r = await db().query('SELECT host,port,tls_mode,from_address,from_name,username,password_encrypted FROM smtp_settings WHERE singleton=true'); const x = r.rows[0]; return ok(x ? { host: x.host, port: x.port, secure: x.tls_mode, from: x.from_address, fromName: x.from_name, user: x.username, hasPassword: !!x.password_encrypted } : { host: '', port: 465, secure: 'implicit_tls', from: '', fromName: '', user: '', hasPassword: false }) }
  if (path === 'admin/oauth-providers') return ok(await adminOAuthSettings())
  if (path === 'admin/provider-credentials') { const r = await db().query('SELECT * FROM provider_credentials WHERE deleted_at IS NULL ORDER BY created_at DESC'); return ok(r.rows.map(providerCredentialDto)) }
  return fail('NOT_FOUND', '接口不存在', 404)
}

export async function POST(request: NextRequest, context: Context) {
  if (!mutationOriginValid(request)) return fail('CSRF_REJECTED', '请求来源无效', 403)
  const path = await cleanPath(context); const input = await body(request)
  if (path === 'auth/otp/request') {
    if (!emailValid(input.email)) return fail('INVALID_INPUT', '邮箱格式不正确')
    const email = input.email.trim().toLowerCase(); const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown'
    if (await limited(`otp:${email}:${ip}`, 5, 600)) return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
    const existing = await db().query('SELECT id,status,deleted_at FROM users WHERE lower(email)=$1 ORDER BY deleted_at NULLS FIRST LIMIT 1', [email]); const account = existing.rows[0]
    if (account && (account.deleted_at || account.status !== 'active')) return fail('ACCOUNT_UNAVAILABLE', '账户当前不可用', 403)
    const setting = await db().query('SELECT mode FROM registration_settings WHERE singleton=true'); const requiresInvitation = !account && setting.rows[0]?.mode === 'invite_only'
    let invitationHash: string | null = null
    if (requiresInvitation) {
      if (typeof input.invitationCode !== 'string' || !input.invitationCode.trim()) return ok({ accepted: false, nextStep: 'invitation' as const })
      invitationHash = hashToken(input.invitationCode.trim())
      const invite = await db().query('SELECT id FROM invitations WHERE lower(email)=$1 AND code_hash=$2 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now()', [email, invitationHash])
      if (!invite.rows[0]) return fail('INVALID_INVITATION', '邀请码无效或已过期')
    }
    const code = randomInt(100000, 1000000).toString(); await db().query('UPDATE otp_challenges SET consumed_at=now() WHERE lower(email)=$1 AND consumed_at IS NULL', [email]); const challenge = await db().query("INSERT INTO otp_challenges(email,code_hash,invitation_code_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes') RETURNING id", [email, hashOtp(email, code), invitationHash])
    try { await sendMail(email, 'MuseCanvas 登录验证码', `你的 MuseCanvas 验证码是：${code}。10 分钟内有效。`) }
    catch (error) { await db().query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.rows[0].id]); console.error('otp delivery failed', { code: error instanceof Error ? error.message : 'SMTP_ERROR' }); return fail('EMAIL_DELIVERY_FAILED', '验证码发送失败，请稍后重试', 503) }
    return ok({ accepted: true, nextStep: 'otp' as const })
  }
  if (path === 'auth/otp/verify') {
    if (!emailValid(input.email) || typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)) return fail('INVALID_OTP', '验证码无效')
    const email = input.email.trim().toLowerCase(); if (await limited(`verify:${email}`, 10, 600)) return fail('RATE_LIMITED', '验证尝试过多，请稍后再试', 429)
    const result = await transaction(async client => {
      const challengeResult = await client.query("SELECT * FROM otp_challenges WHERE lower(email)=$1 AND consumed_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [email]); const challenge = challengeResult.rows[0]
      if (!challenge || challenge.attempts >= 5 || !safeEqual(challenge.code_hash, hashOtp(email, input.code as string))) { if (challenge) await client.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]); return null }
      let userResult = await client.query('SELECT * FROM users WHERE lower(email)=$1 AND deleted_at IS NULL FOR UPDATE', [email]); let user = userResult.rows[0]
      if (!user) {
        const setting = await client.query('SELECT mode FROM registration_settings WHERE singleton=true FOR UPDATE')
        if (setting.rows[0].mode === 'invite_only') { if (!challenge.invitation_code_hash) return null; const invite = await client.query('UPDATE invitations SET consumed_at=now() WHERE lower(email)=$1 AND code_hash=$2 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING id', [email, challenge.invitation_code_hash]); if (!invite.rows[0]) return null }
        userResult = await client.query("INSERT INTO users(email) VALUES($1) RETURNING *", [email]); user = userResult.rows[0]
      }
      if (user.status !== 'active') return null
      await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]); const token = randomToken(); await client.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')", [user.id, hashToken(token)]); return { user, token }
    })
    if (!result) return fail('INVALID_OTP', '验证码无效或已过期', 401)
    const response = ok({ user: userDto(result.user) }); response.cookies.set('muse_session', result.token, { httpOnly: true, secure: process.env.COOKIE_SECURE === 'true', sameSite: 'lax', path: '/', maxAge: 30 * 86400 }); return response
  }
  if (path === 'auth/logout') { const token = request.cookies.get('muse_session')?.value; if (token) await db().query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [hashToken(token)]); const response = ok({ loggedOut: true }); response.cookies.delete('muse_session'); return response }
  if (path === 'auth/oauth/invitation') return completeOAuthInvitation(request, input)

  const actor = await requireActor(request, path.startsWith('admin/')); if (isResponse(actor)) return actor
  if (path === 'generations') {
    if (typeof input.prompt !== 'string' || input.prompt.trim().length < 1 || input.prompt.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.prompt) || typeof input.modelId !== 'string' || typeof input.size !== 'string') return fail('INVALID_INPUT', '生成参数无效')
    if (await limited(`generate:${actor.id}`, 20, 60)) return fail('RATE_LIMITED', '提交过于频繁，请稍后再试', 429)
    const modelResult = await db().query('SELECT * FROM model_configs WHERE id=$1 AND enabled=true AND deleted_at IS NULL', [input.modelId]); const model = modelResult.rows[0]; if (!model) return fail('MODEL_UNAVAILABLE', '模型当前不可用')
    const count = Number(input.count || 1); const validation = validateModelInput({ adapter: model.adapter, sizes: model.sizes, qualityOptions: model.quality_options, maxCount: model.max_count }, { size: input.size, quality: typeof input.quality === 'string' ? input.quality : undefined, count }); if (validation) return fail(validation, '模型参数不受支持')
    const idempotencyKey = request.headers.get('idempotency-key') || (typeof input.idempotencyKey === 'string' ? input.idempotencyKey : randomUUID()); const prompt = input.prompt.trim(); const size = input.size
    const row = await transaction(async client => { const existing = await client.query('SELECT * FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2', [actor.id, idempotencyKey]); if (existing.rows[0]) return existing.rows[0];
      let credId: string | null = null; let credName: string | null = null; let providerBaseUrl = model.base_url
      if (model.provider_credential_id) { const cred = await client.query('SELECT id, display_name, enabled, api_key_encrypted, base_url FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [model.provider_credential_id]); if (!cred.rows[0] || !cred.rows[0].enabled || !cred.rows[0].api_key_encrypted) throw new Error('PROVIDER_NOT_CONFIGURED'); credId = cred.rows[0].id; credName = cred.rows[0].display_name; providerBaseUrl = cred.rows[0].base_url || model.base_url }
      const inserted = await client.query('INSERT INTO generation_jobs(created_by,model_id,model_name,adapter,vendor_model_id,provider_base_url,prompt,size,quality,count,watermark,idempotency_key,provider_credential_id,provider_credential_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *', [actor.id, model.id, model.display_name, model.adapter, model.vendor_model_id, providerBaseUrl, prompt, size, input.quality || null, count, model.watermark, idempotencyKey, credId, credName]); await client.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('generation.requested',$1,$2)", [inserted.rows[0].id, { jobId: inserted.rows[0].id }]); return inserted.rows[0] })
    return ok(await jobDto(row), { status: 202 })
  }
  const cancel = path.match(/^jobs\/([0-9a-f-]+)\/cancel$/)
  if (cancel) { const r = await db().query("UPDATE generation_jobs SET status='canceled',completed_at=now(),updated_at=now() WHERE id=$1 AND created_by=$2 AND status IN('queued','retry_wait') AND deleted_at IS NULL RETURNING *", [cancel[1], actor.id]); if (!r.rows[0]) return fail('JOB_NOT_CANCELABLE', '任务无法取消', 409); return ok(await jobDto(r.rows[0])) }
  if (path === 'admin/invitations') {
    if (!emailValid(input.email)) return fail('INVALID_INPUT', '邮箱格式不正确'); const count = Math.min(50, Math.max(1, Number(input.count || 1))); const items = []
    for (let i=0;i<count;i++) { const code = randomToken(18); const r = await db().query("INSERT INTO invitations(email,code_hash,expires_at,created_by) VALUES($1,$2,now()+interval '7 days',$3) RETURNING id,email,created_at", [input.email.toLowerCase(), hashToken(code), actor.id]); await audit(db(), actor, 'invitation.create', 'invitation', r.rows[0].id); items.push({ id: r.rows[0].id, email: r.rows[0].email, code, used: false, createdAt: r.rows[0].created_at.toISOString() }) }
    return ok(items)
  }
  if (path === 'admin/models') return upsertModel(actor, input)
  if (path === 'admin/provider-credentials') return createProviderCredential(actor, input)
  const credTest = path.match(/^admin\/provider-credentials\/([0-9a-f-]+)\/test$/)
  if (credTest) return testProviderCredential(actor, credTest[1])
  if (path === 'admin/smtp/test') { try { await sendMail(actor.email, 'MuseCanvas SMTP 测试', 'SMTP 配置工作正常。'); await audit(db(), actor, 'smtp.test', 'smtp', 'singleton'); return ok({ sent: true }) } catch { return fail('SMTP_TEST_FAILED', '测试邮件发送失败', 502) } }
  return fail('NOT_FOUND', '接口不存在', 404)
}

export async function PATCH(request: NextRequest, context: Context) {
  if (!mutationOriginValid(request)) return fail('CSRF_REJECTED', '请求来源无效', 403); const path = await cleanPath(context); const input = await body(request); const actor = await requireActor(request, true); if (isResponse(actor)) return actor
  if (path === 'admin/registration') { if (input.mode !== 'open' && input.mode !== 'invite_only') return fail('INVALID_INPUT', '注册模式无效'); await transaction(async client => { await client.query('UPDATE registration_settings SET mode=$1,updated_at=now(),updated_by=$2 WHERE singleton=true', [input.mode, actor.id]); await audit(client, actor, 'registration.update', 'registration', 'singleton', { mode: input.mode }) }); return ok({ mode: input.mode }) }
  const user = path.match(/^admin\/users\/([0-9a-f-]+)(?:\/status)?$/)
  if (user) { if (input.status !== 'active' && input.status !== 'disabled') return fail('INVALID_INPUT', '用户状态无效'); if (user[1] === actor.id && input.status === 'disabled') return fail('INVALID_OPERATION', '不能停用当前管理员'); const r = await transaction(async client => { const x = await client.query('UPDATE users SET status=$1,session_version=session_version+1,updated_at=now() WHERE id=$2 AND deleted_at IS NULL RETURNING *', [input.status, user[1]]); if (input.status === 'disabled') await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [user[1]]); if (x.rows[0]) await audit(client, actor, 'user.status', 'user', user[1], { status: input.status }); return x.rows[0] }); return r ? ok(userDto(r)) : fail('NOT_FOUND', '用户不存在', 404) }
  const model = path.match(/^admin\/models\/([0-9a-f-]+)$/); if (model) return upsertModel(actor, input, model[1])
  const cred = path.match(/^admin\/provider-credentials\/([0-9a-f-]+)$/); if (cred) return updateProviderCredential(actor, cred[1], input)
  const oauthProvider = path.match(/^admin\/oauth-providers\/(github|google)$/); if (oauthProvider) return updateOAuthProvider(actor, oauthProvider[1] as OAuthProvider, input)
  return fail('NOT_FOUND', '接口不存在', 404)
}

async function upsertModel(actor: Actor, input: Record<string, unknown>, id?: string) {
  const adapter = input.adapter; const sizes = input.sizes; const qualities = input.qualityOptions || []
  const baseUrl = normalizedProviderBaseUrl(input.baseUrl)
  if (baseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
  if ((adapter !== undefined && adapter !== 'openai' && adapter !== 'seedream') || (sizes !== undefined && (!Array.isArray(sizes) || !sizes.length)) || (qualities !== undefined && !Array.isArray(qualities))) return fail('INVALID_INPUT', '模型配置无效')
  if (!id && (typeof input.displayName !== 'string' || typeof input.vendorModelId !== 'string' || !adapter || !sizes)) return fail('INVALID_INPUT', '模型配置不完整')
  const credId = input.providerCredentialId
  if (credId !== undefined && credId !== null && typeof credId === 'string' && credId) {
    const cred = await db().query('SELECT adapter FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [credId])
    if (!cred.rows[0]) return fail('INVALID_INPUT', '供应商凭据不存在')
    if (cred.rows[0].adapter !== (adapter || undefined)) return fail('INVALID_INPUT', '供应商凭据类型与模型不匹配')
  }
  let result
  if (id) { result = await db().query(`UPDATE model_configs SET display_name=COALESCE($1,display_name),adapter=COALESCE($2,adapter),vendor_model_id=COALESCE($3,vendor_model_id),base_url=CASE WHEN $4::text IS NULL THEN base_url ELSE $4 END,sizes=COALESCE($5,sizes),quality_options=COALESCE($6,quality_options),max_count=COALESCE($7,max_count),concurrency_limit=COALESCE($8,concurrency_limit),enabled=COALESCE($9,enabled),watermark=COALESCE($10,watermark),sort_order=COALESCE($11,sort_order),provider_credential_id=CASE WHEN $12::text IS NULL THEN provider_credential_id WHEN $12::text = '' THEN NULL ELSE $12::uuid END,updated_at=now() WHERE id=$13 AND deleted_at IS NULL RETURNING *`, [input.displayName || null, adapter || null, input.vendorModelId || null, baseUrl === undefined ? null : baseUrl, sizes ? JSON.stringify(sizes) : null, input.qualityOptions ? JSON.stringify(qualities) : null, input.maxCount || null, input.concurrencyLimit || null, typeof input.enabled === 'boolean' ? input.enabled : null, typeof input.watermark === 'boolean' ? input.watermark : null, input.sortOrder ?? null, credId === undefined ? null : credId, id]) }
  else result = await db().query('INSERT INTO model_configs(display_name,adapter,vendor_model_id,base_url,sizes,quality_options,max_count,concurrency_limit,enabled,watermark,sort_order,created_by,provider_credential_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *', [input.displayName, adapter, input.vendorModelId, baseUrl || null, JSON.stringify(sizes), JSON.stringify(qualities), Number(input.maxCount || 1), Number(input.concurrencyLimit || 1), input.enabled === true, input.watermark === true, Number(input.sortOrder || 0), actor.id, (typeof credId === 'string' && credId) ? credId : null])
  if (!result.rows[0]) return fail('NOT_FOUND', '模型不存在', 404); await audit(db(), actor, id ? 'model.update' : 'model.create', 'model', result.rows[0].id); return ok(modelDto(result.rows[0]))
}

export async function PUT(request: NextRequest, context: Context) {
  if (!mutationOriginValid(request)) return fail('CSRF_REJECTED', '请求来源无效', 403); const path = await cleanPath(context); const input = await body(request); const actor = await requireActor(request, true); if (isResponse(actor)) return actor
  if (path !== 'admin/smtp') return fail('NOT_FOUND', '接口不存在', 404)
  if (typeof input.host !== 'string' || !emailValid(input.from) || !Number.isInteger(input.port) || !['implicit_tls','starttls','none'].includes(String(input.secure))) return fail('INVALID_INPUT', 'SMTP 配置无效')
  if (process.env.NODE_ENV === 'production' && input.secure === 'none' && process.env.ALLOW_INSECURE_SMTP !== 'true') return fail('INSECURE_SMTP', '生产环境必须启用 SMTP 加密')
  const password = typeof input.password === 'string' && input.password ? encryptSecret(input.password) : null
  await transaction(async client => { await client.query('INSERT INTO smtp_settings(singleton,host,port,tls_mode,from_address,from_name,username,password_encrypted,updated_by) VALUES(true,$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(singleton) DO UPDATE SET host=EXCLUDED.host,port=EXCLUDED.port,tls_mode=EXCLUDED.tls_mode,from_address=EXCLUDED.from_address,from_name=EXCLUDED.from_name,username=EXCLUDED.username,password_encrypted=COALESCE(EXCLUDED.password_encrypted,smtp_settings.password_encrypted),updated_by=EXCLUDED.updated_by,updated_at=now()', [input.host, input.port, input.secure, input.from, String(input.fromName || 'MuseCanvas'), String(input.user || ''), password, actor.id]); await audit(client, actor, 'smtp.update', 'smtp', 'singleton') })
  return ok({ host: input.host, port: input.port, secure: input.secure, from: input.from, fromName: input.fromName, user: input.user, hasPassword: !!password })
}

export async function DELETE(request: NextRequest, context: Context) {
  if (!mutationOriginValid(request)) return fail('CSRF_REJECTED', '请求来源无效', 403); const path = await cleanPath(context); const actor = await requireActor(request, path.startsWith('admin/')); if (isResponse(actor)) return actor
  const asset = path.match(/^library\/([0-9a-f-]+)$/); if (asset) { const deleted = await transaction(async client => { const r = await client.query('UPDATE assets SET deleted_at=now(),updated_at=now() WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL RETURNING id,object_key', [asset[1], actor.id]); if (!r.rows[0]) return false; await client.query('INSERT INTO asset_deletion_jobs(asset_id,object_key) VALUES($1,$2) ON CONFLICT DO NOTHING', [r.rows[0].id, r.rows[0].object_key]); return true }); return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '图片不存在', 404) }
  const invite = path.match(/^admin\/invitations\/([0-9a-f-]+)$/); if (invite) { const r = await db().query('UPDATE invitations SET revoked_at=now() WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id', [invite[1]]); if (r.rows[0]) await audit(db(), actor, 'invitation.revoke', 'invitation', invite[1]); return r.rows[0] ? ok({ revoked: true }) : fail('NOT_FOUND', '邀请码不存在', 404) }
  const user = path.match(/^admin\/users\/([0-9a-f-]+)$/); if (user) { if (user[1] === actor.id) return fail('INVALID_OPERATION', '不能删除当前管理员'); const deleted = await transaction(async client => { const r = await client.query('UPDATE users SET deleted_at=now(),deletion_requested_at=now(),session_version=session_version+1,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id', [user[1]]); if (!r.rows[0]) return false; await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [user[1]]); await client.query("UPDATE generation_jobs SET status='canceled',completed_at=now() WHERE created_by=$1 AND status IN('queued','retry_wait')", [user[1]]); await client.query('INSERT INTO deletion_jobs(user_id) VALUES($1) ON CONFLICT DO NOTHING', [user[1]]); await audit(client, actor, 'user.delete', 'user', user[1]); return true }); return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '用户不存在', 404) }
  const credDel = path.match(/^admin\/provider-credentials\/([0-9a-f-]+)$/); if (credDel) return deleteProviderCredential(actor, credDel[1])
  const oauthUnlink = path.match(/^account\/oauth\/(github|google)$/)
  if (oauthUnlink) { const r = await db().query('UPDATE oauth_identities SET deleted_at=now() WHERE user_id=$1 AND provider=$2 AND deleted_at IS NULL RETURNING id', [actor.id, oauthUnlink[1]]); if (r.rows[0]) await audit(db(), actor, 'oauth.unlink', 'oauth_identity', r.rows[0].id, { provider: oauthUnlink[1] }); return r.rows[0] ? ok({ unlinked: true }) : fail('NOT_FOUND', '未绑定该第三方账户', 404) }
  return fail('NOT_FOUND', '接口不存在', 404)
}

async function createProviderCredential(actor: Actor, input: Record<string, unknown>) {
  const adapter = input.adapter
  if (adapter !== 'openai' && adapter !== 'seedream') return fail('INVALID_INPUT', '供应商类型无效')
  if (typeof input.displayName !== 'string' || !input.displayName.trim()) return fail('INVALID_INPUT', '凭据名称不能为空')
  const baseUrl = input.baseUrl !== undefined ? normalizedProviderBaseUrl(input.baseUrl) : undefined
  if (baseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
  let apiKeyEncrypted: string | null = null
  let fingerprint: string | null = null
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    apiKeyEncrypted = encryptApiKey(input.apiKey.trim())
    fingerprint = fingerprintApiKey(input.apiKey.trim())
  }
  const enabled = input.enabled === true
  const r = await db().query('INSERT INTO provider_credentials(display_name,adapter,base_url,api_key_encrypted,api_key_fingerprint,enabled,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *', [input.displayName.trim(), adapter, baseUrl || null, apiKeyEncrypted, fingerprint, enabled, actor.id])
  await audit(db(), actor, 'provider_credential.create', 'provider_credential', r.rows[0].id)
  return ok(providerCredentialDto(r.rows[0]))
}

async function updateProviderCredential(actor: Actor, id: string, input: Record<string, unknown>) {
  const existing = await db().query('SELECT * FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [id])
  if (!existing.rows[0]) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  const baseUrl = input.baseUrl !== undefined ? normalizedProviderBaseUrl(input.baseUrl) : undefined
  if (baseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
  let apiKeyEncrypted = existing.rows[0].api_key_encrypted
  let fingerprint = existing.rows[0].api_key_fingerprint
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    apiKeyEncrypted = encryptApiKey(input.apiKey.trim())
    fingerprint = fingerprintApiKey(input.apiKey.trim())
  }
  const r = await db().query('UPDATE provider_credentials SET display_name=COALESCE($1,display_name),base_url=COALESCE($2,base_url),api_key_encrypted=COALESCE($3,api_key_encrypted),api_key_fingerprint=COALESCE($4,api_key_fingerprint),enabled=COALESCE($5,enabled),updated_at=now(),updated_by=$6 WHERE id=$7 AND deleted_at IS NULL RETURNING *', [typeof input.displayName === 'string' ? input.displayName.trim() : null, baseUrl || undefined, apiKeyEncrypted, fingerprint, typeof input.enabled === 'boolean' ? input.enabled : null, actor.id, id])
  if (!r.rows[0]) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  await audit(db(), actor, 'provider_credential.update', 'provider_credential', id)
  return ok(providerCredentialDto(r.rows[0]))
}

async function testProviderCredential(actor: Actor, id: string) {
  const cred = await db().query('SELECT * FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [id])
  if (!cred.rows[0]) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  if (!cred.rows[0].api_key_encrypted) {
    await db().query("UPDATE provider_credentials SET last_test_status='failed',last_test_error_code='NO_API_KEY',last_tested_at=now() WHERE id=$1", [id])
    return fail('INVALID_INPUT', '未配置 API Key，无法测试')
  }
  const apiKey = decryptApiKey(cred.rows[0].api_key_encrypted)
  const baseUrl = cred.rows[0].base_url || (cred.rows[0].adapter === 'openai' ? 'https://api.openai.com' : 'https://ark.cn-beijing.volces.com')
  try {
    const endpoint = baseUrl.replace(/\/$/, '')
    const response = await fetch(`${endpoint}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(response.status.toString())
    await db().query("UPDATE provider_credentials SET last_test_status='success',last_test_error_code=NULL,last_tested_at=now() WHERE id=$1", [id])
    await audit(db(), actor, 'provider_credential.test', 'provider_credential', id, { status: 'success' })
    return ok({ tested: true, status: 'success' })
  } catch (error) {
    const code = error instanceof Error ? (error.message === 'PROVIDER_NOT_CONFIGURED' ? 'NO_API_KEY' : 'CONNECTIVITY_FAILED') : 'CONNECTIVITY_FAILED'
    await db().query('UPDATE provider_credentials SET last_test_status=$1,last_test_error_code=$2,last_tested_at=now() WHERE id=$3', ['failed', code, id])
    await audit(db(), actor, 'provider_credential.test', 'provider_credential', id, { status: 'failed', code })
    return fail(code, '凭据测试失败，请检查 API Key 和 Base URL')
  }
}

async function deleteProviderCredential(actor: Actor, id: string) {
  const used = await db().query('SELECT id FROM model_configs WHERE provider_credential_id=$1 AND deleted_at IS NULL LIMIT 1', [id])
  if (used.rows[0]) return fail('INVALID_OPERATION', '该凭据仍被模型引用，请先解除模型的凭据关联')
  const r = await db().query('UPDATE provider_credentials SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id', [id])
  if (!r.rows[0]) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  await audit(db(), actor, 'provider_credential.delete', 'provider_credential', id)
  return ok({ deleted: true })
}

async function updateOAuthProvider(actor: Actor, provider: OAuthProvider, input: Record<string, unknown>) {
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : undefined
  const clientSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : undefined
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : undefined
  if (clientId !== undefined && clientId.length > 300) return fail('INVALID_INPUT', 'Client ID 过长')
  if (clientSecret !== undefined && clientSecret.length > 1000) return fail('INVALID_INPUT', 'Client Secret 过长')
  const secretEncrypted = clientSecret ? encryptOAuthSecret(clientSecret) : undefined
  const result = await db().query(
    'INSERT INTO oauth_provider_settings(provider,client_id,client_secret_encrypted,enabled,updated_by) VALUES($1,$2,$3,COALESCE($4,false),$5) ON CONFLICT(provider) DO UPDATE SET client_id=COALESCE(EXCLUDED.client_id,oauth_provider_settings.client_id),client_secret_encrypted=COALESCE(EXCLUDED.client_secret_encrypted,oauth_provider_settings.client_secret_encrypted),enabled=COALESCE(EXCLUDED.enabled,oauth_provider_settings.enabled),updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *',
    [provider, clientId || null, secretEncrypted || null, enabled, actor.id],
  )
  await audit(db(), actor, 'oauth_provider.update', 'oauth_provider', provider, { enabled })
  const setting = await oauthSetting(provider)
  const row = result.rows[0]
  return ok({
    provider,
    label: oauthProviderLabels[provider],
    enabled: setting.enabled,
    configuredInDatabase: !!row.enabled,
    source: setting.source,
    clientId: row.client_id || '',
    hasClientSecret: !!row.client_secret_encrypted,
    redirectUri: `${setting.config.redirectBaseUrl.replace(/\/$/, '')}/api/auth/oauth/${provider}/callback`,
  })
}

// ---- OAuth orchestration -------------------------------------------------

/** Attach a fresh session cookie for the given user to a redirect response. */
async function issueSession(userId: string, response: NextResponse): Promise<NextResponse> {
  const token = randomToken()
  await db().query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')", [userId, hashToken(token)])
  response.cookies.set('muse_session', token, { httpOnly: true, secure: process.env.COOKIE_SECURE === 'true', sameSite: 'lax', path: '/', maxAge: 30 * 86400 })
  return response
}

async function startOAuth(provider: OAuthProvider, mode: 'login' | 'link', userId?: string): Promise<NextResponse> {
  const setting = await oauthSetting(provider)
  if (!setting.enabled) return loginRedirect('OAUTH_PROVIDER_DISABLED')
  const state = randomToken(24)
  const pkceVerifier = createPkceVerifier()
  const nonce = randomToken(16)
  const record: OAuthStateRecord = { mode, provider, pkceVerifier, nonce, userId }
  try {
    await redisSet(`oauth:state:${state}`, record, OAUTH_STATE_TTL)
  } catch { return loginRedirect('OAUTH_STATE_FAILED') }
  return NextResponse.redirect(authorizeUrlWithConfig(provider, setting.config, { state, pkceChallenge: pkceChallenge(pkceVerifier), nonce }))
}

async function handleOAuthCallback(request: NextRequest, provider: OAuthProvider): Promise<NextResponse> {
  const setting = await oauthSetting(provider)
  if (!setting.enabled) return loginRedirect('OAUTH_PROVIDER_DISABLED')
  const params = request.nextUrl.searchParams
  if (params.get('error')) return loginRedirect('OAUTH_DENIED')
  const code = params.get('code'); const state = params.get('state')
  if (!code || !state) return loginRedirect('OAUTH_INVALID_CALLBACK')

  const record = await redisGetDel<OAuthStateRecord>(`oauth:state:${state}`)
  if (!record || record.provider !== provider) return loginRedirect('OAUTH_STATE_EXPIRED')

  let profile
  try {
    const tokens = await exchangeCodeWithConfig(provider, setting.config, code, record.pkceVerifier)
    profile = await fetchProfileWithConfig(provider, setting.config, tokens, record.nonce)
  } catch (error) {
    const known = error instanceof Error && /^OAUTH_/.test(error.message) ? error.message : 'OAUTH_PROFILE_FAILED'
    return loginRedirect(known)
  }
  if (!profile.emailVerified) return loginRedirect('OAUTH_EMAIL_UNVERIFIED')

  return record.mode === 'link' && record.userId
    ? linkIdentity(record.userId, provider, profile)
    : loginWithIdentity(provider, profile)
}

async function loginWithIdentity(provider: OAuthProvider, profile: OAuthProfile): Promise<NextResponse> {
  const successUrl = (role: string) => `${(process.env.OAUTH_REDIRECT_BASE_URL || '').replace(/\/$/, '')}${role === 'admin' ? '/admin' : '/generate'}`
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
    } catch { return loginRedirect('OAUTH_IDENTITY_CONFLICT') }
    return issueSession(existing.rows[0].id, NextResponse.redirect(successUrl(existing.rows[0].role)))
  }
  // 4/5. New email — depends on registration mode.
  const setting = await db().query('SELECT mode FROM registration_settings WHERE singleton=true')
  if (setting.rows[0]?.mode === 'invite_only') {
    const challengeId = randomToken(18)
    const challenge: OAuthChallengeRecord = { email: profile.email, provider, providerSubject: profile.providerSubject, displayName: profile.displayName, avatarUrl: profile.avatarUrl }
    try { await redisSet(`oauth:challenge:${challengeId}`, challenge, OAUTH_STATE_TTL) } catch { return loginRedirect('OAUTH_STATE_FAILED') }
    const base = (process.env.OAUTH_REDIRECT_BASE_URL || '').replace(/\/$/, '')
    return NextResponse.redirect(`${base}/login?oauth_challenge=${challengeId}&email=${encodeURIComponent(profile.email)}&provider=${provider}`)
  }
  const created = await transaction(async client => {
    const user = await client.query('INSERT INTO users(email) VALUES($1) RETURNING id,role', [profile.email])
    await client.query('INSERT INTO oauth_identities(user_id,provider,provider_subject,email_at_link,email_verified,display_name,avatar_url) VALUES($1,$2,$3,$4,$5,$6,$7)', [user.rows[0].id, provider, profile.providerSubject, profile.email, profile.emailVerified, profile.displayName || null, profile.avatarUrl || null])
    return user.rows[0]
  })
  return issueSession(created.id, NextResponse.redirect(successUrl(created.role)))
}

async function linkIdentity(userId: string, provider: OAuthProvider, profile: OAuthProfile): Promise<NextResponse> {
  const base = (process.env.OAUTH_REDIRECT_BASE_URL || '').replace(/\/$/, '')
  const accountRedirect = (code?: string) => NextResponse.redirect(`${base}/account${code ? `?error=${encodeURIComponent(code)}` : '?linked=1'}`)
  // The OAuth email must match the logged-in account's email.
  const user = await db().query('SELECT id FROM users WHERE id=$1 AND lower(email)=$2 AND deleted_at IS NULL', [userId, profile.email])
  if (!user.rows[0]) return accountRedirect('OAUTH_EMAIL_MISMATCH')
  try {
    await db().query('INSERT INTO oauth_identities(user_id,provider,provider_subject,email_at_link,email_verified,display_name,avatar_url) VALUES($1,$2,$3,$4,$5,$6,$7)', [userId, provider, profile.providerSubject, profile.email, profile.emailVerified, profile.displayName || null, profile.avatarUrl || null])
  } catch { return accountRedirect('OAUTH_IDENTITY_CONFLICT') }
  return accountRedirect()
}

async function completeOAuthInvitation(request: NextRequest, input: Record<string, unknown>): Promise<NextResponse> {
  const challengeId = typeof input.challengeId === 'string' ? input.challengeId : ''
  const invitationCode = typeof input.invitationCode === 'string' ? input.invitationCode.trim() : ''
  if (!challengeId || !invitationCode) return fail('INVALID_INPUT', '缺少注册参数')
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown'
  if (await limited(`oauth-invite:${ip}`, 10, 600)) return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
  const challenge = await redisGetDel<OAuthChallengeRecord>(`oauth:challenge:${challengeId}`)
  if (!challenge) return fail('OAUTH_REGISTRATION_EXPIRED', '注册会话已过期，请重新登录', 410)
  const result = await transaction(async client => {
    const invite = await client.query('UPDATE invitations SET consumed_at=now() WHERE lower(email)=$1 AND code_hash=$2 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING id', [challenge.email, hashToken(invitationCode)])
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
