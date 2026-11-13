// 安装向导的错误码 → 中文文案（SetupErrorCode 为唯一来源）。
// 纯函数、无运行时依赖：`ApiError` 只按结构读取 code/status/message，便于 node:test。

export interface SetupErrorLike {
  code?: string | null
  status?: number | null
  message?: string | null
}

const NETWORK_MESSAGE = '无法连接服务，请检查网络或确认 API 服务已启动后重试。'

/** claim 已过期后重领的提示；与后端 15 分钟有效期一致。 */
export const SESSION_LOST_MESSAGE =
  '初始化会话已失效或过期，请重新领取初始化码。领取码 15 分钟内有效且只能使用一次。'

const SETUP_ERROR_MESSAGES: Record<string, string> = {
  SETUP_SESSION_INVALID: SESSION_LOST_MESSAGE,
  SETUP_SESSION_EXPIRED: SESSION_LOST_MESSAGE,
  SETUP_SESSION_CONSUMED: SESSION_LOST_MESSAGE,
  UNAUTHORIZED: SESSION_LOST_MESSAGE,
  SETUP_CLAIM_NOT_REQUIRED: '当前部署不需要领取码，正在重新读取初始化状态。',
  SETUP_ALREADY_COMPLETE: '系统已完成初始化，请使用管理员账号登录后台。',
  SETUP_INCOMPLETE: '仍有必填步骤未完成，请返回对应步骤完成后再试。',
  INVALID_INPUT: '填写内容不符合要求，请检查后重试。',
  INVALID_OTP: '验证码错误或已过期，请检查最新邮件或重新获取。',
  RATE_LIMITED: '请求过于频繁，请稍后再试（约 10 分钟）。',
  EMAIL_DELIVERY_FAILED: '验证码邮件发送失败，请先确认 SMTP 连接已通过验证。',
  PUBLIC_ORIGIN_INVALID:
    '站点地址必须是合法的 HTTPS 地址（本地开发可用 localhost 的 HTTP），且不能包含路径、认证信息或查询参数。',
  SMTP_TEST_FAILED: 'SMTP 连接验证未通过，请检查服务器地址、端口、加密方式与账号密码；设置未被保存。',
  STORAGE_TEST_FAILED: '对象存储连接验证未通过，请检查端点、桶名与访问密钥；设置未被保存。',
  STORAGE_SECRET_REENTER_REQUIRED: '已保存的对象存储密钥无法读取，请重新输入访问密钥后再保存。',
  DATABASE_UNREACHABLE: '无法连接数据库，请检查 DATABASE_URL 指向的服务与网络。',
  UPSTREAM_UNAVAILABLE: NETWORK_MESSAGE,
  NETWORK_ERROR: NETWORK_MESSAGE,
  ABORTED: '请求已取消，请重试。',
  INTERNAL_ERROR: '服务端处理失败，请稍后重试。',
}

function codeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const code = (error as SetupErrorLike).code
  return typeof code === 'string' ? code : ''
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const status = (error as SetupErrorLike).status
  return typeof status === 'number' ? status : null
}

function messageOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const message = (error as SetupErrorLike).message
  return typeof message === 'string' ? message.trim() : ''
}

/**
 * 会话类错误：任何一步遇到都应回到领取步骤重新认证。
 *
 * 带错误码时只看错误码——`INVALID_OTP` 在 setup/admin/verify 里同样是 401，
 * 但它是验证码错误而不是会话失效，不能把用户踢回领取步。
 */
export function isSetupSessionError(error: unknown): boolean {
  const code = codeOf(error)
  if (code) {
    return (
      code === 'SETUP_SESSION_INVALID' ||
      code === 'SETUP_SESSION_EXPIRED' ||
      code === 'SETUP_SESSION_CONSUMED' ||
      code === 'UNAUTHORIZED'
    )
  }
  return statusOf(error) === 401
}

/** 服务端已不要求领取码（状态缓存过期）：不是错误，刷新状态后继续即可。 */
export function isSetupClaimNotRequired(error: unknown): boolean {
  return codeOf(error) === 'SETUP_CLAIM_NOT_REQUIRED'
}

/** 系统已经完成初始化（或已存在管理员）：应刷新状态而不是把它当普通失败。 */
export function isSetupAlreadyComplete(error: unknown): boolean {
  return codeOf(error) === 'SETUP_ALREADY_COMPLETE'
}

/**
 * 错误 → 可直接展示的中文。命中错误码优先；否则按 HTTP 状态（429/401/0/5xx）兜底；
 * 带后端 code 时再用后端 message；普通 JS 异常使用调用方 fallback（不展示英文原文）。
 */
export function describeSetupError(error: unknown, fallback: string): string {
  const code = codeOf(error)
  // 校验类错误的后端 message 更具体（例如哪个字段不能指向内网），优先原样展示。
  if (code === 'INVALID_INPUT') return messageOf(error) || SETUP_ERROR_MESSAGES.INVALID_INPUT
  if (code in SETUP_ERROR_MESSAGES) return SETUP_ERROR_MESSAGES[code]

  const status = statusOf(error)
  if (status === 429) return SETUP_ERROR_MESSAGES.RATE_LIMITED
  if (status === 401) return SESSION_LOST_MESSAGE
  if (status === 0) return NETWORK_MESSAGE
  if (status !== null && status >= 500) return SETUP_ERROR_MESSAGES.INTERNAL_ERROR

  return code ? messageOf(error) || fallback : fallback
}
