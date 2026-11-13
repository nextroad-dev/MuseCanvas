// 安装向导各步骤的表单草稿、客户端校验与请求体构造（纯逻辑，node:test 可导入）。
// 只做服务端校验的前置镜像：真正的权威校验仍在 API，这里的目标是让错误就地可见。

import type {
  ImportPromptTemplateItem,
  RuntimeSettingsDto,
  RuntimeSettingsInput,
  SiteSettingsDto,
  SiteSettingsInput,
  SmtpSettingsDto,
  SmtpSettingsInput,
  SmtpTlsMode,
  StorageDriverKind,
  StorageSettingsDto,
  StorageSettingsInput,
} from '@musecanvas/contracts'

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isPlausibleEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim())
}

// ---------------------------------------------------------------------------
// 站点
// ---------------------------------------------------------------------------

export interface SiteDraft {
  siteName: string
  siteUrl: string
}

export function siteDraftFromDto(dto: SiteSettingsDto): SiteDraft {
  return { siteName: dto.siteName ?? '', siteUrl: dto.siteUrl ?? '' }
}

/** 与后端 `canonicalPublicOrigin` 同口径的前置校验；空值表示「稍后配置」。 */
export function validatePublicOrigin(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  if (trimmed.length > 500) return '站点地址过长。'
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return '站点地址必须是合法的 URL，例如 https://canvas.example.com。'
  }
  const host = url.hostname.toLowerCase()
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    return '站点地址必须使用 HTTPS（本地开发可用 localhost 的 HTTP）。'
  }
  if (url.username || url.password || url.search || url.hash) {
    return '站点地址不能包含认证信息、查询参数或锚点。'
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return '站点地址不能包含路径，只填协议与域名（可带端口）。'
  }
  return null
}

export function validateSiteDraft(draft: SiteDraft): Partial<Record<keyof SiteDraft, string>> {
  const errors: Partial<Record<keyof SiteDraft, string>> = {}
  const name = draft.siteName.trim()
  if (!name) errors.siteName = '请填写站点名称。'
  else if (name.length > 120) errors.siteName = '站点名称不能超过 120 个字符。'
  const urlError = validatePublicOrigin(draft.siteUrl)
  if (urlError) errors.siteUrl = urlError
  return errors
}

export function toSiteInput(draft: SiteDraft): SiteSettingsInput {
  return {
    siteName: draft.siteName.trim(),
    siteUrl: draft.siteUrl.trim() ? draft.siteUrl.trim().replace(/\/+$/, '') : null,
  }
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

export interface SmtpDraft {
  host: string
  port: string
  tlsMode: SmtpTlsMode
  username: string
  password: string
  /** 显式清除已保存的密码（发送 `password: null`）。 */
  clearPassword: boolean
  fromAddress: string
  fromName: string
}

export const SMTP_TLS_OPTIONS: ReadonlyArray<{ value: SmtpTlsMode; label: string }> = [
  { value: 'starttls', label: 'STARTTLS（默认，通常端口 587）' },
  { value: 'implicit_tls', label: '隐式 TLS（通常端口 465）' },
  { value: 'none', label: '不加密（仅限内网/测试）' },
]

export function smtpDraftFromDto(dto: SmtpSettingsDto): SmtpDraft {
  return {
    host: dto.host ?? '',
    port: dto.port === null ? '' : String(dto.port),
    tlsMode: dto.tlsMode,
    username: dto.username ?? '',
    password: '',
    clearPassword: false,
    fromAddress: dto.fromAddress ?? '',
    fromName: dto.fromName ?? '',
  }
}

export interface SmtpFieldErrors {
  host?: string
  port?: string
  fromAddress?: string
  password?: string
}

export function validateSmtpDraft(draft: SmtpDraft): SmtpFieldErrors {
  const errors: SmtpFieldErrors = {}
  if (!draft.host.trim()) errors.host = '请填写 SMTP 服务器地址。'
  const port = draft.port.trim() === '' ? NaN : Number(draft.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    errors.port = '端口必须是 1–65535 的整数。'
  }
  if (draft.fromAddress.trim() && !isPlausibleEmail(draft.fromAddress)) {
    errors.fromAddress = '发件人邮箱格式不正确。'
  }
  if (draft.clearPassword && draft.password.trim()) {
    errors.password = '已选择清除密码，请留空输入框。'
  }
  return errors
}

/** 留空密码 = 保持已保存的密码；只有显式勾选清除才发送 `null`。 */
export function toSmtpInput(draft: SmtpDraft): SmtpSettingsInput {
  const input: SmtpSettingsInput = {
    host: draft.host.trim() || null,
    port: draft.port.trim() ? Number(draft.port) : null,
    tlsMode: draft.tlsMode,
    username: draft.username.trim() || null,
    fromAddress: draft.fromAddress.trim() || null,
    fromName: draft.fromName.trim() || null,
  }
  if (draft.clearPassword) input.password = null
  else if (draft.password.trim()) input.password = draft.password
  return input
}

// ---------------------------------------------------------------------------
// 对象存储
// ---------------------------------------------------------------------------

export interface StorageDraft {
  driver: StorageDriverKind
  localRoot: string
  endpoint: string
  publicEndpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  signedUrlTtlSeconds: string
}

export const STORAGE_DRIVER_OPTIONS: ReadonlyArray<{ value: StorageDriverKind; label: string; hint: string }> = [
  { value: 's3', label: 'S3 兼容存储', hint: 'MinIO、AWS S3、Cloudflare R2 等' },
  { value: 'local', label: '本地磁盘', hint: '文件保存在 API 与 Worker 共同挂载的目录' },
]

export function storageDraftFromDto(dto: StorageSettingsDto): StorageDraft {
  return {
    driver: dto.driver,
    localRoot: dto.localRoot ?? '',
    endpoint: dto.endpoint ?? '',
    publicEndpoint: dto.publicEndpoint ?? '',
    region: dto.region ?? 'us-east-1',
    bucket: dto.bucket ?? '',
    accessKeyId: dto.accessKeyId ?? '',
    secretAccessKey: '',
    signedUrlTtlSeconds: String(dto.signedUrlTtlSeconds),
  }
}

export interface StorageFieldErrors {
  localRoot?: string
  endpoint?: string
  publicEndpoint?: string
  region?: string
  bucket?: string
  accessKeyId?: string
  secretAccessKey?: string
  signedUrlTtlSeconds?: string
}

function isAbsoluteLocalRoot(value: string): boolean {
  if (!value || value.length > 512) return false
  if (!/^(\/|[A-Za-z]:[\\/])/.test(value)) return false
  if (/[\u0000-\u001f]/.test(value)) return false
  return !value.split(/[\\/]/).some((segment) => segment === '..')
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function validateStorageDraft(
  draft: StorageDraft,
  options: { hasStoredSecret: boolean },
): StorageFieldErrors {
  const errors: StorageFieldErrors = {}
  const ttl = draft.signedUrlTtlSeconds.trim() === '' ? NaN : Number(draft.signedUrlTtlSeconds)
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 3600) {
    errors.signedUrlTtlSeconds = '签名链接有效期必须是 60–3600 秒的整数。'
  }

  if (draft.driver === 'local') {
    if (!draft.localRoot.trim()) errors.localRoot = '请填写本地存储目录。'
    else if (!isAbsoluteLocalRoot(draft.localRoot.trim())) {
      errors.localRoot = '必须是绝对路径（以 / 或盘符开头），且不能包含 ".." 段。'
    }
    return errors
  }

  if (!draft.endpoint.trim()) errors.endpoint = '请填写对象存储服务端点。'
  else if (!isHttpUrl(draft.endpoint.trim())) errors.endpoint = '端点必须是合法的 HTTP(S) URL。'
  if (draft.publicEndpoint.trim() && !isHttpUrl(draft.publicEndpoint.trim())) {
    errors.publicEndpoint = '公网端点必须是合法的 HTTP(S) URL；不需要时留空。'
  }
  if (!/^[a-z0-9-]{1,32}$/.test(draft.region.trim())) {
    errors.region = '区域只能包含小写字母、数字与短横线（1–32 个字符）。'
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(draft.bucket.trim())) {
    errors.bucket = '桶名只能包含小写字母、数字、点与短横线（3–63 个字符）。'
  }
  if (!draft.accessKeyId.trim()) errors.accessKeyId = '请填写访问密钥 ID。'
  if (!draft.secretAccessKey.trim() && !options.hasStoredSecret) {
    errors.secretAccessKey = '请填写访问密钥。'
  }
  return errors
}

/**
 * 只发送当前驱动需要的字段：切换驱动时不把另一驱动的配置清空（服务端会保留
 * 未提供的列），继续使用已保存的密钥时也不发送空密钥。
 */
export function toStorageInput(draft: StorageDraft, options: { hasStoredSecret: boolean }): StorageSettingsInput {
  const input: StorageSettingsInput = {
    driver: draft.driver,
    signedUrlTtlSeconds: draft.signedUrlTtlSeconds.trim() ? Number(draft.signedUrlTtlSeconds) : null,
  }
  if (draft.driver === 'local') {
    input.localRoot = draft.localRoot.trim()
    return input
  }
  input.endpoint = draft.endpoint.trim() || null
  input.publicEndpoint = draft.publicEndpoint.trim() || null
  input.region = draft.region.trim() || null
  input.bucket = draft.bucket.trim() || null
  input.accessKeyId = draft.accessKeyId.trim() || null
  if (draft.secretAccessKey.trim()) input.secretAccessKey = draft.secretAccessKey
  else if (!options.hasStoredSecret) input.secretAccessKey = null
  return input
}

/** 状态 → 徽标文案。 */
export function connectionStatusLabel(
  status: 'not_configured' | 'configured' | 'verified' | 'error',
): string {
  switch (status) {
    case 'verified':
      return '已验证'
    case 'configured':
      return '已保存，未验证'
    case 'not_configured':
      return '未配置'
    case 'error':
      return '配置异常'
  }
}

/** 连接摘要里的主机 / 用户做半遮罩；密码从不出现在任何读取响应里。 */
export function maskConnectionValue(value: string | null | undefined): string {
  if (!value) return '未提供'
  if (value.length <= 4) return `${value.slice(0, 1)}•••`
  return `${value.slice(0, 2)}•••${value.slice(-2)}`
}

// ---------------------------------------------------------------------------
// 运行时限制
// ---------------------------------------------------------------------------

export type RuntimeKey = keyof RuntimeSettingsInput

export interface RuntimeFieldSpec {
  key: RuntimeKey
  label: string
  unit: string
  min: number
  max: number
  hint: string
}

/** 与 `apps/api/src/modules/setup/validation.ts` 的 RUNTIME_RANGES 对齐。 */
export const RUNTIME_FIELD_SPECS: readonly RuntimeFieldSpec[] = [
  { key: 'uploadTtlSeconds', label: '上传凭证有效期', unit: '秒', min: 300, max: 604800, hint: '默认 86400 秒（24 小时）。' },
  { key: 'signedUrlTtlSeconds', label: '签名链接有效期', unit: '秒', min: 60, max: 3600, hint: '默认 900 秒；媒体 URL 过期后重新读取即可。' },
  { key: 'maxImageBytes', label: '单张图片大小上限', unit: '字节', min: 1, max: 100000000, hint: '默认 10,000,000 字节（约 10 MB）。' },
  { key: 'maxTotalBytes', label: '参考图总大小上限', unit: '字节', min: 1, max: 200000000, hint: '默认 20,000,000 字节；不能小于单图上限。' },
  { key: 'maxInputs', label: '参考图数量上限', unit: '张', min: 1, max: 32, hint: '默认 4 张。' },
  { key: 'providerTimeoutMs', label: '供应商请求超时', unit: '毫秒', min: 1, max: 3600000, hint: '默认 300000 毫秒（5 分钟）。' },
  { key: 'maxOutputBytes', label: '单产物大小上限', unit: '字节', min: 1, max: 100000000, hint: '默认 100,000,000 字节。' },
  { key: 'jobLeaseMs', label: '任务租约时长', unit: '毫秒', min: 1, max: 3600000, hint: '默认 600000 毫秒（10 分钟）。' },
]

export type RuntimeDraft = Record<RuntimeKey, string>

export function runtimeDraftFromDto(dto: RuntimeSettingsDto): RuntimeDraft {
  const draft = {} as RuntimeDraft
  for (const spec of RUNTIME_FIELD_SPECS) draft[spec.key] = String(dto[spec.key])
  return draft
}

export type RuntimeFieldErrors = Partial<Record<RuntimeKey, string>>

export function validateRuntimeDraft(draft: RuntimeDraft): RuntimeFieldErrors {
  const errors: RuntimeFieldErrors = {}
  const parsed: Partial<Record<RuntimeKey, number>> = {}
  for (const spec of RUNTIME_FIELD_SPECS) {
    const raw = draft[spec.key].trim()
    const value = raw === '' ? NaN : Number(raw)
    if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
      errors[spec.key] = `必须是 ${spec.min.toLocaleString('en-US')}–${spec.max.toLocaleString('en-US')} 之间的整数。`
      continue
    }
    parsed[spec.key] = value
  }
  const maxImage = parsed.maxImageBytes
  const maxTotal = parsed.maxTotalBytes
  if (typeof maxImage === 'number' && typeof maxTotal === 'number' && maxTotal < maxImage) {
    errors.maxTotalBytes = '总大小上限不能小于单图大小上限。'
  }
  return errors
}

export function toRuntimeInput(draft: RuntimeDraft): RuntimeSettingsInput {
  const input: RuntimeSettingsInput = {}
  for (const spec of RUNTIME_FIELD_SPECS) {
    const raw = draft[spec.key].trim()
    input[spec.key] = raw === '' ? null : Number(raw)
  }
  return input
}

// ---------------------------------------------------------------------------
// 提示词模板导入
// ---------------------------------------------------------------------------

export interface TemplateImportEntry {
  name: string
  description?: string
  instruction: string
}

export type TemplateImportParseResult = { ok: true; entries: TemplateImportEntry[] } | { ok: false; error: string }

/**
 * 解析用户粘贴 / 上传的模板 JSON：支持裸数组或 `{ templates: [...] }` / `{ entries: [...] }`。
 * 服务端要求每条都有 name 与 instruction；模板变量白名单由服务端最终校验。
 */
export function parseTemplateImportText(text: string): TemplateImportParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: '请粘贴模板 JSON，或直接跳过此步。' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: 'JSON 解析失败，请检查是否缺少引号、逗号或括号。' }
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? ((parsed as { templates?: unknown }).templates ?? (parsed as { entries?: unknown }).entries)
      : null
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'JSON 必须是模板数组，或包含 templates / entries 数组的对象。' }
  }
  if (raw.length === 0 || raw.length > 100) {
    return { ok: false, error: '模板数量必须在 1 到 100 之间。' }
  }
  const entries: TemplateImportEntry[] = []
  const names = new Set<string>()
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `第 ${index + 1} 条模板格式不正确。` }
    }
    const record = item as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!name) return { ok: false, error: `第 ${index + 1} 条模板缺少 name。` }
    if (name.length > 120) return { ok: false, error: `第 ${index + 1} 条模板的 name 超过 120 个字符。` }
    if (names.has(name)) return { ok: false, error: `模板名称重复：${name}。` }
    names.add(name)
    const instruction = typeof record.instruction === 'string'
      ? record.instruction
      : typeof record.content === 'string'
        ? record.content
        : ''
    if (!instruction.trim()) return { ok: false, error: `第 ${index + 1} 条模板缺少 instruction。` }
    const description = typeof record.description === 'string' ? record.description.trim() : ''
    entries.push({
      name,
      ...(description ? { description } : {}),
      instruction,
    })
  }
  return { ok: true, entries }
}

/** `clientApi.setup.importPromptTemplates` 的入参类型别名，避免组件重复声明。 */
export type TemplateImportItems = ImportPromptTemplateItem[]
