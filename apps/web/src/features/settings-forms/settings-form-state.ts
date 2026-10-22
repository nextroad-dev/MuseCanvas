// Pure draft <-> payload helpers shared by the admin settings page and the setup wizard.
// Only type imports here: this module must stay loadable by `node --experimental-strip-types`.
import type {
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
export type RuntimeKey = keyof RuntimeSettingsInput
export type RuntimeValues = Record<RuntimeKey, number>
export type RuntimeDraft = Record<RuntimeKey, string>

/** Undefined fields mean keep the stored value; write-only nonempty secrets count as changes. */
function payloadChanged(input: object, baseline: object): boolean {
  const stored = baseline as Record<string, unknown>
  return Object.entries(input).some(([key, value]) => value !== undefined && value !== stored[key])
}

// Empty inputs are omitted so the server keeps the stored value instead of clearing it.
export function keepIfEmpty(raw: string): string | undefined {
  return raw.trim() === '' ? undefined : raw.trim()
}

export function keepIfEmptyNumber(raw: string): number | undefined {
  return raw.trim() === '' ? undefined : Number(raw)
}

// ---------------------------------------------------------------- site

export interface SiteDraft {
  siteName: string
  siteUrl: string
}

export function siteDraftFromDto(settings: Pick<SiteSettingsDto, 'siteName' | 'siteUrl'>): SiteDraft {
  return { siteName: settings.siteName ?? '', siteUrl: settings.siteUrl ?? '' }
}

export function siteDraftChanged(draft: SiteDraft, baseline: Pick<SiteSettingsDto, 'siteName' | 'siteUrl'>): boolean {
  return draft.siteName.trim() !== (baseline.siteName ?? '') || (draft.siteUrl.trim() || null) !== (baseline.siteUrl ?? null)
}

export function toSiteInput(draft: SiteDraft): SiteSettingsInput {
  return {
    siteName: draft.siteName.trim(),
    siteUrl: draft.siteUrl.trim() || null,
  }
}

// ---------------------------------------------------------------- smtp

export interface SmtpDraft {
  host: string
  port: string
  tlsMode: SmtpTlsMode
  username: string
  /** Write-only. Starts empty on every load; an empty value keeps the stored secret. */
  password: string
  fromAddress: string
  fromName: string
}

export function smtpDraftFromDto(settings: SmtpSettingsDto): SmtpDraft {
  return {
    host: settings.host ?? '',
    port: settings.port === null ? '' : String(settings.port ?? ''),
    tlsMode: settings.tlsMode,
    username: settings.username ?? '',
    password: '',
    fromAddress: settings.fromAddress ?? '',
    fromName: settings.fromName ?? '',
  }
}

/** Undefined fields mean keep the stored value; an untouched password is never sent. */
export function toSmtpInput(draft: SmtpDraft, baseline: Pick<SmtpSettingsDto, 'tlsMode'>): SmtpSettingsInput {
  return {
    host: keepIfEmpty(draft.host),
    port: keepIfEmptyNumber(draft.port),
    tlsMode: draft.tlsMode === baseline.tlsMode ? undefined : draft.tlsMode,
    username: keepIfEmpty(draft.username),
    password: draft.password.trim() || undefined,
    fromAddress: keepIfEmpty(draft.fromAddress),
    fromName: keepIfEmpty(draft.fromName),
  }
}

export function smtpDraftChanged(draft: SmtpDraft, baseline: SmtpSettingsDto): boolean {
  return payloadChanged(toSmtpInput(draft, baseline), baseline)
}

// ---------------------------------------------------------------- storage

export interface StorageDraft {
  driver: StorageDriverKind
  localRoot: string
  endpoint: string
  publicEndpoint: string
  region: string
  bucket: string
  accessKeyId: string
  /** Write-only. Starts empty on every load; an empty value keeps the stored secret. */
  secretAccessKey: string
  signedUrlTtlSeconds: string
}

export function storageDraftFromDto(settings: StorageSettingsDto): StorageDraft {
  return {
    driver: settings.driver ?? 's3',
    localRoot: settings.localRoot ?? '',
    endpoint: settings.endpoint ?? '',
    publicEndpoint: settings.publicEndpoint ?? '',
    region: settings.region ?? '',
    bucket: settings.bucket ?? '',
    accessKeyId: settings.accessKeyId ?? '',
    secretAccessKey: '',
    signedUrlTtlSeconds: String(settings.signedUrlTtlSeconds),
  }
}

/**
 * The driver is only sent when it differs from the stored one, so a payload that
 * does not touch the switch is byte-identical to the pre-driver contract. Save and
 * test share this shape: a test without `driver` exercises the stored driver, which
 * is the draft driver whenever the switch is untouched.
 */
export function toStorageInput(draft: StorageDraft, baseline: Pick<StorageSettingsDto, 'driver'>): StorageSettingsInput {
  return {
    driver: draft.driver === baseline.driver ? undefined : draft.driver,
    localRoot: keepIfEmpty(draft.localRoot),
    endpoint: keepIfEmpty(draft.endpoint),
    publicEndpoint: keepIfEmpty(draft.publicEndpoint),
    region: keepIfEmpty(draft.region),
    bucket: keepIfEmpty(draft.bucket),
    accessKeyId: keepIfEmpty(draft.accessKeyId),
    secretAccessKey: draft.secretAccessKey.trim() || undefined,
    signedUrlTtlSeconds: keepIfEmptyNumber(draft.signedUrlTtlSeconds),
  }
}

export function storageDraftChanged(draft: StorageDraft, baseline: StorageSettingsDto): boolean {
  return payloadChanged(toStorageInput(draft, baseline), baseline)
}

/** Client-side shape check only; the server stays authoritative. Accepts POSIX and Windows absolute paths. */
export function isAbsoluteLocalPath(raw: string): boolean {
  const value = raw.trim()
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

// ---------------------------------------------------------------- runtime

export const RUNTIME_FIELD_KEYS: readonly RuntimeKey[] = [
  'uploadTtlSeconds',
  'signedUrlTtlSeconds',
  'maxImageBytes',
  'maxTotalBytes',
  'maxInputs',
  'providerTimeoutMs',
  'maxOutputBytes',
  'jobLeaseMs',
]

export function runtimeDraftFromValues(values: RuntimeValues): RuntimeDraft {
  const draft = {} as RuntimeDraft
  for (const key of RUNTIME_FIELD_KEYS) draft[key] = String(values[key])
  return draft
}

/** Blank inputs fall back to the stored value. Every field is always resolved. */
export function resolveRuntimeValues(draft: RuntimeDraft, baseline: RuntimeValues): RuntimeValues {
  const values = {} as RuntimeValues
  for (const key of RUNTIME_FIELD_KEYS) {
    const raw = draft[key].trim()
    values[key] = raw === '' ? baseline[key] : Number(raw)
  }
  return values
}

export function runtimeDraftChanged(draft: RuntimeDraft, baseline: RuntimeValues): boolean {
  return payloadChanged(resolveRuntimeValues(draft, baseline), baseline)
}

/** The same cross-check the server runs, so the mismatch is shown on the field that caused it. */
export function runtimeTotalBelowImage(values: Pick<RuntimeValues, 'maxTotalBytes' | 'maxImageBytes'>): boolean {
  return values.maxTotalBytes < values.maxImageBytes
}

export const runtimeFieldDefs: Array<{
  key: RuntimeKey
  label: string
  min: number
  max: number
}> = [
  { key: 'uploadTtlSeconds', label: '上传暂存有效期（秒）', min: 300, max: 604800 },
  { key: 'signedUrlTtlSeconds', label: '签名 URL 有效期（秒）', min: 60, max: 3600 },
  { key: 'maxImageBytes', label: '单图大小上限（字节）', min: 1, max: 100000000 },
  { key: 'maxTotalBytes', label: '单次上传总大小上限（字节）', min: 1, max: 200000000 },
  { key: 'maxInputs', label: '单次生成参考图上限（张）', min: 1, max: 32 },
  { key: 'providerTimeoutMs', label: '上游请求超时（毫秒）', min: 1, max: 3600000 },
  { key: 'maxOutputBytes', label: '生成结果大小上限（字节）', min: 1, max: 100000000 },
  { key: 'jobLeaseMs', label: '任务租约时长（毫秒）', min: 1, max: 3600000 },
]

// ---------------------------------------------------------------- validation (client-side, server stays authoritative)

export type FieldErrors<K extends string> = Partial<Record<K, string>>

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Client-side plausibility only; the server validates and delivers. */
export function isPlausibleEmail(raw: string): boolean {
  return EMAIL_PATTERN.test(raw.trim())
}

export function validateSiteDraft(draft: SiteDraft): FieldErrors<keyof SiteDraft> {
  const errors: FieldErrors<keyof SiteDraft> = {}
  const name = draft.siteName.trim()
  if (!name) errors.siteName = '请输入站点名称。'
  else if (name.length > 120) errors.siteName = '站点名称最长 120 字符。'
  const url = draft.siteUrl.trim()
  if (url) {
    let parsed: URL | null = null
    try {
      parsed = new URL(url)
    } catch {
      parsed = null
    }
    const secure = parsed?.protocol === 'https:' || (parsed?.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname))
    const rootOnly = parsed !== null && (parsed.pathname === '/' || parsed.pathname === '') && !parsed.search && !parsed.hash && !parsed.username && !parsed.password
    if (!parsed || !secure || !rootOnly) errors.siteUrl = '请输入 HTTPS 根地址，例如 https://musecanvas.example.com（不带路径或查询参数）。'
  }
  return errors
}

export function validateSmtpDraft(draft: SmtpDraft, baseline: Pick<SmtpSettingsDto, 'host'>): FieldErrors<keyof SmtpDraft> {
  const errors: FieldErrors<keyof SmtpDraft> = {}
  if (!draft.host.trim() && !baseline.host) errors.host = '请输入发信服务器地址。'
  const port = draft.port.trim()
  if (port && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) {
    errors.port = '端口须为 1–65535 之间的整数。'
  }
  const from = draft.fromAddress.trim()
  if (from && !isPlausibleEmail(from)) errors.fromAddress = '发件地址格式不正确。'
  return errors
}

export function validateStorageDraft(draft: StorageDraft, baseline: Pick<StorageSettingsDto, 'localRoot' | 'bucket'>): FieldErrors<keyof StorageDraft> {
  const errors: FieldErrors<keyof StorageDraft> = {}
  if (draft.driver === 'local') {
    const root = draft.localRoot.trim()
    if (!root && !baseline.localRoot) errors.localRoot = '请输入本地目录的绝对路径。'
    else if (root && !isAbsoluteLocalPath(root)) errors.localRoot = '必须是绝对路径，例如 /data/musecanvas/assets。'
    return errors
  }
  const endpoint = draft.endpoint.trim()
  if (endpoint && !/^https?:\/\//i.test(endpoint)) errors.endpoint = '必须以 http:// 或 https:// 开头。'
  if (!draft.bucket.trim() && !baseline.bucket) errors.bucket = '请输入存储桶名称。'
  const ttl = draft.signedUrlTtlSeconds.trim()
  if (ttl && (!Number.isInteger(Number(ttl)) || Number(ttl) < 60 || Number(ttl) > 3600)) {
    errors.signedUrlTtlSeconds = '签名 URL 有效期须为 60–3600 秒之间的整数。'
  }
  return errors
}

export function validateRuntimeDraft(draft: RuntimeDraft, baseline: RuntimeValues): FieldErrors<RuntimeKey> {
  const errors: FieldErrors<RuntimeKey> = {}
  for (const { key, min, max } of runtimeFieldDefs) {
    const raw = draft[key].trim()
    if (raw === '') continue
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min || value > max) errors[key] = `请输入 ${min}–${max} 之间的整数。`
  }
  if (!errors.maxTotalBytes && runtimeTotalBelowImage(resolveRuntimeValues(draft, baseline))) {
    errors.maxTotalBytes = '总大小上限不能小于单图大小上限。'
  }
  return errors
}
