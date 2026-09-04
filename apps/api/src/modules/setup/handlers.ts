import { randomInt } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import {
  db,
  transaction,
  createPromptTemplateSetWithEntries,
  getOnboardingState,
  installSetupClaim,
  verifyAndConsumeSetupClaim,
  createSetupSession,
  getValidSetupSession,
  updateSiteSettings,
  updateSmtpSettings,
  updateStorageSettings,
  updateRuntimeSettings,
  markOnboardingSection,
  tryCompleteOnboarding,
  getActivePromptTemplateSet,
  listPromptTemplateEntries,
} from '@musecanvas/database'
import {
  derivePurposeKey,
  encryptForPurpose,
  hmacForPurpose,
  loadPromptTemplateIndex,
} from '@musecanvas/providers'
import type {
  BootstrapCheck,
  BootstrapDiagnostics,
  OnboardingSectionKey,
  OnboardingSectionState,
  SetupStatusResponse,
} from '@musecanvas/contracts'
import { hashOtp, hashToken, randomToken, verifyOtpHash, actorFrom, shouldUseSecureCookie } from '../../auth/security'
import { body, emailValid, fail, ok } from '../../shared/http'
import { userDto } from '../../shared/dto'
import { sendMail, verifySmtpConnection, testStorageConnection } from '../../shared/services'
import { limited, redisPing } from '../../shared/redis'
import {
  resolvePublicOrigin,
  resolveSiteSettings,
  resolveSmtpSettings,
  resolveStorageSettings,
  resolveRuntimeSettings,
  invalidateRuntimeSettings,
  siteSettingsDto,
  smtpSettingsDto,
  storageSettingsDto,
  runtimeSettingsDto,
} from '../settings/runtime'
import {
  validateSiteInput,
  validateSmtpInput,
  validateStorageInput,
  validateRuntimeInput,
  validateTemplateImport,
  type InputError,
} from './validation'

const SETUP_COOKIE = 'muse_setup'
const CLAIM_TTL_SECONDS = 15 * 60
const SETUP_SESSION_TTL_SECONDS = 30 * 60

function asError<T>(value: T | InputError): value is InputError {
  return value !== null && typeof value === 'object' && 'code' in value && 'message' in value
}

async function noAdminGuard(): Promise<NextResponse | null> {
  const r = await db().query("SELECT count(*)::int AS cnt FROM users WHERE role='admin' AND deleted_at IS NULL")
  if (r.rows[0].cnt > 0) return fail('SETUP_ALREADY_COMPLETE', '系统已初始化', 409)
  return null
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
  if (await setupSessionValid(request.cookies.get(SETUP_COOKIE)?.value)) return true
  try {
    const actor = await actorFrom(request)
    return !!actor && actor.role === 'admin'
  } catch {
    return false
  }
}

async function requireSetupAccess(request: NextRequest): Promise<NextResponse | null> {
  if (await hasSetupAccess(request)) return null
  return fail('SETUP_SESSION_INVALID', '无初始化访问权限，请先验证一次性验证码', 401)
}

async function actorId(request: NextRequest): Promise<string | null> {
  try {
    return (await actorFrom(request))?.id ?? null
  } catch {
    return null
  }
}

async function bootstrapDiagnostics(): Promise<BootstrapDiagnostics> {
  const checks: BootstrapCheck[] = []
  try {
    await db().query('SELECT 1')
    checks.push({ key: 'database', status: 'ok' })
  } catch {
    checks.push({ key: 'database', status: 'error', message: '数据库连接失败' })
  }
  if (await redisPing()) {
    checks.push({ key: 'redis', status: 'ok' })
  } else {
    checks.push({ key: 'redis', status: 'error', message: '缓存服务连接失败' })
  }
  if (!process.env.APP_MASTER_KEY) {
    checks.push({ key: 'masterKey', status: 'missing', message: '应用主密钥未配置' })
  } else {
    try {
      derivePurposeKey('session-hmac')
      checks.push({ key: 'masterKey', status: 'ok' })
    } catch {
      checks.push({ key: 'masterKey', status: 'error', message: '应用主密钥无效' })
    }
  }
  const nodeEnv = process.env.NODE_ENV || 'development'
  if (nodeEnv === 'development' || nodeEnv === 'test' || nodeEnv === 'production') {
    checks.push({ key: 'runtime', status: 'ok' })
  } else {
    checks.push({ key: 'runtime', status: 'error', message: '运行环境标识无效' })
  }
  return { checks, ready: checks.every((check) => check.status === 'ok'), checkedAt: new Date().toISOString() }
}

function pendingSections(): Record<OnboardingSectionKey, OnboardingSectionState> {
  const section = (): OnboardingSectionState => ({ status: 'pending', updatedAt: new Date(0).toISOString() })
  return {
    bootstrap: section(),
    site: section(),
    smtp: section(),
    admin: section(),
    storage: section(),
    providers: section(),
    models: section(),
    oauth: section(),
    templates: section(),
    runtime: section(),
  }
}

// Single-flight claim install serialized by a row lock, so concurrent status
// polls never orphan each other's codes. Only the HMAC is stored; the
// plaintext is printed once to the server log and never returned.
async function ensureSetupClaim(): Promise<void> {
  await transaction(async (client) => {
    const res = await client.query(
      'SELECT claim_token_hash, claim_expires_at, claim_consumed_at FROM onboarding_state WHERE singleton=true FOR UPDATE',
    )
    const row = res.rows[0] as
      | { claim_token_hash: string | null; claim_expires_at: Date | string | null; claim_consumed_at: Date | string | null }
      | undefined
    if (!row) return
    const live = row.claim_token_hash !== null
      && row.claim_consumed_at === null
      && row.claim_expires_at !== null
      && new Date(row.claim_expires_at).getTime() > Date.now()
    if (live) return
    const code = randomToken(24)
    await installSetupClaim(client, {
      tokenHash: hmacForPurpose(code, 'setup-session'),
      expiresInSeconds: CLAIM_TTL_SECONDS,
    })
    console.log(`[setup] one-time setup claim code (valid ${CLAIM_TTL_SECONDS / 60} minutes, printed once): ${code}`)
  })
}

export async function setupStatus(): Promise<NextResponse> {
  const bootstrap = await bootstrapDiagnostics()
  const state = await getOnboardingState(db()).catch((): null => null)
  if (!state) {
    const payload: SetupStatusResponse = {
      setupComplete: false,
      status: 'pending',
      sections: pendingSections(),
      bootstrap,
      configRevision: 0,
      completedAt: null,
    }
    return ok(payload)
  }
  if (state.status === 'complete') {
    const payload: SetupStatusResponse = {
      setupComplete: true,
      status: 'complete',
      sections: state.sections,
      bootstrap: null,
      configRevision: state.configRevision,
      completedAt: state.completedAt,
    }
    return ok(payload)
  }
  if (bootstrap.ready && state.sections.bootstrap.status !== 'complete') {
    try {
      await markOnboardingSection(db(), 'bootstrap', 'complete')
    } catch {
      // Bootstrap section write is best-effort; diagnostics still report readiness.
    }
  }
  try {
    await ensureSetupClaim()
  } catch {
    // Claim install failure must not fail the status poll; claim retries next poll.
  }
  const current = await getOnboardingState(db()).catch(() => state)
  const snapshot = current ?? state
  const payload: SetupStatusResponse = {
    setupComplete: false,
    status: snapshot.status,
    sections: snapshot.sections,
    bootstrap,
    configRevision: snapshot.configRevision,
    completedAt: snapshot.completedAt,
  }
  return ok(payload)
}

export async function setupClaim(request: NextRequest, input: Record<string, unknown>): Promise<NextResponse> {
  const state = await getOnboardingState(db()).catch((): null => null)
  if (state?.status === 'complete') return fail('SETUP_ALREADY_COMPLETE', '系统已初始化', 409)
  const code = input.code
  if (typeof code !== 'string' || !code.trim() || code.length > 256) {
    return fail('INVALID_INPUT', '验证码无效')
  }
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (await limited(`setup-claim:${ip}`, 10, 600)) {
    return fail('RATE_LIMITED', '验证尝试过多，请稍后再试', 429)
  }
  // Atomic verify-and-consume: concurrent claims for the same code resolve to
  // exactly one winner inside verifyAndConsumeSetupClaim.
  let token: string | null = null
  try {
    token = await transaction(async (client) => {
      const next = await verifyAndConsumeSetupClaim(client, hmacForPurpose(code.trim(), 'setup-session'))
      if (!next || next.status === 'complete') return null
      const issued = randomToken()
      await createSetupSession(client, {
        tokenHash: hmacForPurpose(issued, 'setup-session'),
        expiresInSeconds: SETUP_SESSION_TTL_SECONDS,
      })
      return issued
    })
  } catch {
    return fail('SETUP_SESSION_INVALID', '验证码无效或已过期', 401)
  }
  if (!token) return fail('SETUP_SESSION_INVALID', '验证码无效或已过期', 401)
  const response = ok({
    claimed: true,
    expiresAt: new Date(Date.now() + SETUP_SESSION_TTL_SECONDS * 1000).toISOString(),
  })
  response.cookies.set(SETUP_COOKIE, token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(await resolvePublicOrigin()),
    sameSite: 'lax',
    path: '/',
    maxAge: SETUP_SESSION_TTL_SECONDS,
  })
  return response
}

export async function setupConfig(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSetupAccess(request)
  if (guard) return guard
  const [site, smtp, storage, runtime] = await Promise.all([
    resolveSiteSettings(),
    resolveSmtpSettings(),
    resolveStorageSettings(),
    resolveRuntimeSettings(),
  ])
  const active = await getActivePromptTemplateSet(db()).catch((): null => null)
  let entries: { name: string; description: string; path: string }[] = []
  if (active) {
    const rows = await listPromptTemplateEntries(db(), active.id).catch(() => [])
    entries = rows.map((entry) => ({ name: entry.name, description: entry.description, path: entry.path }))
  } else {
    try {
      const index = await loadPromptTemplateIndex()
      if (index.readable) {
        entries = index.entries.map((entry) => ({ name: entry.name, description: entry.description, path: entry.path }))
      }
    } catch {
      entries = []
    }
  }
  return ok({
    site: siteSettingsDto(site),
    smtp: smtpSettingsDto(smtp),
    storage: storageSettingsDto(storage),
    runtime: runtimeSettingsDto(runtime),
    templates: {
      active: active
        ? { id: active.id, name: active.name, version: active.version, entryCount: active.entryCount, updatedAt: active.updatedAt }
        : null,
      entries,
    },
  })
}

export async function setupSite(request: NextRequest, input: Record<string, unknown>): Promise<NextResponse> {
  const guard = await requireSetupAccess(request)
  if (guard) return guard
  const valid = validateSiteInput(input)
  if (asError(valid)) return fail(valid.code, valid.message)
  const saved = await updateSiteSettings(
    db(),
    { siteName: valid.siteName, siteUrl: valid.siteUrl },
    await actorId(request),
  )
  invalidateRuntimeSettings()
  return ok(siteSettingsDto(saved))
}

export async function setupSmtpTest(request: NextRequest, input: Record<string, unknown>): Promise<NextResponse> {
  const guard = await requireSetupAccess(request)
  if (guard) return guard
  const valid = validateSmtpInput(input)
  if (asError(valid)) return fail(valid.code, valid.message)
  const current = await resolveSmtpSettings()
  const password = valid.password.kind === 'keep'
    ? current.password
    : valid.password.kind === 'set'
      ? valid.password.password
      : null
  const merged = {
    host: valid.host ?? current.host,
    port: valid.port ?? current.port,
    tlsMode: valid.tlsMode ?? current.tlsMode,
    username: valid.username ?? current.username,
    password,
    fromAddress: valid.fromAddress ?? current.fromAddress,
    fromName: valid.fromName ?? current.fromName,
  }
  if (!merged.host || !merged.port) return fail('SMTP_TEST_FAILED', 'SMTP 服务器地址或端口尚未配置', 400)
  try {
    await verifySmtpConnection(merged)
  } catch {
    return fail('SMTP_TEST_FAILED', 'SMTP 连接测试失败，请检查配置', 400)
  }
  // Persist only after a successful connection. Failed tests store nothing.
  try {
    const secret = merged.password ? encryptForPurpose(merged.password, 'smtp-credentials') : null
    await updateSmtpSettings(
      db(),
      {
        host: merged.host,
        port: merged.port,
        tlsMode: merged.tlsMode,
        username: merged.username,
        fromAddress: merged.fromAddress,
        fromName: merged.fromName,
        status: 'verified',
        ...(secret
          ? { passwordCiphertext: secret.ciphertext, passwordFingerprint: secret.fingerprint, encryptionKeyId: secret.keyId }
          : valid.password.kind === 'clear'
            ? { clearSecret: true }
            : {}),
      },
      await actorId(request),
    )
  } catch {
    return fail('INTERNAL_ERROR', '保存 SMTP 设置失败', 500)
  }
  invalidateRuntimeSettings()
  return ok({ verified: true, settings: smtpSettingsDto(await resolveSmtpSettings()) })
}

export async function setupSmtp(request: NextRequest, input: Record<string, unknown>): Promise<NextResponse> {
  const guard = await requireSetupAccess(request)
  if (guard) return guard
  const valid = validateSmtpInput(input)
  if (asError(valid)) return fail(valid.code, valid.message)
  const current = await resolveSmtpSettings()
  const password = valid.password.kind === 'keep'
    ? current.password
    : valid.password.kind === 'set'
      ? valid.password.password
      : null
  const merged = {
    host: valid.host ?? current.host,
    port: valid.port ?? current.port,
    tlsMode: valid.tlsMode ?? current.tlsMode,
    username: valid.username ?? current.username,
    password,
    fromAddress: valid.fromAddress ?? current.fromAddress,
    fromName: valid.fromName ?? current.fromName,
  }
  try {
    const secret = merged.password ? encryptForPurpose(merged.password, 'smtp-credentials') : null
    await updateSmtpSettings(
      db(),
      {
        host: merged.host,
        port: merged.port,
        tlsMode: merged.tlsMode,
        username: merged.username,
        fromAddress: merged.fromAddress,
        fromName: merged.fromName,
        status: merged.host ? 'configured' : 'not_configured',
        ...(secret
          ? { passwordCiphertext: secret.ciphertext, passwordFingerprint: secret.fingerprint, encryptionKeyId: secret.keyId }
          : valid.password.kind === 'clear'
            ? { clearSecret: true }
            : {}),
      },
      await actorId(request),
    )
  } catch {
    return fail('INTERNAL_ERROR', '保存 SMTP 设置失败', 500)
  }
  invalidateRuntimeSettings()
  return ok(smtpSettingsDto(await resolveSmtpSettings()))
}

export async function setupStorageTest(request: NextRequest, input: Record<string, unknown>): Promise<NextResponse> {
  const guard = await requireSetupAccess(request)
  if (guard) return guard
  const valid = validateStorageInput(input)
  if (asError(valid)) return fail(valid.code, valid.message)
  const current = await resolveStorageSettings()
  const secret = valid.secret.kind === 'keep'
    ? current.secretAccessKey
    : valid.secret.kind === 'set'
      ? valid.secret.secret
      : null
  const merged = {
    endpoint: valid.endpoint ?? current.endpoint,
    publicEndpoint: valid.publicEndpoint ?? current.publicEndpoint,
    region: valid.region ?? current.region,
    bucket: valid.bucket ?? current.bucket,
    accessKeyId: valid.accessKeyId ?? current.accessKeyId,
    secretAccessKey: secret,
    signedUrlTtlSeconds: valid.signedUrlTtlSeconds ?? current.signedUrlTtlSeconds,
  }
  if (!merged.bucket || !merged.accessKeyId || !merged.secretAccessKey) {
    return fail('STORAGE_TEST_FAILED', '对象存储访问信息尚未配置完整', 400)
  }
  try {
    await testStorageConnection(merged)
  } catch {
    return fail('STORAGE_TEST_FAILED', '对象存储连接测试失败，请检查配置', 400)
  }
  // Persist only after a successful round-trip. Failed tests store nothing.
  try {
    const encrypted = merged.secretAccessKey
      ? encryptForPurpose(merged.secretAccessKey, 'object-storage-credentials')
      : null
    await updateStorageSettings(
      db(),
      {
        endpoint: merged.endpoint,
        publicEndpoint: merged.publicEndpoint,
        region: merged.region ?? 'us-east-1',
        bucket: merged.bucket,
        accessKeyId: merged.accessKeyId,
        signedUrlTtlSeconds: merged.signedUrlTtlSeconds,
        status: 'verified',
        ...(encrypted
          ? { secretCiphertext: encrypted.ciphertext, secretFingerprint: encrypted.fingerprint, encryptionKeyId: encrypted.keyId }
          : valid.secret.kind === 'clear'
            ? { clearSecret: true }
            : {}),
      },
      await actorId(request),
    )
  } catch {
    return fail('INTERNAL_ERROR', '保存对象存储设置失败', 500)
  }
  invalidateRuntimeSettings()
  return ok({ verified: true, settings: storageSettingsDto(await resolveStorageSettings()) })
}

export async function setupStorage(request: NextRequest, input: Record<string, unknown>): Promise<NextResponse> {
  const guard = await requireSetupAccess(request)
  if (guard) return guard
  const valid = validateStorageInput(input)
  if (asError(valid)) return fail(valid.code, valid.message)
  const current = await resolveStorageSettings()
  const secret = valid.secret.kind === 'keep'
    ? current.secretAccessKey
    : valid.secret.kind === 'set'
      ? valid.secret.secret
      : null
  const merged = {
    endpoint: valid.endpoint ?? current.endpoint,
    publicEndpoint: valid.publicEndpoint ?? current.publicEndpoint,
    region: valid.region ?? current.region,
    bucket: valid.bucket ?? current.bucket,
    accessKeyId: valid.accessKeyId ?? current.accessKeyId,
    secretAccessKey: secret,
    signedUrlTtlSeconds: valid.signedUrlTtlSeconds ?? current.signedUrlTtlSeconds,
  }
  try {
    const encrypted = merged.secretAccessKey
      ? encryptForPurpose(merged.secretAccessKey, 'object-storage-credentials')
      : null
    await updateStorageSettings(
      db(),
      {
        endpoint: merged.endpoint,
        publicEndpoint: merged.publicEndpoint,
        region: merged.region ?? 'us-east-1',
        bucket: merged.bucket,
        accessKeyId: merged.accessKeyId,
        signedUrlTtlSeconds: merged.signedUrlTtlSeconds,
        status: merged.bucket ? 'configured' : 'not_configured',
        ...(encrypted
          ? { secretCiphertext: encrypted.ciphertext, secretFingerprint: encrypted.fingerprint, encryptionKeyId: encrypted.keyId }
          : valid.secret.kind === 'clear'
            ? { clearSecret: true }
            : {}),
      },
      await actorId(request),
    )
  } catch {
    return fail('INTERNAL_ERROR', '保存对象存储设置失败', 500)
  }
  invalidateRuntimeSettings()
  return ok(storageSettingsDto(await resolveStorageSettings()))
}

export async function setupRuntime(request: NextRequest, input: Record<string, unknown>): Promise<NextResponse> {
  const guard = await requireSetupAccess(request)
  if (guard) return guard
  const valid = validateRuntimeInput(input)
  if (asError(valid)) return fail(valid.code, valid.message)
  const saved = await updateRuntimeSettings(db(), valid, await actorId(request))
  invalidateRuntimeSettings()
  return ok(runtimeSettingsDto(saved))
}
export async function setupTemplatesImport(
  request: NextRequest,
  input: Record<string, unknown>,
): Promise<NextResponse> {
  const guard = await requireSetupAccess(request)
  if (guard) return guard
  const entries = validateTemplateImport(input)
  if (asError(entries)) return fail(entries.code, entries.message)
  const uid = await actorId(request)
  // Immutable versioned import through the canonical repository transaction:
  // prior sets are never mutated, only deactivated, inside one transaction.
  const created = await transaction(async (client) => {
    const next = await createPromptTemplateSetWithEntries(client, {
      name: 'default',
      activate: true,
      createdBy: uid,
      entries: entries.map((entry, order) => ({
        name: entry.name,
        description: entry.description,
        instruction: entry.instruction,
        sortOrder: order,
      })),
    })
    await markOnboardingSection(client, 'templates', 'complete', uid)
    return next
  })
  invalidateRuntimeSettings()
  return ok({
    imported: true,
    setId: created.id,
    name: created.name,
    version: created.version,
    entryCount: created.entries.length,
    isActive: created.isActive,
  })
}

export async function setupComplete(request: NextRequest): Promise<NextResponse> {
  const guard = await requireSetupAccess(request)
  if (guard) return guard
  // Transaction-scoped: the state row is locked and flips to complete only
  // when every required section is complete and an active admin exists.
  const outcome = await transaction(async (client) => tryCompleteOnboarding(client))
  if (!outcome.completed) return fail('SETUP_INCOMPLETE', '仍有必填步骤未完成', 409)
  invalidateRuntimeSettings()
  const raw = request.cookies.get(SETUP_COOKIE)?.value
  if (raw) {
    try {
      await db().query('UPDATE setup_sessions SET consumed_at=now() WHERE token_hash=$1', [
        hmacForPurpose(raw, 'setup-session'),
      ])
    } catch {
      // The cookie is cleared below regardless; a stale row simply expires.
    }
  }
  const response = ok({
    completed: true,
    completedAt: outcome.state.completedAt,
    configRevision: outcome.state.configRevision,
  })
  response.cookies.delete(SETUP_COOKIE)
  return response
}

export async function setupAdminRequest(request: NextRequest, input: Record<string, unknown>): Promise<NextResponse> {
  const guard = await noAdminGuard()
  if (guard) return guard
  const access = await requireSetupAccess(request)
  if (access) return access

  if (!emailValid(input.email)) return fail('INVALID_INPUT', '邮箱格式不正确')

  const email = input.email.trim().toLowerCase()
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (await limited(`setup:${email}:${ip}`, 5, 600)) {
    return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
  }

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

export async function setupAdminVerify(request: NextRequest, input: Record<string, unknown>): Promise<NextResponse> {
  const guard = await noAdminGuard()
  if (guard) return guard
  const access = await requireSetupAccess(request)
  if (access) return access

  if (!emailValid(input.email) || typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)) {
    return fail('INVALID_OTP', '验证码无效')
  }

  const email = input.email.trim().toLowerCase()
  if (await limited(`setup-verify:${email}`, 10, 600)) {
    return fail('RATE_LIMITED', '验证尝试过多，请稍后再试', 429)
  }

  const result = await transaction(async (client) => {
    const adminCheck = await client.query("SELECT count(*)::int AS cnt FROM users WHERE role='admin' AND deleted_at IS NULL")
    if (adminCheck.rows[0].cnt > 0) return null
    const challengeResult = await client.query(
      "SELECT * FROM otp_challenges WHERE lower(email)=$1 AND consumed_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [email],
    )
    const challenge = challengeResult.rows[0]
    if (!challenge || challenge.attempts >= 5 || !verifyOtpHash(challenge.code_hash, email, input.code as string)) {
      if (challenge) await client.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id])
      return null
    }

    const userResult = await client.query(
      "INSERT INTO users(email,role) VALUES($1,'admin') RETURNING *",
      [email],
    )
    const user = userResult.rows[0]
    await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id])
    await markOnboardingSection(client, 'admin', 'complete', user.id)
    const token = randomToken()
    await client.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')", [user.id, hashToken(token)])
    return { user, token }
  })

  if (!result) return fail('INVALID_OTP', '验证码无效或已过期', 401)

  const response = ok({ user: userDto(result.user) })
  response.cookies.set('muse_session', result.token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(await resolvePublicOrigin()),
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 86400,
  })
  return response
}

// Single body parse for every setup POST route: handlers receive the parsed
// input and never touch the already-consumed request stream.
export async function handleSetupPost(request: NextRequest, path: string): Promise<NextResponse | null> {
  switch (path) {
    case 'setup/claim':
      return setupClaim(request, await body(request))
    case 'setup/site':
      return setupSite(request, await body(request))
    case 'setup/smtp/test':
      return setupSmtpTest(request, await body(request))
    case 'setup/smtp':
      return setupSmtp(request, await body(request))
    case 'setup/storage/test':
      return setupStorageTest(request, await body(request))
    case 'setup/storage':
      return setupStorage(request, await body(request))
    case 'setup/runtime':
      return setupRuntime(request, await body(request))
    case 'setup/prompt-templates/import':
      return setupTemplatesImport(request, await body(request))
    case 'setup/complete':
      return setupComplete(request)
    case 'setup/admin/request':
      return setupAdminRequest(request, await body(request))
    case 'setup/admin/verify':
      return setupAdminVerify(request, await body(request))
    default:
      return null
  }
}
