// 站内路由字面量：`API_ENDPOINTS` 管后端路径，这里管浏览器页面路径。
// 导航、面包屑、`selectMode` 跳转共用一份，避免各组件私写字面量而悄悄分叉。

export const APP_ROUTES = {
  home: '/',
  login: '/login',
  generate: '/generate',
  library: '/library',
  account: '/account',
  admin: '/admin',
  adminOAuth: '/admin/oauth',
  adminPromptTemplates: '/admin/prompt-templates',
  adminSettings: '/admin/settings',
  terms: '/terms',
  privacy: '/privacy',
  setup: '/setup',
} as const

export type AppRoute = (typeof APP_ROUTES)[keyof typeof APP_ROUTES]
export type WorkspaceInspectorTab = 'artifacts' | 'tools'

export const GENERATE_ROUTE = APP_ROUTES.generate
export const LIBRARY_ROUTE = APP_ROUTES.library
export const LOGIN_ROUTE = APP_ROUTES.login

export function agentConsoleInspectorRoute(panel: WorkspaceInspectorTab): string {
  return `${APP_ROUTES.generate}?panel=${panel}`
}

export function agentSessionRoute(id: string): string {
  return `/agent/sessions/${encodeURIComponent(id)}`
}

const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 图库资产 id 只接受 UUID；大小写归一到小写，非法值返回 null。 */
function normalizeAssetId(id: string | null | undefined): string | null {
  if (!id) return null
  const clean = id.trim()
  return ASSET_ID_PATTERN.test(clean) ? clean.toLowerCase() : null
}

/** 图库资产深链：图库页以 `?asset=` 打开既有灯箱；id 非法时返回 null。 */
export function assetDetailHref(id: string): string | null {
  const assetId = normalizeAssetId(id)
  return assetId ? `${APP_ROUTES.library}?asset=${encodeURIComponent(assetId)}` : null
}

/** 从查询串（可含前导 `?`）读取资产深链 id；缺省或非法时返回 null。 */
export function assetIdFromSearch(search: string | null | undefined): string | null {
  if (!search) return null
  return normalizeAssetId(new URLSearchParams(search).get('asset'))
}

export function isOnGenerate(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return pathname === GENERATE_ROUTE || pathname.startsWith(`${GENERATE_ROUTE}/`) || pathname.startsWith('/agent/sessions/')
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
