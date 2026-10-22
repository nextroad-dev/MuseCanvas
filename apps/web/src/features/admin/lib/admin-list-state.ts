export interface AdminJobFilters {
  status: string
  userId: string
  modelId: string
  from: string
  to: string
}

export const EMPTY_ADMIN_JOB_FILTERS: AdminJobFilters = { status: 'all', userId: '', modelId: '', from: '', to: '' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const JOB_STATUSES = ['queued', 'running', 'retry_wait', 'succeeded', 'failed', 'canceled']

/** The API silently ignores malformed filters; the admin form must not imply they applied. */
export function resolveAdminJobFilters(draft: AdminJobFilters) {
  const errors: Partial<Record<keyof AdminJobFilters, string>> = {}
  const params: Record<string, string> = {}
  for (const key of ['userId', 'modelId'] as const) {
    const value = draft[key].trim()
    if (value && !UUID.test(value)) errors[key] = '请输入完整的 UUID。'
    else if (value) params[key] = value
  }
  if (draft.status !== 'all') {
    if (!JOB_STATUSES.includes(draft.status)) errors.status = '请选择支持的任务状态。'
    else params.status = draft.status
  }
  for (const key of ['from', 'to'] as const) {
    const raw = draft[key].trim()
    if (!raw) continue
    const time = Date.parse(raw)
    if (!Number.isFinite(time)) errors[key] = '请输入有效时间。'
    else params[key] = new Date(time).toISOString()
  }
  if (params.from && params.to && params.from > params.to) errors.to = '结束时间不能早于开始时间。'
  return { params, errors, valid: Object.keys(errors).length === 0 }
}

/** Next cursors are opaque: no decoding, numeric jump or total-derived last page. */
export function appendAdminCursor(history: Array<string | undefined>, current: string | undefined, next: string | undefined) {
  if (!next || history.at(-1) !== current || next === current) return history
  return [...history, next]
}

export function readAdminJobFilters(search: Pick<URLSearchParams, 'get'>) {
  const draft = { ...EMPTY_ADMIN_JOB_FILTERS }
  for (const key of ['status', 'userId', 'modelId', 'from', 'to'] as const) {
    const raw = search.get(key)
    if (raw) draft[key] = raw
  }
  const resolved = resolveAdminJobFilters(draft)
  for (const key of ['from', 'to'] as const) {
    const raw = draft[key]
    if (!raw || !Number.isFinite(Date.parse(raw))) continue
    const date = new Date(raw)
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    draft[key] = local.toISOString().slice(0, 19)
  }
  return { draft, ...resolved }
}

export function searchAdminPromptTemplates<T extends { name: string; description?: string | null; instruction: string }>(items: T[], search: string): T[] {
  const term = search.trim().toLocaleLowerCase()
  return term ? items.filter((item) => `${item.name} ${item.description ?? ''} ${item.instruction}`.toLocaleLowerCase().includes(term)) : items
}

export function searchAdminInvitations<T extends { code?: string; id: string }>(items: T[], search: string): T[] {
  const term = search.trim().toLocaleLowerCase()
  return term ? items.filter((item) => `${item.code ?? ''} ${item.id}`.toLocaleLowerCase().includes(term)) : items
}
