// 认证错误的展示层翻译：后端错误码（research/api-surface.md §1.3）→ 中文可执行文案。
// 本模块刻意不 import 任何运行时 module（不依赖 `@/` 别名），便于 node:test 直接导入。

/** `ApiError` 的结构子集；只读 code / status / message，不依赖类实例。 */
export interface AuthErrorLike {
  code?: string | null
  status?: number | null
  message?: string | null
}

const NETWORK_MESSAGE = '网络连接失败。请检查设备网络，或确认服务可用后重试。'

/** `INVALID_OTP` 在验证码步出现，也用于第三方回调后的兜底。 */
const INVALID_OTP_MESSAGE =
  '验证码错误或已过期。请输入邮件里最新的一条 6 位验证码，或返回上一步重新发送。'

/** 与页面直接相关的错误码：说清发生了什么 + 用户下一步做什么。 */
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  INVALID_INPUT: '邮箱地址或邀请码格式不正确，请检查后重试。',
  RATE_LIMITED: '请求过于频繁。请等待约 10 分钟后重试，或换一个网络环境。',
  ACCOUNT_UNAVAILABLE: '该账号已被停用，请联系站点管理员。',
  INVALID_INVITATION: '邀请码无效或已被使用，请确认后重新填写。',
  EMAIL_DELIVERY_FAILED: '验证码邮件发送失败，邮件服务可能暂不可用。请稍后重试或联系管理员。',
  INVALID_OTP: INVALID_OTP_MESSAGE,
  UNAUTHORIZED: '登录状态已失效，请重新登录。',
  FORBIDDEN: '没有权限执行该操作。',
  CSRF_REJECTED: '请求被安全策略拦截，请刷新页面后重试。',
  OAUTH_REGISTRATION_EXPIRED: '第三方注册会话已过期，请返回登录页重新授权。',
  OAUTH_IDENTITY_CONFLICT: '该第三方账号已绑定其他 MuseCanvas 账号。',
  OAUTH_PROVIDER_DISABLED: '该第三方登录方式未启用。',
  UPSTREAM_UNAVAILABLE: NETWORK_MESSAGE,
  NETWORK_ERROR: NETWORK_MESSAGE,
}

function codeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const code = (error as AuthErrorLike).code
  return typeof code === 'string' ? code : ''
}

function messageOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const message = (error as AuthErrorLike).message
  return typeof message === 'string' ? message.trim() : ''
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const status = (error as AuthErrorLike).status
  return typeof status === 'number' ? status : null
}

/**
 * 把认证请求异常翻译成一句中文。命中后端错误码优先；否则按 HTTP 状态
 * （429 限流、0 网络）兜底；带后端 code 的异常再用其后端 message；
 * 普通 JS 异常（英文的 `Failed to fetch` 等）不直接展示，改用调用方 fallback。
 */
export function describeAuthError(error: unknown, fallback: string): string {
  const code = codeOf(error)
  if (code in AUTH_ERROR_MESSAGES) return AUTH_ERROR_MESSAGES[code]

  const status = statusOf(error)
  if (status === 429) return AUTH_ERROR_MESSAGES.RATE_LIMITED
  if (status === 0) return NETWORK_MESSAGE

  return code ? messageOf(error) || fallback : fallback
}

/** OAuth 回调经 `?error=CODE` 回传的错误码（api-surface.md §2.3）。 */
const OAUTH_CALLBACK_MESSAGES: Record<string, string> = {
  OAUTH_PROVIDER_DISABLED: '该第三方登录方式当前未启用，请改用邮箱验证码登录。',
  OAUTH_STATE_FAILED: '授权校验失败，请重新发起第三方登录。',
  OAUTH_STATE_EXPIRED: '授权已过期，请重新发起第三方登录。',
  OAUTH_DENIED: '你取消了第三方授权，可重新发起或改用邮箱验证码。',
  OAUTH_INVALID_CALLBACK: '授权回调无效，请重新发起第三方登录。',
  OAUTH_PROFILE_FAILED: '无法读取第三方账号信息，请稍后重试或改用邮箱验证码。',
  OAUTH_EMAIL_UNVERIFIED: '第三方账号的邮箱尚未验证，请先在第三方平台完成邮箱验证。',
  OAUTH_ACCOUNT_UNAVAILABLE: '该账号已被停用，请联系站点管理员。',
  OAUTH_IDENTITY_CONFLICT: '该第三方账号已绑定其他 MuseCanvas 账号。',
  OAUTH_EMAIL_MISMATCH: '第三方账号的邮箱与当前登录邮箱不一致，无法绑定。',
  OAUTH_REGISTRATION_EXPIRED: '第三方注册会话已过期，请返回登录页重新授权。',
}

/** `null` = 没有错误；未知错误码给一条通用说明，而不是静默吞掉。 */
export function describeOAuthError(code: string | null | undefined): string | null {
  if (!code) return null
  return OAUTH_CALLBACK_MESSAGES[code] ?? '第三方登录未完成。请重试，或改用邮箱验证码登录。'
}

/** 形状校验；账号是否存在由后端判断，前端不做存在性推断。 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 邮箱只做 `trim`；大小写规范化交给后端，避免把用户输入改成另一个地址。 */
export function normalizeEmail(value: string): string {
  return value.trim()
}

/** `null` = 通过；否则返回可直接展示的中文校验信息。 */
export function validateEmail(value: string): string | null {
  const email = normalizeEmail(value)
  if (!email) return '请填写用于接收验证码的邮箱地址。'
  if (!EMAIL_PATTERN.test(email)) return '邮箱格式不正确，请填写类似 name@example.com 的地址。'
  return null
}

/** 重发倒计时 `MM:SS`（纯样式冷却，服务端只有限流）。 */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
