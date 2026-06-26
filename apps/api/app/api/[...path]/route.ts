import { randomInt, randomUUID } from 'node:crypto'
import { createClient } from 'redis'
import { NextResponse, type NextRequest } from 'next/server'
import { db, transaction } from '../../../../../packages/database/src/index'
import { validateModelInput } from '../../../../../packages/domain/src/index'
import { actorFrom, decryptOAuthSecret, encryptOAuthSecret, hashOtp, hashToken, randomToken, safeEqual, encryptApiKey, decryptApiKey, fingerprintApiKey, type Actor } from '../../../src/auth/security'
import { body, emailValid, fail, mutationOriginValid, ok } from '../../../src/shared/http'
import { adminJobDto, jobDto, modelDto, publicModelDto, userDto, providerCredentialDto, oauthIdentityDto } from '../../../src/shared/dto'
import { sendMail, signedAssetUrl } from '../../../src/shared/services'
import { modelPresets, type ModelPreset, type ReasoningEffort } from '../../../src/admin/model-presets'
import { callLanguageModel, loadPromptTemplateIndex, promptTemplateIndexDto, providerEndpoint, providerModelsEndpoint } from '../../../../../packages/providers/src/index'
import { authorizeUrlWithConfig, createPkceVerifier, envOAuthConfig, exchangeCodeWithConfig, fetchProfileWithConfig, pkceChallenge, runtimeProviderConfigured, type OAuthProfile, type OAuthProvider, type OAuthRuntimeConfig } from '../../../src/auth/oauth'
import { retryPreparation } from '../../../src/generation/job-retry'

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
const userJobSelect = `SELECT j.*,po.input_prompt,po.final_prompt,po.template_name_snapshot,po.status optimization_status,s.allow_user_read_final_prompt
  FROM generation_jobs j LEFT JOIN prompt_optimizations po ON po.id=j.prompt_optimization_id AND po.deleted_at IS NULL
  CROSS JOIN prompt_optimization_settings s`
const optimizationSettingsDto = (row: any) => ({ enabled: row.enabled, allowUserReadFinalPrompt: row.allow_user_read_final_prompt, languageModelConfigId: row.language_model_config_id || null, timeoutMs: row.timeout_ms, updatedAt: row.updated_at.toISOString() })
const reasoningEfforts: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh']
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

function presetById(value: unknown): ModelPreset | null {
  if (typeof value !== 'string') return null
  return modelPresets.find(preset => preset.id === value) || null
}

function sanitizeReasoningEffort(value: unknown, fallback?: string | null): ReasoningEffort | null | undefined {
  if (value === undefined) return fallback && reasoningEfforts.includes(fallback as ReasoningEffort) ? fallback as ReasoningEffort : undefined
  if (value === null || value === '') return null
  return typeof value === 'string' && reasoningEfforts.includes(value as ReasoningEffort) ? value as ReasoningEffort : undefined
}

export async function GET(request: NextRequest, context: Context) {
  const path = await cleanPath(context)
  if (path === 'health/live') return ok({ status: 'ok' })
  if (path === 'health/ready') { try { await db().query('SELECT 1'); return ok({ status: 'ready' }) } catch { return fail('DEPENDENCY_UNAVAILABLE', '服务尚未就绪', 503) } }
  if (path === 'registration') { const r = await db().query('SELECT mode FROM registration_settings WHERE singleton=true'); return ok({ requiresInvitation: r.rows[0]?.mode === 'invite_only' }) }
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
  if (path === 'models') { const r = await db().query("SELECT * FROM model_configs WHERE model_kind='image' AND enabled=true AND deleted_at IS NULL ORDER BY sort_order,created_at"); return ok(r.rows.map(publicModelDto)) }
  if (path === 'jobs') {
    const r = await db().query(`${userJobSelect} WHERE j.created_by=$1 AND j.deleted_at IS NULL ORDER BY j.created_at DESC LIMIT 50`, [actor.id])
    return ok({ items: await Promise.all(r.rows.map(async row => jobDto(row, (await db().query('SELECT go.asset_id,a.object_key FROM generation_outputs go JOIN assets a ON a.id=go.asset_id WHERE go.job_id=$1 AND a.deleted_at IS NULL', [row.id])).rows))), total: r.rowCount, hasMore: false })
  }
  const jobMatch = path.match(/^jobs\/([0-9a-f-]+)$/)
  if (jobMatch) {
    const r = await db().query(`${userJobSelect} WHERE j.id=$1 AND j.created_by=$2 AND j.deleted_at IS NULL`, [jobMatch[1], actor.id]); if (!r.rows[0]) return fail('NOT_FOUND', '任务不存在', 404)
    const outputs = await db().query('SELECT go.asset_id,a.object_key FROM generation_outputs go JOIN assets a ON a.id=go.asset_id WHERE go.job_id=$1 AND a.deleted_at IS NULL', [jobMatch[1]])
    return ok(await jobDto(r.rows[0], outputs.rows))
  }
  if (path === 'library') {
    const r = await db().query(`SELECT a.id,a.object_key,a.mime_type,a.width,a.height,a.size_bytes,a.created_at,COALESCE(po.input_prompt,a.prompt) input_prompt,po.final_prompt,s.allow_user_read_final_prompt
      FROM assets a JOIN generation_jobs j ON j.id=a.job_id LEFT JOIN prompt_optimizations po ON po.id=j.prompt_optimization_id AND po.deleted_at IS NULL CROSS JOIN prompt_optimization_settings s
      WHERE a.created_by=$1 AND a.deleted_at IS NULL AND j.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 50`, [actor.id])
    return ok({ items: await Promise.all(r.rows.map(async row => ({ id: row.id, prompt: row.input_prompt, inputPrompt: row.input_prompt, finalPrompt: row.allow_user_read_final_prompt ? row.final_prompt || null : null, canReadFinalPrompt: !!row.allow_user_read_final_prompt, imageUrl: await signedAssetUrl(row.object_key), mimeType: row.mime_type, width: row.width, height: row.height, sizeBytes: row.size_bytes, createdAt: row.created_at.toISOString() }))), total: r.rowCount, hasMore: false })
  }
  const downloadMatch = path.match(/^library\/([0-9a-f-]+)\/download$/)
  if (downloadMatch) { const r = await db().query('SELECT object_key FROM assets WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL', [downloadMatch[1], actor.id]); return r.rows[0] ? ok({ url: await signedAssetUrl(r.rows[0].object_key) }) : fail('NOT_FOUND', '图片不存在', 404) }

  if (path === 'admin/dashboard') {
    const r = await db().query(`SELECT (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) total_users,(SELECT count(*)::int FROM generation_jobs WHERE deleted_at IS NULL) total_jobs,(SELECT count(*)::int FROM generation_jobs WHERE status='failed' AND created_at>now()-interval '7 days') failed_jobs_7d,(SELECT COALESCE(round(100.0*count(*) FILTER(WHERE status='succeeded')/NULLIF(count(*) FILTER(WHERE status IN('succeeded','failed')),0),1),0)::float FROM generation_jobs WHERE created_at>now()-interval '7 days') success_rate_7d`)
    const x = r.rows[0]; return ok({ totalUsers: x.total_users, totalJobs: x.total_jobs, failedJobs7d: x.failed_jobs_7d, successRate7d: x.success_rate_7d })
  }
  if (path === 'admin/registration') { const r = await db().query('SELECT mode FROM registration_settings WHERE singleton=true'); return ok({ requiresInvitation: r.rows[0]?.mode === 'invite_only' }) }
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
  if (path === 'admin/prompt-templates') return ok(promptTemplateIndexDto(await loadPromptTemplateIndex()))
  if (path === 'admin/prompt-optimization-settings') { const r = await db().query('SELECT * FROM prompt_optimization_settings WHERE singleton=true'); return ok(optimizationSettingsDto(r.rows[0])) }
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
    values.push(limit + 1); const r = await db().query(`SELECT j.id,j.created_by,j.model_id,j.model_name,j.status,j.phase,j.error_code,j.provider_error,j.provider_reference_id,j.created_at,j.started_at,j.completed_at,po.template_name_snapshot,po.language_model_name_snapshot,po.language_model_vendor_id_snapshot,po.language_model_protocol_snapshot FROM generation_jobs j LEFT JOIN prompt_optimizations po ON po.id=j.prompt_optimization_id WHERE ${where.replaceAll('deleted_at', 'j.deleted_at').replaceAll('created_by', 'j.created_by').replaceAll('status=', 'j.status=').replaceAll('model_id', 'j.model_id').replaceAll('created_at', 'j.created_at').replaceAll('(j.created_at,id)', '(j.created_at,j.id)')} ORDER BY j.created_at DESC,j.id DESC LIMIT $${values.length}`, values)
    const total = await db().query(`SELECT count(*)::int total FROM generation_jobs WHERE ${totalWhere}`, totalValues); const hasMore = r.rows.length > limit; const rows = r.rows.slice(0, limit)
    return ok({ items: rows.map(adminJobDto), total: total.rows[0].total, hasMore, nextCursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : undefined })
  }
  if (path === 'admin/invitations') { const r = await db().query('SELECT id,consumed_at,revoked_at,created_at FROM invitations ORDER BY created_at DESC LIMIT 100'); return ok({ items: r.rows.map(row => ({ id: row.id, used: !!row.consumed_at, revoked: !!row.revoked_at, createdAt: row.created_at.toISOString() })), total: r.rowCount, hasMore: false }) }
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
      const invite = await db().query('SELECT id FROM invitations WHERE code_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now()', [invitationHash])
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
        if (setting.rows[0].mode === 'invite_only') { if (!challenge.invitation_code_hash) return null; const invite = await client.query('UPDATE invitations SET consumed_at=now() WHERE code_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING id', [challenge.invitation_code_hash]); if (!invite.rows[0]) return null }
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
    const allowedGenerationFields = new Set(['prompt', 'modelId', 'size', 'quality', 'count', 'idempotencyKey', 'inputLanguage'])
    if (Object.keys(input).some(key => !allowedGenerationFields.has(key))) return fail('INVALID_INPUT', '生成请求包含不允许的字段')
    if (typeof input.prompt !== 'string' || input.prompt.trim().length < 1 || input.prompt.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.prompt) || typeof input.modelId !== 'string' || typeof input.size !== 'string') return fail('INVALID_INPUT', '生成参数无效')
    if (await limited(`generate:${actor.id}`, 20, 60)) return fail('RATE_LIMITED', '提交过于频繁，请稍后再试', 429)
    const modelResult = await db().query("SELECT * FROM model_configs WHERE id=$1 AND model_kind='image' AND enabled=true AND deleted_at IS NULL", [input.modelId]); const model = modelResult.rows[0]; if (!model) return fail('MODEL_NOT_AVAILABLE', '模型当前不可用')
    const count = Number(input.count || 1); const validation = validateModelInput({ adapter: model.adapter, vendorModelId: model.vendor_model_id, sizes: model.sizes, qualityOptions: model.quality_options, maxCount: model.max_count }, { size: input.size, quality: typeof input.quality === 'string' ? input.quality : undefined, count }); if (validation) return fail(validation, '模型参数不受支持')
    const idempotencyKey = request.headers.get('idempotency-key') || (typeof input.idempotencyKey === 'string' ? input.idempotencyKey : randomUUID()); const prompt = input.prompt.trim(); const size = input.size
    let row: any
    try { row = await transaction(async client => { const existing = await client.query('SELECT * FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2', [actor.id, idempotencyKey]); if (existing.rows[0]) return existing.rows[0];
      let credId: string | null = null; let credName: string | null = null; let providerBaseUrl = model.base_url
      if (model.provider_credential_id) { const cred = await client.query('SELECT id, display_name, enabled, api_key_encrypted, base_url FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [model.provider_credential_id]); if (!cred.rows[0] || !cred.rows[0].enabled || !cred.rows[0].api_key_encrypted) throw new Error('PROVIDER_NOT_CONFIGURED'); credId = cred.rows[0].id; credName = cred.rows[0].display_name; providerBaseUrl = cred.rows[0].base_url || model.base_url }
      const settings = (await client.query(`SELECT s.*,m.display_name,m.vendor_model_id,m.adapter,m.language_protocol,m.max_output_tokens,m.temperature,m.reasoning_effort,m.base_url,pc.id credential_id,pc.display_name credential_name,pc.base_url credential_base_url,pc.enabled credential_enabled,pc.api_key_encrypted
        FROM prompt_optimization_settings s LEFT JOIN model_configs m ON m.id=s.language_model_config_id AND m.deleted_at IS NULL LEFT JOIN provider_credentials pc ON pc.id=m.provider_credential_id AND pc.deleted_at IS NULL WHERE s.singleton=true`)).rows[0]
      if (settings.enabled && (!settings.language_model_config_id || !settings.language_protocol || !settings.credential_id || !settings.credential_enabled || !settings.api_key_encrypted)) throw new Error('PROMPT_MODEL_NOT_CONFIGURED')
      const optimizationMode = settings.enabled ? 'enabled' : 'disabled'; const phase = settings.enabled ? 'template_selecting' : 'image_generating'
      const inserted = await client.query('INSERT INTO generation_jobs(created_by,model_id,model_name,adapter,vendor_model_id,provider_base_url,prompt,size,quality,count,watermark,idempotency_key,provider_credential_id,provider_credential_name,optimization_mode,phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *', [actor.id, model.id, model.display_name, model.adapter, model.vendor_model_id, providerBaseUrl, prompt, size, input.quality || null, count, model.watermark, idempotencyKey, credId, credName, optimizationMode, phase])
      if (settings.enabled) {
        const optimization = await client.query(`INSERT INTO prompt_optimizations(job_id,created_by,input_prompt,input_language,language_model_config_id,language_model_name_snapshot,language_model_vendor_id_snapshot,language_model_protocol_snapshot,language_model_adapter_snapshot,language_model_base_url_snapshot,language_model_max_output_tokens_snapshot,language_model_temperature_snapshot,language_model_reasoning_effort_snapshot,provider_credential_id,provider_credential_name_snapshot)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [inserted.rows[0].id, actor.id, prompt, typeof input.inputLanguage === 'string' ? input.inputLanguage.slice(0, 20) : 'und', settings.language_model_config_id, settings.display_name, settings.vendor_model_id, settings.language_protocol, settings.adapter, settings.credential_base_url || settings.base_url, settings.max_output_tokens, settings.temperature, settings.reasoning_effort, settings.credential_id, settings.credential_name])
        await client.query('UPDATE generation_jobs SET prompt_optimization_id=$1 WHERE id=$2', [optimization.rows[0].id, inserted.rows[0].id])
      }
      await client.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('generation.requested',$1,$2)", [inserted.rows[0].id, { jobId: inserted.rows[0].id }]); return inserted.rows[0] }) } catch (error) {
      const code = error instanceof Error && ['PROVIDER_NOT_CONFIGURED', 'PROMPT_MODEL_NOT_CONFIGURED'].includes(error.message) ? error.message : 'GENERATION_CREATE_FAILED'
      return fail(code, code === 'PROMPT_MODEL_NOT_CONFIGURED' ? '提示词优化模型配置不完整' : code === 'PROVIDER_NOT_CONFIGURED' ? '生图供应商凭据未配置' : '创建生成任务失败', 503)
    }
    const responseRow = await db().query(`${userJobSelect} WHERE j.id=$1 AND j.created_by=$2`, [row.id, actor.id])
    return ok(await jobDto(responseRow.rows[0] || row), { status: 202 })
  }
  const cancel = path.match(/^jobs\/([0-9a-f-]+)\/cancel$/)
  if (cancel) { const r = await db().query("UPDATE generation_jobs SET status='canceled',completed_at=now(),updated_at=now() WHERE id=$1 AND created_by=$2 AND status IN('queued','retry_wait') AND deleted_at IS NULL RETURNING *", [cancel[1], actor.id]); if (!r.rows[0]) return fail('JOB_NOT_CANCELABLE', '任务无法取消', 409); return ok(await jobDto(r.rows[0])) }
  const retry = path.match(/^jobs\/([0-9a-f-]+)\/retry$/)
  if (retry) {
    const row = await transaction(async client => {
      const current = await client.query(`SELECT j.id,j.prompt_optimization_id,j.optimization_mode,po.final_prompt,po.template_instruction_snapshot
        FROM generation_jobs j LEFT JOIN prompt_optimizations po ON po.id=j.prompt_optimization_id AND po.deleted_at IS NULL
        WHERE j.id=$1 AND j.created_by=$2 AND j.status=$3 AND j.deleted_at IS NULL FOR UPDATE OF j`, [retry[1], actor.id, 'failed'])
      const job = current.rows[0]
      if (!job) return null
      const preparation = retryPreparation(job)
      if (preparation.resetOptimization) await client.query("UPDATE prompt_optimizations SET status='pending',attempt=0,error_code=NULL,started_at=NULL,completed_at=NULL,updated_at=now() WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL", [job.prompt_optimization_id, actor.id])
      const updated = await client.query("UPDATE generation_jobs SET status='queued',phase=$3,attempt=0,error_code=NULL,provider_error=NULL,provider_reference_id=NULL,started_at=NULL,completed_at=NULL,updated_at=now() WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL RETURNING *", [retry[1], actor.id, preparation.phase])
      await client.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('generation.retry.manual',$1,$2)", [retry[1], { jobId: retry[1] }])
      return updated.rows[0]
    })
    if (!row) return fail('JOB_NOT_RETRYABLE', '任务无法重试', 409)
    const responseRow = await db().query(`${userJobSelect} WHERE j.id=$1 AND j.created_by=$2`, [row.id, actor.id])
    return ok(await jobDto(responseRow.rows[0] || row), { status: 202 })
  }
  if (path === 'admin/invitations') {
    const code = randomToken(18); const r = await db().query("INSERT INTO invitations(email,code_hash,expires_at,created_by) VALUES(NULL,$1,now()+interval '7 days',$2) RETURNING id,created_at", [hashToken(code), actor.id]); await audit(db(), actor, 'invitation.create', 'invitation', r.rows[0].id); return ok({ id: r.rows[0].id, code, used: false, createdAt: r.rows[0].created_at.toISOString() })
  }
  if (path === 'admin/models') return upsertModel(actor, input)
  if (path === 'admin/prompt-templates/reload') { const index = await loadPromptTemplateIndex(); await audit(db(), actor, 'prompt_templates.reload', 'prompt_templates', 'external', { valid: index.valid, entryCount: index.entryCount, errorCode: index.errorCode }); return ok(promptTemplateIndexDto(index)) }
  if (path === 'admin/provider-credentials') return createProviderCredential(actor, input)
  const credTest = path.match(/^admin\/provider-credentials\/([0-9a-f-]+)\/test$/)
  if (credTest) return testProviderCredential(actor, credTest[1])
  return fail('NOT_FOUND', '接口不存在', 404)
}

export async function PATCH(request: NextRequest, context: Context) {
  if (!mutationOriginValid(request)) return fail('CSRF_REJECTED', '请求来源无效', 403); const path = await cleanPath(context); const input = await body(request); const actor = await requireActor(request, true); if (isResponse(actor)) return actor
  if (path === 'admin/registration') { if (typeof input.requiresInvitation !== 'boolean') return fail('INVALID_INPUT', '注册模式无效'); const mode = input.requiresInvitation ? 'invite_only' : 'open'; await transaction(async client => { await client.query('UPDATE registration_settings SET mode=$1,updated_at=now(),updated_by=$2 WHERE singleton=true', [mode, actor.id]); await audit(client, actor, 'registration.update', 'registration', 'singleton', { requiresInvitation: input.requiresInvitation }) }); return ok({ requiresInvitation: input.requiresInvitation }) }
  if (path === 'admin/prompt-optimization-settings') return updatePromptOptimizationSettings(actor, input)
  const user = path.match(/^admin\/users\/([0-9a-f-]+)(?:\/status)?$/)
  if (user) { if (input.status !== 'active' && input.status !== 'disabled') return fail('INVALID_INPUT', '用户状态无效'); if (user[1] === actor.id && input.status === 'disabled') return fail('INVALID_OPERATION', '不能停用当前管理员'); const r = await transaction(async client => { const x = await client.query('UPDATE users SET status=$1,session_version=session_version+1,updated_at=now() WHERE id=$2 AND deleted_at IS NULL RETURNING *', [input.status, user[1]]); if (input.status === 'disabled') await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [user[1]]); if (x.rows[0]) await audit(client, actor, 'user.status', 'user', user[1], { status: input.status }); return x.rows[0] }); return r ? ok(userDto(r)) : fail('NOT_FOUND', '用户不存在', 404) }
  const model = path.match(/^admin\/models\/([0-9a-f-]+)$/); if (model) return upsertModel(actor, input, model[1])
  const cred = path.match(/^admin\/provider-credentials\/([0-9a-f-]+)$/); if (cred) return updateProviderCredential(actor, cred[1], input)
  const oauthProvider = path.match(/^admin\/oauth-providers\/(github|google)$/); if (oauthProvider) return updateOAuthProvider(actor, oauthProvider[1] as OAuthProvider, input)
  return fail('NOT_FOUND', '接口不存在', 404)
}

async function upsertModel(actor: Actor, input: Record<string, unknown>, id?: string) {
  const existing = id ? (await db().query('SELECT * FROM model_configs WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0] : null
  if (id && !existing) return fail('NOT_FOUND', '模型不存在', 404)
  const forbiddenManualFields = ['displayName', 'adapter', 'vendorModelId', 'baseUrl', 'sizes', 'qualityOptions', 'maxCount', 'languageProtocol', 'maxOutputTokens', 'temperature', 'modelKind']
  if (forbiddenManualFields.some(field => input[field] !== undefined)) return fail('INVALID_INPUT', '模型参数只能通过预设选择')
  const preset = input.presetId === undefined ? (existing?.preset_id ? presetById(existing.preset_id) : null) : presetById(input.presetId)
  if (!id && !preset) return fail('INVALID_PRESET', '请选择模型预设')
  if (input.presetId !== undefined && !preset) return fail('INVALID_PRESET', '模型预设不存在')
  const targetPreset = preset
  const credId = input.providerCredentialId
  const effectiveCredId = credId === undefined ? existing?.provider_credential_id : credId
  const targetKind = targetPreset?.modelKind || existing?.model_kind || 'image'
  const targetAdapter = targetPreset?.adapter || existing?.adapter
  if (targetKind === 'language' && (typeof effectiveCredId !== 'string' || !effectiveCredId)) return fail('LANGUAGE_MODEL_CONFIG_INVALID', '语言模型必须选择供应商凭据')
  if (typeof effectiveCredId === 'string' && effectiveCredId) {
    const cred = await db().query('SELECT adapter,enabled,api_key_encrypted FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [effectiveCredId])
    if (!cred.rows[0]) return fail('INVALID_INPUT', '供应商凭据不存在')
    if (targetKind === 'language') {
      if (!cred.rows[0].enabled || !cred.rows[0].api_key_encrypted) return fail('LANGUAGE_MODEL_CONFIG_INVALID', '请选择已启用且凭据完整的供应商凭据')
    }
    if (cred.rows[0].adapter !== targetAdapter) {
      return fail('INVALID_INPUT', '供应商凭据类型与模型不匹配')
    }
  }
  if (!['openai', 'seedream', 'anthropic'].includes(String(targetAdapter))) return fail('INVALID_INPUT', '模型配置无效')
  const concurrencyLimit = input.concurrencyLimit === undefined ? existing?.concurrency_limit ?? targetPreset?.concurrencyLimit ?? 1 : Number(input.concurrencyLimit)
  const sortOrder = input.sortOrder === undefined ? existing?.sort_order ?? 0 : Number(input.sortOrder)
  if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 50 || !Number.isInteger(sortOrder)) return fail('INVALID_INPUT', '并发或排序配置无效')
  const reasoningFallback = existing?.reasoning_effort || (targetPreset && 'reasoningEffort' in targetPreset ? targetPreset.reasoningEffort : null) || 'medium'
  const reasoningEffort = targetKind === 'language' ? sanitizeReasoningEffort(input.reasoningEffort, reasoningFallback) : null
  if (reasoningEffort === undefined && targetKind === 'language') return fail('INVALID_INPUT', '思考等级无效')
  let result
  if (id && !targetPreset) {
    result = await db().query(`UPDATE model_configs SET concurrency_limit=$1,enabled=COALESCE($2,enabled),watermark=COALESCE($3,watermark),sort_order=$4,provider_credential_id=CASE WHEN $5::text IS NULL THEN provider_credential_id WHEN $5::text = '' THEN NULL ELSE $5::uuid END,reasoning_effort=CASE WHEN model_kind='language' THEN $6 ELSE NULL END,updated_at=now() WHERE id=$7 AND deleted_at IS NULL RETURNING *`, [concurrencyLimit, typeof input.enabled === 'boolean' ? input.enabled : null, typeof input.watermark === 'boolean' ? input.watermark : null, sortOrder, credId === undefined ? null : credId, reasoningEffort ?? null, id])
  } else if (id && targetPreset) {
    result = await db().query(`UPDATE model_configs SET preset_id=$1,display_name=$2,adapter=$3,vendor_model_id=$4,base_url=$5,sizes=$6,quality_options=$7,max_count=$8,concurrency_limit=$9,enabled=COALESCE($10,enabled),watermark=$11,sort_order=$12,provider_credential_id=CASE WHEN $13::text IS NULL THEN provider_credential_id WHEN $13::text = '' THEN NULL ELSE $13::uuid END,model_kind=$14,language_protocol=$15,max_output_tokens=$16,temperature=$17,reasoning_effort=$18,updated_at=now() WHERE id=$19 AND deleted_at IS NULL RETURNING *`, [targetPreset.id, targetPreset.displayName, targetPreset.adapter, targetPreset.vendorModelId, targetPreset.baseUrl, targetPreset.modelKind === 'image' ? JSON.stringify(targetPreset.sizes) : null, targetPreset.modelKind === 'image' ? JSON.stringify(targetPreset.qualityOptions) : '[]', targetPreset.modelKind === 'image' ? targetPreset.maxCount : null, concurrencyLimit, typeof input.enabled === 'boolean' ? input.enabled : null, targetPreset.modelKind === 'image' && (typeof input.watermark === 'boolean' ? input.watermark : targetPreset.watermark), sortOrder, credId === undefined ? null : credId, targetPreset.modelKind, targetPreset.modelKind === 'language' ? targetPreset.languageProtocol : null, targetPreset.modelKind === 'language' ? targetPreset.maxOutputTokens : null, targetPreset.modelKind === 'language' && targetPreset.temperature !== undefined ? targetPreset.temperature : null, targetPreset.modelKind === 'language' ? reasoningEffort ?? null : null, id])
  } else if (targetPreset) {
    result = await db().query('INSERT INTO model_configs(preset_id,display_name,adapter,vendor_model_id,base_url,sizes,quality_options,max_count,concurrency_limit,enabled,watermark,sort_order,created_by,provider_credential_id,model_kind,language_protocol,max_output_tokens,temperature,reasoning_effort) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *', [targetPreset.id, targetPreset.displayName, targetPreset.adapter, targetPreset.vendorModelId, targetPreset.baseUrl, targetPreset.modelKind === 'image' ? JSON.stringify(targetPreset.sizes) : null, targetPreset.modelKind === 'image' ? JSON.stringify(targetPreset.qualityOptions) : '[]', targetPreset.modelKind === 'image' ? targetPreset.maxCount : null, concurrencyLimit, input.enabled === true, targetPreset.modelKind === 'image' && (typeof input.watermark === 'boolean' ? input.watermark : targetPreset.watermark), sortOrder, actor.id, (typeof credId === 'string' && credId) ? credId : null, targetPreset.modelKind, targetPreset.modelKind === 'language' ? targetPreset.languageProtocol : null, targetPreset.modelKind === 'language' ? targetPreset.maxOutputTokens : null, targetPreset.modelKind === 'language' && targetPreset.temperature !== undefined ? targetPreset.temperature : null, targetPreset.modelKind === 'language' ? reasoningEffort ?? null : null])
  } else {
    return fail('INVALID_PRESET', '请选择模型预设')
  }
  if (!result.rows[0]) return fail('NOT_FOUND', '模型不存在', 404); await audit(db(), actor, id ? 'model.update' : 'model.create', 'model', result.rows[0].id); return ok(modelDto(result.rows[0]))
}

async function updatePromptOptimizationSettings(actor: Actor, input: Record<string, unknown>) {
  if ('maxOutputChars' in input) return fail('INVALID_INPUT', '前处理设置已移除最大输出字符参数')
  if ('timeoutMs' in input) return fail('INVALID_INPUT', '前处理超时已固定为 600 秒')
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean' || input.allowUserReadFinalPrompt !== undefined && typeof input.allowUserReadFinalPrompt !== 'boolean') return fail('INVALID_INPUT', '前处理设置无效')
  const current = (await db().query('SELECT * FROM prompt_optimization_settings WHERE singleton=true')).rows[0]
  const modelId = input.languageModelConfigId === undefined ? current.language_model_config_id : input.languageModelConfigId
  const enabled = input.enabled === undefined ? current.enabled : input.enabled
  if (modelId !== null && (typeof modelId !== 'string' || !/^[0-9a-f-]{36}$/i.test(modelId))) return fail('INVALID_INPUT', '语言模型无效')
  if (modelId) {
    const model = await db().query(`SELECT m.id FROM model_configs m JOIN provider_credentials pc ON pc.id=m.provider_credential_id AND pc.deleted_at IS NULL WHERE m.id=$1 AND m.model_kind='language' AND m.enabled=true AND m.deleted_at IS NULL AND pc.enabled=true AND pc.api_key_encrypted IS NOT NULL`, [modelId])
    if (!model.rows[0]) return fail('LANGUAGE_MODEL_CONFIG_INVALID', '请选择已启用且凭据完整的语言模型')
  }
  if (enabled && !modelId) return fail('PROMPT_MODEL_NOT_CONFIGURED', '启用前请先选择语言模型')
  const timeoutMs = 600_000
  const updated = await transaction(async client => {
    const r = await client.query(`UPDATE prompt_optimization_settings SET enabled=$1,allow_user_read_final_prompt=$2,language_model_config_id=$3,timeout_ms=$4,updated_by=$5,updated_at=now() WHERE singleton=true RETURNING *`, [enabled, input.allowUserReadFinalPrompt === undefined ? current.allow_user_read_final_prompt : input.allowUserReadFinalPrompt, modelId, timeoutMs, actor.id])
    await audit(client, actor, 'prompt_optimization_settings.update', 'prompt_optimization_settings', 'singleton', { enabledBefore: current.enabled, enabledAfter: enabled, allowUserReadFinalPromptBefore: current.allow_user_read_final_prompt, allowUserReadFinalPromptAfter: r.rows[0].allow_user_read_final_prompt, languageModelConfigId: modelId })
    return r.rows[0]
  })
  return ok(optimizationSettingsDto(updated))
}

async function testLanguageModel(actor: Actor, id: string) {
  const r = await db().query(`SELECT m.*,pc.api_key_encrypted,COALESCE(pc.base_url,m.base_url) effective_base_url FROM model_configs m JOIN provider_credentials pc ON pc.id=m.provider_credential_id AND pc.deleted_at IS NULL WHERE m.id=$1 AND m.model_kind='language' AND m.deleted_at IS NULL AND pc.enabled=true`, [id])
  const model = r.rows[0]
  if (!model?.api_key_encrypted) return fail('PROMPT_MODEL_NOT_CONFIGURED', '语言模型或凭据未正确配置')
  try {
    const reasoningEffort = ['gpt-5.4', 'gpt-5.5'].includes(model.vendor_model_id) ? 'none' : model.reasoning_effort || undefined
    await callLanguageModel({ protocol: model.language_protocol, vendorModelId: model.vendor_model_id, baseUrl: model.effective_base_url, apiKey: decryptApiKey(model.api_key_encrypted), system: 'Return only the requested JSON.', user: 'MuseCanvas language model connectivity test. Return {"ok":"yes"}.', schemaName: 'connectivity_test', schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'string', const: 'yes' } }, required: ['ok'] }, maxOutputTokens: Math.min(1000, model.max_output_tokens), reasoningEffort, timeoutMs: 15000 })
    await audit(db(), actor, 'language_model.test', 'model', id, { status: 'success', protocol: model.language_protocol })
    return ok({ tested: true, status: 'success' })
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR'
    await audit(db(), actor, 'language_model.test', 'model', id, { status: 'failed', protocol: model.language_protocol, code })
    return fail(code, '语言模型连通性测试失败', 502)
  }
}

export async function PUT(request: NextRequest, context: Context) {
  if (!mutationOriginValid(request)) return fail('CSRF_REJECTED', '请求来源无效', 403); void context; const actor = await requireActor(request, true); if (isResponse(actor)) return actor
  return fail('NOT_FOUND', '接口不存在', 404)
}

export async function DELETE(request: NextRequest, context: Context) {
  if (!mutationOriginValid(request)) return fail('CSRF_REJECTED', '请求来源无效', 403); const path = await cleanPath(context); const actor = await requireActor(request, path.startsWith('admin/')); if (isResponse(actor)) return actor
  const job = path.match(/^jobs\/([0-9a-f-]+)$/); if (job) { const deleted = await deleteJobWithAssets(actor.id, job[1]); return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '任务不存在', 404) }
  const asset = path.match(/^library\/([0-9a-f-]+)$/); if (asset) { const ownerAsset = await db().query('SELECT job_id,deleted_at FROM assets WHERE id=$1 AND created_by=$2', [asset[1], actor.id]); if (!ownerAsset.rows[0]) return fail('NOT_FOUND', '图片不存在', 404); if (ownerAsset.rows[0].deleted_at) return ok({ deleted: true }); const deleted = await deleteJobWithAssets(actor.id, ownerAsset.rows[0].job_id); return deleted ? ok({ deleted: true }) : ok({ deleted: true }) }
  const invite = path.match(/^admin\/invitations\/([0-9a-f-]+)$/); if (invite) { const r = await db().query('UPDATE invitations SET revoked_at=now() WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id', [invite[1]]); if (r.rows[0]) await audit(db(), actor, 'invitation.revoke', 'invitation', invite[1]); return r.rows[0] ? ok({ revoked: true }) : fail('NOT_FOUND', '邀请码不存在', 404) }
  const user = path.match(/^admin\/users\/([0-9a-f-]+)$/); if (user) { if (user[1] === actor.id) return fail('INVALID_OPERATION', '不能删除当前管理员'); const deleted = await transaction(async client => { const r = await client.query('UPDATE users SET deleted_at=now(),deletion_requested_at=now(),session_version=session_version+1,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id', [user[1]]); if (!r.rows[0]) return false; await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [user[1]]); await client.query("UPDATE generation_jobs SET status='canceled',completed_at=now() WHERE created_by=$1 AND status IN('queued','retry_wait')", [user[1]]); await client.query('INSERT INTO deletion_jobs(user_id) VALUES($1) ON CONFLICT DO NOTHING', [user[1]]); await audit(client, actor, 'user.delete', 'user', user[1]); return true }); return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '用户不存在', 404) }
  const model = path.match(/^admin\/models\/([0-9a-f-]+)$/); if (model) return deleteModel(actor, model[1])
  const credDel = path.match(/^admin\/provider-credentials\/([0-9a-f-]+)$/); if (credDel) return deleteProviderCredential(actor, credDel[1])
  const oauthUnlink = path.match(/^account\/oauth\/(github|google)$/)
  if (oauthUnlink) { const r = await db().query('UPDATE oauth_identities SET deleted_at=now() WHERE user_id=$1 AND provider=$2 AND deleted_at IS NULL RETURNING id', [actor.id, oauthUnlink[1]]); if (r.rows[0]) await audit(db(), actor, 'oauth.unlink', 'oauth_identity', r.rows[0].id, { provider: oauthUnlink[1] }); return r.rows[0] ? ok({ unlinked: true }) : fail('NOT_FOUND', '未绑定该第三方账户', 404) }
  return fail('NOT_FOUND', '接口不存在', 404)
}

async function deleteJobWithAssets(userId: string, jobId: string) {
  return transaction(async client => {
    const current = await client.query('SELECT id,prompt_optimization_id,deleted_at FROM generation_jobs WHERE id=$1 AND created_by=$2 FOR UPDATE', [jobId, userId])
    const job = current.rows[0]
    if (!job) return false
    if (!job.deleted_at) await client.query(`UPDATE generation_jobs SET deleted_at=now(),updated_at=now(),status=CASE WHEN status IN('queued','retry_wait','running') THEN 'canceled' ELSE status END,completed_at=CASE WHEN status IN('queued','retry_wait','running') THEN COALESCE(completed_at,now()) ELSE completed_at END WHERE id=$1 AND created_by=$2`, [jobId, userId])
    if (job.prompt_optimization_id) await client.query('UPDATE prompt_optimizations SET deleted_at=now(),updated_at=now() WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL', [job.prompt_optimization_id, userId])
    const assets = await client.query('UPDATE assets SET deleted_at=now(),updated_at=now() WHERE job_id=$1 AND created_by=$2 AND deleted_at IS NULL RETURNING id,object_key', [jobId, userId])
    for (const asset of assets.rows) await client.query('INSERT INTO asset_deletion_jobs(asset_id,object_key) VALUES($1,$2) ON CONFLICT DO NOTHING', [asset.id, asset.object_key])
    return true
  })
}

async function deleteModel(actor: Actor, id: string) {
  const deleted = await transaction(async client => {
    const r = await client.query('UPDATE model_configs SET deleted_at=now(),enabled=false,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id', [id])
    if (!r.rows[0]) return false
    await client.query('UPDATE prompt_optimization_settings SET enabled=false,language_model_config_id=NULL,updated_by=$2,updated_at=now() WHERE language_model_config_id=$1', [id, actor.id])
    await audit(client, actor, 'model.delete', 'model', id)
    return true
  })
  return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '模型不存在', 404)
}

async function createProviderCredential(actor: Actor, input: Record<string, unknown>) {
  const adapter = input.adapter
  if (adapter !== 'openai' && adapter !== 'seedream' && adapter !== 'anthropic') return fail('INVALID_INPUT', '供应商类型无效')
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
  if (cred.rows[0].adapter === 'anthropic') {
    const model = await db().query("SELECT id FROM model_configs WHERE provider_credential_id=$1 AND model_kind='language' AND deleted_at IS NULL ORDER BY created_at LIMIT 1", [id])
    return model.rows[0] ? testLanguageModel(actor, model.rows[0].id) : fail('PROMPT_MODEL_NOT_CONFIGURED', '请先将该凭据关联到语言模型')
  }
  const baseUrl = cred.rows[0].base_url || (cred.rows[0].adapter === 'openai' ? 'https://api.openai.com' : 'https://ark.cn-beijing.volces.com')
  try {
    if (cred.rows[0].adapter === 'openai') {
      const response = await fetch(providerModelsEndpoint(baseUrl), { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`HTTP_${response.status}`)
    } else {
      const probe = await db().query('SELECT vendor_model_id,sizes FROM model_configs WHERE provider_credential_id=$1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1', [id])
      const probeModelId = typeof probe.rows[0]?.vendor_model_id === 'string' && probe.rows[0].vendor_model_id ? probe.rows[0].vendor_model_id : 'doubao-seedream-4-5-251128'
      const response = await fetch(providerEndpoint('seedream', baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: probeModelId, prompt: 'MuseCanvas provider connectivity test', size: '2048x2048', response_format: 'url', watermark: false, stream: false }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!response.ok) throw new Error(`HTTP_${response.status}`)
      const json = await response.json() as { data?: { url?: string }[] }
      if (!json.data?.some((item) => typeof item.url === 'string' && item.url.length > 0)) throw new Error('PROVIDER_EMPTY_RESULT')
    }
    await db().query("UPDATE provider_credentials SET last_test_status='success',last_test_error_code=NULL,last_tested_at=now() WHERE id=$1", [id])
    await audit(db(), actor, 'provider_credential.test', 'provider_credential', id, { status: 'success' })
    return ok({ tested: true, status: 'success' })
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith('HTTP_')
      ? (error.message === 'HTTP_429' || Number(error.message.slice(5)) >= 500 ? 'PROVIDER_TEMPORARY_ERROR' : 'PROVIDER_REJECTED')
      : error instanceof Error && error.message === 'PROVIDER_EMPTY_RESULT'
        ? 'PROVIDER_EMPTY_RESULT'
        : error instanceof Error && error.message === 'PROVIDER_NOT_CONFIGURED'
          ? 'NO_API_KEY'
          : 'CONNECTIVITY_FAILED'
    await db().query('UPDATE provider_credentials SET last_test_status=$1,last_test_error_code=$2,last_tested_at=now() WHERE id=$3', ['failed', code, id])
    await audit(db(), actor, 'provider_credential.test', 'provider_credential', id, { status: 'failed', code })
    return fail(code, code === 'PROVIDER_REJECTED'
      ? '凭据已连接到供应商，但被拒绝访问，请检查模型授权或 API Key 权限'
      : code === 'PROVIDER_TEMPORARY_ERROR'
        ? '供应商暂时不可用，请稍后重试'
        : code === 'PROVIDER_EMPTY_RESULT'
          ? '供应商没有返回可用图片结果'
          : '凭据测试失败，请检查 API Key 和 Base URL')
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
