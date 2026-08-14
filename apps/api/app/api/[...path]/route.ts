import { randomInt, randomUUID } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { db, transaction } from '../../../../../packages/database/src/index'
import { validateModelInput } from '../../../../../packages/domain/src/index'
import { actorFrom, hashOtp, hashToken, randomToken, safeEqual, type Actor } from '../../../src/auth/security'
import { body, emailValid, fail, mutationOriginValid, ok } from '../../../src/shared/http'
import { adminJobDto, jobDto, modelDto, publicModelDto, userDto, providerCredentialDto, oauthIdentityDto } from '../../../src/shared/dto'
import { sendMail, signedAssetUrl } from '../../../src/shared/services'
import { limited } from '../../../src/shared/redis'
import { decodeCursor, encodeCursor, boundedLimit, userJobSelect } from '../../../src/shared/pagination'
import { modelPresets } from '../../../src/admin/model-presets'
import { loadPromptTemplateIndex, promptTemplateIndexDto } from '../../../../../packages/providers/src/index'
import { type OAuthProvider } from '../../../src/auth/oauth'
import { retryPreparation } from '../../../src/generation/job-retry'
import { oauthProviderList, adminOAuthSettings } from '../../../src/modules/auth/oauth-settings'
import { startOAuth, handleOAuthCallback, completeOAuthInvitation } from '../../../src/modules/auth/oauth-flow'
import { upsertModel, deleteModel } from '../../../src/modules/models/handlers'
import { deleteJobWithAssets } from '../../../src/modules/generations/handlers'
import { createProviderCredential, updateProviderCredential, deleteProviderCredential, testProviderCredential } from '../../../src/modules/admin/provider-credentials'
import { updateOAuthProvider } from '../../../src/modules/admin/oauth'
import { updatePromptOptimizationSettings } from '../../../src/modules/admin/prompt-optimization'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ path: string[] }> }
async function requireActor(request: NextRequest, admin = false): Promise<Actor | NextResponse> {
  const actor = await actorFrom(request)
  if (!actor) return fail('UNAUTHORIZED', '请先登录', 401)
  if (admin && actor.role !== 'admin') return fail('FORBIDDEN', '无权执行该操作', 403)
  return actor
}
function isResponse(value: Actor | NextResponse): value is NextResponse { return value instanceof NextResponse }
const cleanPath = (context: Context) => context.params.then(value => value.path.join('/'))
const audit = (client: any, actor: Actor, action: string, type: string, id: string, summary: object = {}) => client.query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,summary) VALUES($1,$2,$3,$4,$5)', [actor.id, action, type, id, summary])
const optimizationSettingsDto = (row: any) => ({ enabled: row.enabled, allowUserReadFinalPrompt: row.allow_user_read_final_prompt, languageModelConfigId: row.language_model_config_id || null, timeoutMs: row.timeout_ms, updatedAt: row.updated_at.toISOString() })

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
  if (credTest) return testProviderCredential(credTest[1])
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
  const credDel = path.match(/^admin\/provider-credentials\/([0-9a-f-]+)$/); if (credDel) return deleteProviderCredential(credDel[1])
  const oauthUnlink = path.match(/^account\/oauth\/(github|google)$/)
if (oauthUnlink) { const r = await db().query('UPDATE oauth_identities SET deleted_at=now() WHERE user_id=$1 AND provider=$2 AND deleted_at IS NULL RETURNING id', [actor.id, oauthUnlink[1]]); if (r.rows[0]) await audit(db(), actor, 'oauth.unlink', 'oauth_identity', r.rows[0].id, { provider: oauthUnlink[1] }); return r.rows[0] ? ok({ unlinked: true }) : fail('NOT_FOUND', '未绑定该第三方账户', 404) }
  return fail('NOT_FOUND', '接口不存在', 404)
}
