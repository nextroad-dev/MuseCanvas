// 后台三页共用的 API 错误 → 中文文案映射。
// 后端 `INVALID_INPUT` 等多数字段错误已经带中文 message，优先原样展示；
// 只有英文/通用兜底 message 或纯网络错误才走本地映射，避免把「Invalid settings」丢给用户。

import { isApiError } from '@/shared/services/client-api'

const CODE_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: '登录状态已失效，请重新登录。',
  FORBIDDEN: '当前账号没有管理员权限。',
  CSRF_REJECTED: '请求来源校验失败，请刷新页面后重试。',
  INVALID_INPUT: '提交的内容不合法，请检查后重试。',
  NOT_FOUND: '目标资源不存在或已被删除。',
  RATE_LIMITED: '请求过于频繁，请稍后再试。',
  NETWORK_ERROR: '网络连接失败，请检查网络后重试。',
  ABORTED: '请求已取消。',
  INTERNAL_ERROR: '服务器处理失败，请稍后重试。',

  CREDENTIAL_ENCRYPT_FAILED: '凭据加密失败，请检查服务端加密配置。',
  LANGUAGE_MODEL_CONFIG_INVALID: '请选择已启用且凭据完整的语言模型。',
  PROMPT_MODEL_NOT_CONFIGURED: '启用前请先选择语言模型。',
  DEFAULT_MODEL_INVALID: '请选择已启用、未删除且类型匹配的媒体模型。',
  SETTINGS_UPDATE_FAILED: '设置保存失败，请稍后重试；若持续失败，请检查服务端日志。',

  SMTP_TEST_FAILED: 'SMTP 连接测试失败，请检查服务器地址、端口与认证信息。',
  STORAGE_TEST_FAILED: '对象存储连接测试失败，请检查端点、桶名与密钥。',
  STORAGE_CONFIG_UNREADABLE: '已保存的存储密钥无法解密，请重新填写密钥后保存。',
  PUBLIC_ORIGIN_INVALID: '站点地址不合法，必须是 HTTPS 的裸域名。',
  DATABASE_UNREACHABLE: '数据库连接不可用。',

  TEMPLATE_SET_NOT_FOUND: '模板集不存在。',
  TEMPLATE_ENTRY_NOT_FOUND: '模板条目不存在。',
  TEMPLATE_SET_NOT_ACTIVE: '只有当前启用的模板集可以编辑。',
  CANNOT_DELETE_ACTIVE_SET: '启用中的模板集不能删除，请先激活其它版本。',
  DUPLICATE_TEMPLATE_NAME: '模板名称不能重复。',
  INVALID_TEMPLATE_VARIABLE: '模板包含不支持的变量。',
  TEMPLATE_INSTRUCTION_EMPTY: '模板内容不能为空。',
  TEMPLATE_NAME_EMPTY: '模板名称不能为空。',
  NO_ACTIVE_TEMPLATE_SET: '当前没有启用的模板集。',

  SETUP_SESSION_INVALID: '没有初始化访问权限，请重新登录管理员账号。',
  SETUP_ALREADY_COMPLETE: '实例已完成初始化。',
  SETUP_INCOMPLETE: '初始化尚未完成，请先在向导中补齐必填项。',
}

const GENERIC_MESSAGES = new Set([
  'Invalid settings',
  'FORBIDDEN',
  'Unauthorized',
  'Request failed',
  'Internal Server Error',
])

/** 只认明确的中文业务文案；否则回落到错误码映射。 */
function isChineseMessage(message: string): boolean {
  return /[\u4e00-\u9fa5]/.test(message)
}

export function adminErrorMessage(error: unknown, fallback = '操作失败，请稍后重试。'): string {
  if (isApiError(error)) {
    const message = error.message.trim()
    if (message && !GENERIC_MESSAGES.has(message) && isChineseMessage(message)) return message
    const mapped = CODE_MESSAGES[error.code]
    if (mapped) return mapped
    return message || fallback
  }
  if (error instanceof Error) {
    const message = error.message.trim()
    if (message && isChineseMessage(message)) return message
    return CODE_MESSAGES[message] ?? fallback
  }
  if (typeof error === 'string' && isChineseMessage(error)) return error
  return fallback
}

/** 复制文本，兼容非安全上下文（`navigator.clipboard` 不可用时回退到 textarea）。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.top = '-1000px'
      document.body.appendChild(area)
      area.select()
      const copied = document.execCommand('copy')
      document.body.removeChild(area)
      return copied
    } catch {
      return false
    }
  }
}
