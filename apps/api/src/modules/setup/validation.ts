import { emailValid } from '../../shared/http'
import { PROMPT_TEMPLATE_VAR_LOOKUP } from '@musecanvas/contracts'

// Pure validators for the persisted onboarding endpoints. Every function is
// synchronous and side-effect free: callers map failures to fail() responses
// and only persist after successful connection tests.

export interface InputError {
  code: string
  message: string
}

export const INVALID_INPUT = (message: string): InputError => ({ code: 'INVALID_INPUT', message })

export function rejectUnknownFields(input: Record<string, unknown>, allowed: ReadonlySet<string>): InputError | null {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return INVALID_INPUT('请求包含不允许的字段')
  }
  return null
}

function optionalText(value: unknown, maxLength: number): string | null | undefined | InputError {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return INVALID_INPUT('请求参数类型无效')
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > maxLength) return INVALID_INPUT('请求参数长度超出限制')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) return INVALID_INPUT('请求参数包含非法字符')
  return trimmed
}

function requiredText(value: unknown, maxLength: number, message: string): string | InputError {
  const parsed = optionalText(value, maxLength)
  if (parsed instanceof Object && 'code' in parsed) return parsed
  if (parsed === undefined || parsed === null) return INVALID_INPUT(message)
  return parsed
}

function optionalInt(
  value: unknown,
  min: number,
  max: number,
): number | null | undefined | InputError {
  if (value === undefined) return undefined
  if (value === null) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return INVALID_INPUT('数值参数超出允许范围')
  return parsed
}

// Canonical public origin: scheme + host (+ port) only, no trailing slash.
export function canonicalPublicOrigin(raw: unknown): string | InputError {
  if (typeof raw !== 'string' || !raw.trim()) return INVALID_INPUT('站点地址不能为空')
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed.length > 500) return INVALID_INPUT('站点地址过长')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { code: 'PUBLIC_ORIGIN_INVALID', message: '站点地址必须是合法的 URL' }
  }
  const insecureOk = process.env.ALLOW_INSECURE_PUBLIC_ORIGIN === 'true'
  const host = url.hostname.toLowerCase()
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (isLocal || insecureOk))) {
    return { code: 'PUBLIC_ORIGIN_INVALID', message: '站点地址必须使用 HTTPS' }
  }
  if (url.username || url.password || url.search || url.hash) {
    return { code: 'PUBLIC_ORIGIN_INVALID', message: '站点地址不能包含认证信息或查询参数' }
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { code: 'PUBLIC_ORIGIN_INVALID', message: '站点地址不能包含路径' }
  }
  return url.origin
}

const SITE_FIELDS = new Set(['siteName', 'siteUrl'])

export interface ValidSiteInput {
  siteName: string
  siteUrl: string | null
}

export function validateSiteInput(input: Record<string, unknown>): ValidSiteInput | InputError {
  const unknown = rejectUnknownFields(input, SITE_FIELDS)
  if (unknown) return unknown
  const siteName = requiredText(input.siteName, 120, '站点名称不能为空')
  if (typeof siteName !== 'string') return siteName
  if (input.siteUrl === undefined || input.siteUrl === null || input.siteUrl === '') {
    return { siteName, siteUrl: null }
  }
  const siteUrl = canonicalPublicOrigin(input.siteUrl)
  if (typeof siteUrl !== 'string') return siteUrl
  return { siteName, siteUrl }
}

const SMTP_FIELDS = new Set(['host', 'port', 'tlsMode', 'username', 'password', 'fromAddress', 'fromName'])

export type SmtpPasswordAction = { kind: 'keep' } | { kind: 'clear' } | { kind: 'set'; password: string }

export interface ValidSmtpInput {
  host: string | null | undefined
  port: number | null | undefined
  tlsMode: 'none' | 'starttls' | 'implicit_tls' | undefined
  username: string | null | undefined
  password: SmtpPasswordAction
  fromAddress: string | null | undefined
  fromName: string | null | undefined
}

export function validateSmtpInput(input: Record<string, unknown>): ValidSmtpInput | InputError {
  const unknown = rejectUnknownFields(input, SMTP_FIELDS)
  if (unknown) return unknown
  const host = optionalText(input.host, 253)
  if (host instanceof Object && 'code' in host) return host
  const port = optionalInt(input.port, 1, 65535)
  if (port instanceof Object && 'code' in port) return port
  let tlsMode: ValidSmtpInput['tlsMode'] = undefined
  if (input.tlsMode !== undefined) {
    if (input.tlsMode !== 'none' && input.tlsMode !== 'starttls' && input.tlsMode !== 'implicit_tls') {
      return INVALID_INPUT('TLS 模式无效')
    }
    tlsMode = input.tlsMode
  }
  const username = optionalText(input.username, 254)
  if (username instanceof Object && 'code' in username) return username
  let password: SmtpPasswordAction = { kind: 'keep' }
  if (input.password !== undefined) {
    if (input.password === null || input.password === '') {
      password = { kind: 'clear' }
    } else if (typeof input.password !== 'string' || input.password.length > 2000) {
      return INVALID_INPUT('SMTP 密码无效')
    } else {
      password = { kind: 'set', password: input.password }
    }
  }
  const fromAddress = optionalText(input.fromAddress, 254)
  if (fromAddress instanceof Object && 'code' in fromAddress) return fromAddress
  if (fromAddress && !emailValid(fromAddress)) return INVALID_INPUT('发件人邮箱格式不正确')
  const fromName = optionalText(input.fromName, 120)
  if (fromName instanceof Object && 'code' in fromName) return fromName
  if (
    tlsMode === 'none'
    && process.env.NODE_ENV === 'production'
    && process.env.ALLOW_INSECURE_SMTP !== 'true'
  ) {
    return INVALID_INPUT('生产环境必须启用 SMTP 加密')
  }
  return { host, port, tlsMode, username, password, fromAddress, fromName }
}

function validHttpUrl(raw: string, field: string): string | InputError {
  if (raw.length > 500) return INVALID_INPUT(`${field}过长`)
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return INVALID_INPUT(`${field}必须是合法的 URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return INVALID_INPUT(`${field}必须使用 HTTP(S)`)
  if (url.username || url.password || url.search || url.hash) return INVALID_INPUT(`${field}不能包含认证信息或查询参数`)
  return url.toString().replace(/\/+$/, '')
}

const STORAGE_FIELDS = new Set([
  'endpoint',
  'publicEndpoint',
  'region',
  'bucket',
  'accessKeyId',
  'secretAccessKey',
  'signedUrlTtlSeconds',
])

export type StorageSecretAction = { kind: 'keep' } | { kind: 'clear' } | { kind: 'set'; secret: string }

export interface ValidStorageInput {
  endpoint: string | null | undefined
  publicEndpoint: string | null | undefined
  region: string | null | undefined
  bucket: string | null | undefined
  accessKeyId: string | null | undefined
  secret: StorageSecretAction
  signedUrlTtlSeconds: number | null | undefined
}

export function validateStorageInput(input: Record<string, unknown>): ValidStorageInput | InputError {
  const unknown = rejectUnknownFields(input, STORAGE_FIELDS)
  if (unknown) return unknown
  let endpoint: string | null | undefined
  if (input.endpoint !== undefined) {
    if (input.endpoint === null || input.endpoint === '') {
      endpoint = null
    } else if (typeof input.endpoint !== 'string') {
      return INVALID_INPUT('对象存储服务端点无效')
    } else {
      const parsed = validHttpUrl(input.endpoint, '对象存储服务端点')
      if (typeof parsed !== 'string') return parsed
      endpoint = parsed
    }
  }
  let publicEndpoint: string | null | undefined
  if (input.publicEndpoint !== undefined) {
    if (input.publicEndpoint === null || input.publicEndpoint === '') {
      publicEndpoint = null
    } else if (typeof input.publicEndpoint !== 'string') {
      return INVALID_INPUT('对象存储公网端点无效')
    } else {
      const parsed = validHttpUrl(input.publicEndpoint, '对象存储公网端点')
      if (typeof parsed !== 'string') return parsed
      publicEndpoint = parsed
    }
  }
  let region: string | null | undefined = undefined
  if (input.region !== undefined) {
    if (input.region === null || input.region === '') {
      region = null
    } else if (typeof input.region !== 'string' || !/^[a-z0-9-]{1,32}$/.test(input.region.trim())) {
      return INVALID_INPUT('存储区域无效')
    } else {
      region = input.region.trim()
    }
  }
  let bucket: string | null | undefined = undefined
  if (input.bucket !== undefined) {
    if (input.bucket === null || input.bucket === '') {
      bucket = null
    } else if (typeof input.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket.trim())) {
      return INVALID_INPUT('存储桶名称无效')
    } else {
      bucket = input.bucket.trim()
    }
  }
  const accessKeyId = optionalText(input.accessKeyId, 256)
  if (accessKeyId instanceof Object && 'code' in accessKeyId) return accessKeyId
  let secret: StorageSecretAction = { kind: 'keep' }
  if (input.secretAccessKey !== undefined) {
    if (input.secretAccessKey === null || input.secretAccessKey === '') {
      secret = { kind: 'clear' }
    } else if (typeof input.secretAccessKey !== 'string' || input.secretAccessKey.length > 2000) {
      return INVALID_INPUT('对象存储密钥无效')
    } else {
      secret = { kind: 'set', secret: input.secretAccessKey }
    }
  }
  const signedUrlTtlSeconds = optionalInt(input.signedUrlTtlSeconds, 60, 3600)
  if (signedUrlTtlSeconds instanceof Object && 'code' in signedUrlTtlSeconds) return signedUrlTtlSeconds
  return { endpoint, publicEndpoint, region, bucket, accessKeyId, secret, signedUrlTtlSeconds }
}

const RUNTIME_FIELDS = new Set([
  'uploadTtlSeconds',
  'signedUrlTtlSeconds',
  'maxImageBytes',
  'maxTotalBytes',
  'maxInputs',
  'providerTimeoutMs',
  'maxOutputBytes',
  'jobLeaseMs',
])

export interface ValidRuntimeInput {
  uploadTtlSeconds?: number | null
  signedUrlTtlSeconds?: number | null
  maxImageBytes?: number | null
  maxTotalBytes?: number | null
  maxInputs?: number | null
  providerTimeoutMs?: number | null
  maxOutputBytes?: number | null
  jobLeaseMs?: number | null
}

const RUNTIME_RANGES: Record<keyof ValidRuntimeInput, [number, number]> = {
  uploadTtlSeconds: [300, 604800],
  signedUrlTtlSeconds: [60, 3600],
  maxImageBytes: [1, 100_000_000],
  maxTotalBytes: [1, 200_000_000],
  maxInputs: [1, 32],
  providerTimeoutMs: [1, 3_600_000],
  maxOutputBytes: [1, 100_000_000],
  jobLeaseMs: [1, 3_600_000],
}

export function validateRuntimeInput(input: Record<string, unknown>): ValidRuntimeInput | InputError {
  const unknown = rejectUnknownFields(input, RUNTIME_FIELDS)
  if (unknown) return unknown
  const output: ValidRuntimeInput = {}
  let present = 0
  for (const key of RUNTIME_FIELDS) {
    const value = input[key]
    if (value === undefined) continue
    present += 1
    if (value === null) {
      output[key as keyof ValidRuntimeInput] = null
      continue
    }
    const [min, max] = RUNTIME_RANGES[key as keyof ValidRuntimeInput]
    const parsed = optionalInt(value, min, max)
    if (parsed instanceof Object && 'code' in parsed) return parsed
    output[key as keyof ValidRuntimeInput] = parsed as number
  }
  if (present === 0) return INVALID_INPUT('运行时设置不能为空')
  const maxImage = output.maxImageBytes ?? undefined
  const maxTotal = output.maxTotalBytes ?? undefined
  if (typeof maxImage === 'number' && typeof maxTotal === 'number' && maxTotal < maxImage) {
    return INVALID_INPUT('总大小上限不能小于单图大小上限')
  }
  return output
}

export const TEMPLATE_ALLOWED_VARIABLES: Readonly<Record<string, true>> = PROMPT_TEMPLATE_VAR_LOOKUP

export const TEMPLATE_MAX_ENTRIES = 100
export const TEMPLATE_MAX_INSTRUCTION_BYTES = 128 * 1024

export interface ValidTemplateEntry {
  name: string
  description: string
  instruction: string
}

function templateVariablesValid(instruction: string): boolean {
  const variables = [...instruction.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1].trim())
  if (variables.some((variable) => TEMPLATE_ALLOWED_VARIABLES[variable] !== true)) return false
  return !/{{|}}/.test(instruction.replace(/{{\s*([^{}]+?)\s*}}/g, ''))
}

export function validateTemplateImport(input: unknown): ValidTemplateEntry[] | InputError {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return INVALID_INPUT('模板列表无效')
  // Boundary value: narrowed to a non-array object; fields are validated per use below.
  const record: Record<string, unknown> = input as Record<string, unknown>
  const raw = record.templates ?? record.entries
  if (!Array.isArray(raw)) return INVALID_INPUT('模板列表无效')
  if (raw.length === 0 || raw.length > TEMPLATE_MAX_ENTRIES) return INVALID_INPUT('模板数量必须在 1 到 100 之间')
  const names = new Set<string>()
  const entries: ValidTemplateEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return INVALID_INPUT('模板条目无效')
    const record = item as Record<string, unknown>
    const name = requiredText(record.name, 120, '模板名称不能为空')
    if (typeof name !== 'string') return name
    if (names.has(name)) return INVALID_INPUT('模板名称不能重复')
    names.add(name)
    const descriptionRaw = record.description
    if (descriptionRaw !== undefined && descriptionRaw !== null && typeof descriptionRaw !== 'string') {
      return INVALID_INPUT('模板描述无效')
    }
    const description = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : ''
    if (description.length > 1000) return INVALID_INPUT('模板描述过长')
    const instructionRaw = record.instruction ?? record.content
    if (typeof instructionRaw !== 'string' || !instructionRaw.trim()) return INVALID_INPUT('模板内容不能为空')
    if (Buffer.byteLength(instructionRaw, 'utf8') > TEMPLATE_MAX_INSTRUCTION_BYTES) {
      return INVALID_INPUT('模板内容超出 128KB 上限')
    }
    if (instructionRaw.indexOf(String.fromCharCode(0)) !== -1) return INVALID_INPUT('模板内容包含非法字符')
    if (!templateVariablesValid(instructionRaw)) return INVALID_INPUT('模板包含不支持的变量')
    entries.push({ name, description, instruction: instructionRaw })
  }
  return entries
}
