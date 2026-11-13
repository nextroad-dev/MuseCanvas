// 账户页回调提示：OAuth 绑定回跳经 `?linked=1` / `?error=CODE` 带回结果（research §2.3）。
// 纯函数、无运行时依赖，便于直接测试。

export interface AccountCallback {
  linked?: string | null
  error?: string | null
}

export interface AccountNotice {
  tone: 'success' | 'error'
  title: string
}

const CALLBACK_ERRORS: Record<string, string> = {
  OAUTH_EMAIL_MISMATCH: '第三方账号的邮箱与当前登录邮箱不一致，无法绑定。请用同一邮箱的第三方账号重试。',
  OAUTH_IDENTITY_CONFLICT: '该第三方账号已绑定其他 MuseCanvas 账号，请先在那边解绑。',
  OAUTH_STATE_FAILED: '授权校验失败，请重新发起绑定。',
  OAUTH_STATE_EXPIRED: '授权已过期，请重新发起绑定。',
  OAUTH_DENIED: '你取消了第三方授权，可随时重新发起绑定。',
  OAUTH_PROVIDER_DISABLED: '该第三方登录方式当前未启用，请联系站点管理员。',
  OAUTH_PROFILE_FAILED: '无法读取第三方账号信息，请稍后重试。',
  OAUTH_EMAIL_UNVERIFIED: '第三方账号的邮箱尚未验证，请先在第三方平台完成验证。',
  OAUTH_ACCOUNT_UNAVAILABLE: '该账号已被停用，请联系站点管理员。',
  OAUTH_INVALID_CALLBACK: '授权回调无效，请重新发起绑定。',
}

/** 把回跳 query 翻译成一条 toast；没有可提示内容时返回 `null`。 */
export function describeAccountCallback(callback: AccountCallback): AccountNotice | null {
  if (callback.linked) {
    return { tone: 'success', title: '已绑定第三方账号，下次可直接用它登录。' }
  }
  if (callback.error) {
    return {
      tone: 'error',
      title: CALLBACK_ERRORS[callback.error] ?? '第三方绑定未完成，请重试或稍后再试。',
    }
  }
  return null
}
