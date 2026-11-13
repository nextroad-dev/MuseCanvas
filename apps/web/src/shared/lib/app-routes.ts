// 站内路由字面量：`API_ENDPOINTS` 管后端路径，这里管浏览器页面路径。
// 导航、面包屑、`selectMode` 跳转共用一份，避免各组件私写字面量而悄悄分叉。

export const APP_ROUTES = {
  home: '/',
  login: '/login',
  generate: '/generate',
  library: '/library',
  account: '/account',
  admin: '/admin',
  adminMediaModels: '/admin/media-models',
  adminUsers: '/admin/users',
  adminJobs: '/admin/jobs',
  adminLanguageModels: '/admin/language-models',
  adminOAuth: '/admin/oauth',
  adminPromptTemplates: '/admin/prompt-templates',
  adminSettings: '/admin/settings',
  terms: '/terms',
  privacy: '/privacy',
  setup: '/setup',
} as const

export type AppRoute = (typeof APP_ROUTES)[keyof typeof APP_ROUTES]

export const GENERATE_ROUTE = APP_ROUTES.generate
export const LIBRARY_ROUTE = APP_ROUTES.library
export const LOGIN_ROUTE = APP_ROUTES.login

export function isOnGenerate(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return pathname === GENERATE_ROUTE || pathname.startsWith(`${GENERATE_ROUTE}/`)
}

export function isOnAdmin(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return pathname === APP_ROUTES.admin || pathname.startsWith(`${APP_ROUTES.admin}/`)
}

/**
 * 登录后 `?from=` 目标收敛为同源路径：`https://…`、`//host`、`/\host`
 * （浏览器会规范化为 `//host`）一律回落到创作台，避免开放重定向。
 */
export function safeRedirectPath(from: string | null | undefined): string {
  if (!from || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) {
    return GENERATE_ROUTE
  }
  return from
}
