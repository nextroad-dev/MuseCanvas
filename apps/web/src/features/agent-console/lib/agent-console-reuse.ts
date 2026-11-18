// Agent Console 的 URL 复用消费（如从 /library 点「复用同款提示词」或「作为参考图」跳回 /generate）。
// 纯模块：零 React/DOM，仅 `import type`。一次消费后保留用户后续编辑，不因普通切 tab/路由清空草稿。

import type { WorkspaceInspectorTab } from '@/shared/lib/app-routes'

export interface AgentConsoleReuseDraft {
  draftPrompt: string
  lastReuseQuery: string
}

export interface ReuseImageQueryPayload {
  url: string
  assetId: string | null
  label: string | null
  prompt: string | null
}

const VALID_PANELS = new Set<WorkspaceInspectorTab>(['artifacts', 'tools'])

function parseQuery(query: string): URLSearchParams {
  return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)
}

/** 消费 `?prompt=...&kind=...` 复用意图：同一参数仅预填一次，普通导航绝不覆盖用户草稿。 */
export function consumeReuseQuery<T extends AgentConsoleReuseDraft>(state: T, query: string): T {
  const params = parseQuery(query)
  const prompt = params.get('prompt')
  const kind = params.get('kind')
  const identity = prompt === null && kind === null ? '' : JSON.stringify([prompt, kind])
  if (identity === state.lastReuseQuery) return state
  if (!identity) return { ...state, lastReuseQuery: '' }
  const nextPrompt = prompt !== null && prompt.length > 0 ? prompt : state.draftPrompt
  return {
    ...state,
    draftPrompt: nextPrompt,
    lastReuseQuery: identity,
  }
}

/** 解析 `?panel=artifacts|tools` 右侧检查器目标页签；无效值返回 null。 */
export function parseInspectorPanelQuery(query: string): WorkspaceInspectorTab | null {
  const panel = parseQuery(query).get('panel')
  if (panel && VALID_PANELS.has(panel as WorkspaceInspectorTab)) {
    return panel as WorkspaceInspectorTab
  }
  return null
}

/** 提取本次 URL 中的复用媒体类型提示（如有）。 */
export function parseReuseKindQuery(query: string): string | null {
  const kind = parseQuery(query).get('kind')
  return kind && kind.trim().length > 0 ? kind.trim() : null
}

/** 提取本次 URL 中的参考图复用参数（如有）。 */
export function parseReuseImageQuery(query: string): ReuseImageQueryPayload | null {
  const params = parseQuery(query)
  const url = params.get('image')?.trim()
  if (!url) return null
  if (
    !url.startsWith('/') &&
    !url.startsWith('http://') &&
    !url.startsWith('https://') &&
    !url.startsWith('blob:') &&
    !url.startsWith('data:image/')
  ) {
    return null
  }
  return {
    url,
    assetId: params.get('assetId')?.trim() || null,
    label: params.get('label')?.trim() || null,
    prompt: params.get('prompt')?.trim() || null,
  }
}
