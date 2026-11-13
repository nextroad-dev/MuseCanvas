// OAuth 后台页的静态文案与纯展示逻辑（无 React / 无请求），方便页面组件共用。

import type { AdminOAuthProviderDto } from '@/shared/types'

export const OAUTH_PROVIDER_ORDER = ['github', 'google'] as const

export interface OAuthProviderMeta {
  label: string
  description: string
  docsLabel: string
  docsUrl: string
  callbackHint: string
}

export const OAUTH_PROVIDER_META: Record<(typeof OAUTH_PROVIDER_ORDER)[number], OAuthProviderMeta> = {
  github: {
    label: 'GitHub',
    description: '用 GitHub 账号登录；凭据在 GitHub → Settings → Developer settings → OAuth Apps 创建。',
    docsLabel: 'GitHub OAuth Apps',
    docsUrl: 'https://github.com/settings/developers',
    callbackHint: '将该地址填写到 GitHub OAuth App 的 Authorization callback URL。',
  },
  google: {
    label: 'Google',
    description: '用 Google 账号登录；凭据在 Google Cloud Console → APIs & Services → Credentials 创建。',
    docsLabel: 'Google Cloud Console',
    docsUrl: 'https://console.cloud.google.com/apis/credentials',
    callbackHint: '将该地址填写到 Google OAuth 2.0 客户端 ID 的 Authorized redirect URIs。',
  },
}

export type OAuthSource = AdminOAuthProviderDto['source']

export const OAUTH_SOURCE_LABEL: Record<OAuthSource, string> = {
  database: '数据库凭据',
  environment: '环境变量凭据',
  none: '未配置凭据',
}

export const OAUTH_SOURCE_HINT: Record<OAuthSource, string> = {
  database: '当前使用后台保存的 Client ID / Secret；环境变量只在缺少字段时兜底。',
  environment: '当前凭据来自服务端环境变量。在下方保存 Client ID / Secret 后，后台配置将接管登录凭据。',
  none: '尚未配置可用凭据。填写 Client ID 与 Client Secret 并保存后才能启用该登录方式。',
}

/** 只有来源非 none 才真正可登录（后端 enabled 也是按「已配置 + 已启用」计算）。 */
export function oauthConfigured(provider: AdminOAuthProviderDto): boolean {
  return provider.source !== 'none'
}

/** Client ID 只回显前 8 位；完整值由输入框承载（输入框里是明文）。 */
export function shortClientId(clientId: string): string {
  if (!clientId) return '未配置'
  return clientId.length > 12 ? `${clientId.slice(0, 8)}…` : clientId
}

export interface OAuthFormValues {
  clientId: string
  clientSecret: string
}

export function validateOAuthForm(values: OAuthFormValues): Partial<Record<keyof OAuthFormValues, string>> {
  const errors: Partial<Record<keyof OAuthFormValues, string>> = {}
  if (values.clientId.trim().length > 300) errors.clientId = 'Client ID 不能超过 300 个字符。'
  if (values.clientSecret.length > 1000) errors.clientSecret = 'Client Secret 不能超过 1000 个字符。'
  return errors
}
