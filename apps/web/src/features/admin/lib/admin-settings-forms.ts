// 系统配置四个分区的表单校验与单位换算：与后端 setup 校验规则保持一致，
// 让错误在提交前落到具体字段，而不是只弹一个通用 toast。

import { RUNTIME_SETTINGS_DEFAULTS } from '@musecanvas/contracts'
import type { SmtpTlsMode, StorageDriverKind } from '@musecanvas/contracts'

export const MB = 1024 * 1024

export type SettingsFieldErrors = Record<string, string | undefined>

export function hasFieldErrors(errors: SettingsFieldErrors): boolean {
  return Object.values(errors).some(Boolean)
}

/** 空串视为未填写；返回 `undefined` 代表保持原值。 */
export function trimOrUndefined(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export function readInt(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function readNumber(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

export function bytesToMbText(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return ''
  const mb = bytes / MB
  return Number.isInteger(mb) ? String(mb) : String(Math.round(mb * 100) / 100)
}

export function mbTextToBytes(text: string): number | null {
  const mb = readNumber(text)
  if (mb === null) return null
  return Math.round(mb * MB)
}

export function msToSecondsText(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const seconds = ms / 1000
  return Number.isInteger(seconds) ? String(seconds) : String(Math.round(seconds * 100) / 100)
}

export function secondsTextToMs(text: string): number | null {
  const seconds = readNumber(text)
  if (seconds === null) return null
  return Math.round(seconds * 1000)
}

export function formatBytesHint(bytes: number): string {
  return `${(bytes / MB).toFixed(bytes % MB === 0 ? 0 : 1)} MB`
}

// ---------------------------------------------------------------------------
// 站点信息
// ---------------------------------------------------------------------------

export interface SiteFormValues {
  siteName: string
  siteUrl: string
}

export function validateSiteForm(values: SiteFormValues): SettingsFieldErrors {
  const errors: SettingsFieldErrors = {}
  const siteName = values.siteName.trim()
  if (!siteName) errors.siteName = '站点名称不能为空。'
  else if (siteName.length > 120) errors.siteName = '站点名称不能超过 120 个字符。'

  const siteUrl = values.siteUrl.trim()
  if (siteUrl !== '') {
    let url: URL | null = null
    try {
      url = new URL(siteUrl)
    } catch {
      errors.siteUrl = '站点地址必须是合法的 URL。'
    }
    if (url) {
      const host = url.hostname.toLowerCase()
      const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
        errors.siteUrl = '站点地址必须使用 HTTPS（本机 localhost 除外）。'
      } else if (url.username || url.password || url.search || url.hash) {
        errors.siteUrl = '站点地址不能包含认证信息、查询参数或锚点。'
      } else if (url.pathname !== '/' && url.pathname !== '') {
        errors.siteUrl = '站点地址不能包含路径，只填写协议 + 域名（可带端口）。'
      }
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

export const SMTP_TLS_OPTIONS: { value: SmtpTlsMode; label: string }[] = [
  { value: 'starttls', label: 'STARTTLS（587）' },
  { value: 'implicit_tls', label: '隐式 TLS（465）' },
  { value: 'none', label: '不加密（不推荐）' },
]

export interface SmtpFormValues {
  host: string
  port: string
  tlsMode: SmtpTlsMode
  username: string
  /** 空 = 保持已保存密钥；`clear` 由独立按钮显式触发。 */
  password: string
  fromAddress: string
  fromName: string
}

export function validateSmtpForm(values: SmtpFormValues): SettingsFieldErrors {
  const errors: SettingsFieldErrors = {}
  const host = values.host.trim()
  if (host.length > 253) errors.host = 'SMTP 服务器地址不能超过 253 个字符。'
  const port = readInt(values.port)
  if (values.port.trim() !== '' && (port === null || port < 1 || port > 65535)) {
    errors.port = '端口必须是 1 到 65535 之间的整数。'
  }
  if (host && values.port.trim() === '') errors.port = '填写 SMTP 服务器后必须同时填写端口。'
  if (values.username.trim().length > 254) errors.username = '用户名不能超过 254 个字符。'
  if (values.password.length > 2000) errors.password = '密码不能超过 2000 个字符。'
  const from = values.fromAddress.trim()
  if (from && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) errors.fromAddress = '发件人邮箱格式不正确。'
  if (values.fromName.trim().length > 120) errors.fromName = '发件人名称不能超过 120 个字符。'
  return errors
}

// ---------------------------------------------------------------------------
// 对象存储
// ---------------------------------------------------------------------------

export const STORAGE_DRIVER_OPTIONS: { value: StorageDriverKind; label: string }[] = [
  { value: 's3', label: 'S3 兼容对象存储' },
  { value: 'local', label: '本地磁盘目录' },
]

export interface StorageFormValues {
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

function validateHttpUrl(value: string, label: string): string | undefined {
  if (value.length > 500) return `${label}过长。`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `${label}必须是合法的 URL。`
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `${label}必须使用 HTTP(S)。`
  if (url.username || url.password || url.search || url.hash) return `${label}不能包含认证信息或查询参数。`
  return undefined
}

export function validateStorageForm(values: StorageFormValues): SettingsFieldErrors {
  const errors: SettingsFieldErrors = {}
  if (values.driver === 'local') {
    const root = values.localRoot.trim()
    if (!root) errors.localRoot = '本地存储必须填写存储目录。'
    else if (root.length > 512) errors.localRoot = '存储目录不能超过 512 个字符。'
    else if (root.includes('..')) errors.localRoot = '存储目录不能包含 ".."。'
    else if (!root.startsWith('/')) errors.localRoot = '存储目录必须是绝对路径（以 / 开头）。'
  } else {
    const endpoint = values.endpoint.trim()
    if (endpoint) {
      const error = validateHttpUrl(endpoint, '对象存储服务端点')
      if (error) errors.endpoint = error
    }
    const publicEndpoint = values.publicEndpoint.trim()
    if (publicEndpoint) {
      const error = validateHttpUrl(publicEndpoint, '对象存储公网端点')
      if (error) errors.publicEndpoint = error
    }
    const region = values.region.trim()
    if (region && !/^[a-z0-9-]{1,32}$/.test(region)) {
      errors.region = '存储区域只能包含小写字母、数字和连字符（1-32 位）。'
    }
    const bucket = values.bucket.trim()
    if (bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      errors.bucket = '存储桶名称不合法（3-63 位小写字母/数字/点/连字符，首尾不能是点或连字符）。'
    }
    if (values.accessKeyId.trim().length > 256) errors.accessKeyId = 'Access Key ID 不能超过 256 个字符。'
    if (values.secretAccessKey.length > 2000) errors.secretAccessKey = 'Secret Access Key 不能超过 2000 个字符。'
  }
  const ttl = readInt(values.signedUrlTtlSeconds)
  if (values.signedUrlTtlSeconds.trim() !== '' && (ttl === null || ttl < 60 || ttl > 3600)) {
    errors.signedUrlTtlSeconds = '签名有效期必须是 60 到 3600 秒之间的整数。'
  }
  return errors
}

// ---------------------------------------------------------------------------
// 运行时限制
// ---------------------------------------------------------------------------

export type RuntimeUnit = 'seconds' | 'milliseconds' | 'bytes' | 'count'

export interface RuntimeFieldMeta {
  key: keyof RuntimeInputDraft
  label: string
  unit: RuntimeUnit
  hint: string
  min: number
  max: number
}

export interface RuntimeInputDraft {
  uploadTtlSeconds: string
  signedUrlTtlSeconds: string
  maxImageBytes: string
  maxTotalBytes: string
  maxInputs: string
  providerTimeoutMs: string
  maxOutputBytes: string
  jobLeaseMs: string
}

export const RUNTIME_FIELD_META: RuntimeFieldMeta[] = [
  {
    key: 'uploadTtlSeconds',
    label: '直传凭证有效期',
    unit: 'seconds',
    hint: '300 秒 - 7 天',
    min: 300,
    max: 604_800,
  },
  {
    key: 'signedUrlTtlSeconds',
    label: '媒体签名 URL 有效期',
    unit: 'seconds',
    hint: '60 - 3600 秒',
    min: 60,
    max: 3600,
  },
  {
    key: 'maxImageBytes',
    label: '单张图片大小上限',
    unit: 'bytes',
    hint: '最大 100 MB',
    min: 1,
    max: 100_000_000,
  },
  {
    key: 'maxTotalBytes',
    label: '一次生成总大小上限',
    unit: 'bytes',
    hint: '最大 200 MB，且不能小于单张上限',
    min: 1,
    max: 200_000_000,
  },
  {
    key: 'maxInputs',
    label: '参考图张数上限',
    unit: 'count',
    hint: '1 - 32',
    min: 1,
    max: 32,
  },
  {
    key: 'providerTimeoutMs',
    label: '上游生成超时',
    unit: 'milliseconds',
    hint: '1 秒 - 1 小时',
    min: 1_000,
    max: 3_600_000,
  },
  {
    key: 'maxOutputBytes',
    label: '单个产物大小上限',
    unit: 'bytes',
    hint: '最大 100 MB',
    min: 1,
    max: 100_000_000,
  },
  {
    key: 'jobLeaseMs',
    label: '任务租约时长',
    unit: 'milliseconds',
    hint: '1 秒 - 1 小时',
    min: 1_000,
    max: 3_600_000,
  },
]

/** 表单初始值：DTO → 输入框文本（字节转 MB、毫秒转秒）。 */
export function runtimeDraftFromDto(dto: {
  uploadTtlSeconds: number
  signedUrlTtlSeconds: number
  maxImageBytes: number
  maxTotalBytes: number
  maxInputs: number
  providerTimeoutMs: number
  maxOutputBytes: number
  jobLeaseMs: number
}): RuntimeInputDraft {
  return {
    uploadTtlSeconds: String(dto.uploadTtlSeconds),
    signedUrlTtlSeconds: String(dto.signedUrlTtlSeconds),
    maxImageBytes: bytesToMbText(dto.maxImageBytes),
    maxTotalBytes: bytesToMbText(dto.maxTotalBytes),
    maxInputs: String(dto.maxInputs),
    providerTimeoutMs: msToSecondsText(dto.providerTimeoutMs),
    maxOutputBytes: bytesToMbText(dto.maxOutputBytes),
    jobLeaseMs: msToSecondsText(dto.jobLeaseMs),
  }
}

export function runtimeDraftDefaults(): RuntimeInputDraft {
  return runtimeDraftFromDto(RUNTIME_SETTINGS_DEFAULTS)
}

function draftNumber(meta: RuntimeFieldMeta, raw: string): number | null {
  switch (meta.unit) {
    case 'seconds':
    case 'count':
      return readInt(raw)
    case 'milliseconds':
      return secondsTextToMs(raw)
    case 'bytes':
      return mbTextToBytes(raw)
  }
}

/** 区间提示按输入框单位展示（秒 / MB / 张），而不是后端的毫秒/字节。 */
export function runtimeRangeLabel(meta: RuntimeFieldMeta): string {
  switch (meta.unit) {
    case 'seconds':
      return `${meta.min} - ${meta.max} 秒`
    case 'milliseconds':
      return `${meta.min / 1000} - ${meta.max / 1000} 秒`
    case 'bytes':
      return `${bytesToMbText(meta.min)} - ${bytesToMbText(meta.max)} MB`
    case 'count':
      return `${meta.min} - ${meta.max}`
  }
}

export function validateRuntimeForm(values: RuntimeInputDraft): SettingsFieldErrors {
  const errors: SettingsFieldErrors = {}
  const parsed: Partial<Record<keyof RuntimeInputDraft, number | null>> = {}
  for (const meta of RUNTIME_FIELD_META) {
    const raw = values[meta.key]
    if (raw.trim() === '') {
      errors[meta.key] = '该字段不能为空。'
      continue
    }
    const numeric = draftNumber(meta, raw)
    parsed[meta.key] = numeric
    if (numeric === null) {
      errors[meta.key] = '请输入有效数字。'
    } else if (numeric < meta.min || numeric > meta.max) {
      errors[meta.key] = `取值必须在 ${runtimeRangeLabel(meta)} 之间。`
    }
  }
  const maxImage = parsed.maxImageBytes
  const maxTotal = parsed.maxTotalBytes
  if (typeof maxImage === 'number' && typeof maxTotal === 'number' && maxTotal < maxImage) {
    errors.maxTotalBytes = '总大小上限不能小于单张图片上限。'
  }
  return errors
}

/** 草稿 → PATCH 请求体（一律换算回后端单位秒 / 毫秒 / 字节）。 */
export function runtimeDraftToInput(values: RuntimeInputDraft) {
  const input: Record<string, number> = {}
  for (const meta of RUNTIME_FIELD_META) {
    const numeric = draftNumber(meta, values[meta.key])
    if (numeric !== null) input[meta.key] = numeric
  }
  return input as {
    uploadTtlSeconds: number
    signedUrlTtlSeconds: number
    maxImageBytes: number
    maxTotalBytes: number
    maxInputs: number
    providerTimeoutMs: number
    maxOutputBytes: number
    jobLeaseMs: number
  }
}
