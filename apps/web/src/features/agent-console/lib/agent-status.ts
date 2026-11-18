// Agent Core V1 状态映射、字节校验与时间线项载荷解析辅助。
// 纯模块：仅 `import type`，零 React/DOM 依赖，可直接被 `node --test` 导入。

import type {
  AgentApprovalStatus,
  AgentErrorCode,
  AgentItemDTO,
  AgentSessionDTO,
  AgentToolCallStatus,
  AgentTurnStatus,
  JsonObject,
  JsonValue,
} from '@musecanvas/contracts'
import type { BadgeTone } from '@/shared/components/ui'
import type { AgentConnectionState } from '@/shared/hooks/useAgentConsole'

/** 后端 `apps/api/src/modules/agent/validation.ts` 限制单条消息最大 32,000 UTF-8 字节。 */
export const AGENT_MESSAGE_MAX_BYTES = 32_000

export type AgentSessionStatus = 'active' | 'idle' | 'archived' | 'closed'
export type AgentTurnStatusLike = AgentTurnStatus | 'waiting_budget' | 'cancelling' | 'timed_out'
export type AgentToolStatus = AgentToolCallStatus | 'queued' | 'running' | 'timed_out'

export interface StatusPresentation {
  label: string
  tone: BadgeTone
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NON_TERMINAL_TURN_STATUSES = new Set<string>([
  'queued',
  'running',
  'waiting_tools',
  'waiting_approval',
  'waiting_budget',
  'cancelling',
])

const SESSION_STATUS_MAP: Record<AgentSessionStatus, StatusPresentation> = {
  active: { label: '运行中', tone: 'accent' },
  idle: { label: '空闲', tone: 'neutral' },
  archived: { label: '已归档', tone: 'neutral' },
  closed: { label: '已关闭', tone: 'neutral' },
}

const TURN_STATUS_MAP: Record<AgentTurnStatusLike, StatusPresentation> = {
  queued: { label: '排队中', tone: 'info' },
  running: { label: '推理中', tone: 'accent' },
  waiting_tools: { label: '等待工具', tone: 'info' },
  waiting_approval: { label: '等待审批', tone: 'warning' },
  waiting_budget: { label: '等待配额', tone: 'warning' },
  cancelling: { label: '取消中', tone: 'warning' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
  timed_out: { label: '已超时', tone: 'danger' },
}

const TOOL_STATUS_MAP: Record<AgentToolStatus, StatusPresentation> = {
  recorded: { label: '已记录', tone: 'neutral' },
  queued: { label: '排队中', tone: 'neutral' },
  validating: { label: '校验中', tone: 'info' },
  waiting_approval: { label: '待审批', tone: 'warning' },
  executing: { label: '执行中', tone: 'accent' },
  running: { label: '执行中', tone: 'accent' },
  waiting_external: { label: '等待外部结果', tone: 'info' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
  timed_out: { label: '已超时', tone: 'danger' },
  skipped: { label: '已跳过', tone: 'neutral' },
}

const APPROVAL_STATUS_MAP: Record<AgentApprovalStatus, StatusPresentation> = {
  pending: { label: '待审批', tone: 'warning' },
  approved: { label: '已批准', tone: 'success' },
  rejected: { label: '已拒绝', tone: 'danger' },
  expired: { label: '已过期', tone: 'neutral' },
}

const CONNECTION_STATE_MAP: Record<AgentConnectionState, StatusPresentation> = {
  idle: { label: '未连接', tone: 'neutral' },
  connecting: { label: '连接中', tone: 'info' },
  connected: { label: '实时同步', tone: 'success' },
  reconnecting: { label: '重连中', tone: 'warning' },
  resyncing: { label: '同步快照', tone: 'info' },
  error: { label: '连接异常', tone: 'danger' },
}

const ERROR_CODE_LABELS: Record<AgentErrorCode, string> = {
  IDEMPOTENCY_CONFLICT: '请求幂等标识冲突',
  RESYNC_REQUIRED: '事件流需要重同步',
  INVALID_TRANSITION: '轮次状态流转无效',
  LEASE_LOST: '执行租约已失效',
  BUDGET_EXCEEDED: '已达到本轮预算配额上限',
  APPROVAL_CONFLICT: '审批状态或参数摘要冲突',
  APPROVAL_EXPIRED: '审批已过期',
  APPROVAL_REJECTED: '审批已拒绝',
  TOOL_FAILED: '工具执行失败',
  DEADLINE_EXCEEDED: '执行超时（超出截止时间）',
  SUBMISSION_UNKNOWN: '外部任务提交状态未知',
}

/** 从会话字段派生可读的会话状态（归档 > 活动轮次 > 空闲）。 */
export function deriveSessionStatus(
  session: Pick<AgentSessionDTO, 'activeTurnId' | 'archivedAt'>,
): AgentSessionStatus {
  if (session.archivedAt) return 'archived'
  if (session.activeTurnId) return 'active'
  return 'idle'
}

export function formatSessionStatus(status: AgentSessionStatus | (string & {})): StatusPresentation {
  return SESSION_STATUS_MAP[status as AgentSessionStatus] ?? { label: '未知状态', tone: 'neutral' }
}

export function formatTurnStatus(
  status: AgentTurnStatusLike | (string & {}),
  options?: { cancelRequestedAt?: string | null; errorCode?: string | null },
): StatusPresentation {
  if (options?.cancelRequestedAt && NON_TERMINAL_TURN_STATUSES.has(status)) {
    return TURN_STATUS_MAP.cancelling
  }
  if (status === 'failed' && options?.errorCode === 'DEADLINE_EXCEEDED') {
    return TURN_STATUS_MAP.timed_out
  }
  return TURN_STATUS_MAP[status as AgentTurnStatusLike] ?? { label: '未知状态', tone: 'neutral' }
}

export function formatToolStatus(status: AgentToolStatus | (string & {})): StatusPresentation {
  return TOOL_STATUS_MAP[status as AgentToolStatus] ?? { label: '未知状态', tone: 'neutral' }
}

export function formatApprovalStatus(status: AgentApprovalStatus | (string & {})): StatusPresentation {
  return APPROVAL_STATUS_MAP[status as AgentApprovalStatus] ?? { label: '未知状态', tone: 'neutral' }
}

export function formatConnectionState(state: AgentConnectionState | (string & {})): StatusPresentation {
  return CONNECTION_STATE_MAP[state as AgentConnectionState] ?? { label: '未知连接', tone: 'neutral' }
}

export function formatAgentErrorCode(code: AgentErrorCode | string | null | undefined): string {
  if (!code) return '执行失败'
  return ERROR_CODE_LABELS[code as AgentErrorCode] ?? code
}

export function shortUuid(id: string | null | undefined, length = 8): string {
  if (!id) return '—'
  const clean = id.trim()
  if (!clean) return '—'
  return `#${clean.slice(0, length)}`
}

export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim())
}

const utf8Encoder = new TextEncoder()

/** 按 UTF-8 计算字符串真实字节长度，用于对齐后端 `Buffer.byteLength` 校验。 */
export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength
}

export function isMessageOverLimit(text: string, maxBytes = AGENT_MESSAGE_MAX_BYTES): boolean {
  return utf8ByteLength(text) > maxBytes
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asFiniteNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function safePayload(payload: JsonObject | null | undefined): JsonObject {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
}

/** 安全提取时间线条目正文，兼容 live 稀疏载荷（仅含 content/message）与 mock 富载荷。 */
export function extractItemText(item: Pick<AgentItemDTO, 'type' | 'payload'>): string {
  const payload = safePayload(item.payload)
  const content = asString(payload.content)
  if (content) return content
  const message = asString(payload.message)
  if (message) return message
  const reason = asString(payload.reason)
  if (reason) return reason
  const prompt = asString(payload.prompt)
  if (prompt) return prompt
  const error = asString(payload.error)
  if (error) return error
  switch (item.type) {
    case 'tool_call':
      return asString(payload.toolName) ? `准备调用 ${asString(payload.toolName)}` : '发起工具调用'
    case 'tool_result':
      return '工具执行完成'
    case 'approval':
      return '需要确认工具调用'
    case 'artifact_reference':
      return asString(payload.label) ?? '生成结果引用'
    case 'system_event':
      return '系统事件'
    default:
      return ''
  }
}

export interface ArtifactPreviewInfo {
  assetId: string | null
  url: string | null
  thumbnailUrl: string | null
  downloadUrl: string | null
  width: number | null
  height: number | null
  mimeType: string | null
  prompt: string | null
  label: string | null
  message: string | null
}

/** 安全解析 `artifact_reference` 载荷，缺省字段统一返回 null。 */
export function extractArtifactPreview(item: Pick<AgentItemDTO, 'payload'>): ArtifactPreviewInfo {
  const payload = safePayload(item.payload)
  return {
    assetId: asString(payload.assetId),
    url: asString(payload.url),
    thumbnailUrl: asString(payload.thumbnailUrl),
    downloadUrl: asString(payload.downloadUrl),
    width: asFiniteNumber(payload.width),
    height: asFiniteNumber(payload.height),
    mimeType: asString(payload.mimeType),
    prompt: asString(payload.prompt),
    label: asString(payload.label),
    message: asString(payload.message) ?? asString(payload.content),
  }
}

export interface ToolPayloadInfo {
  toolName: string | null
  message: string | null
  status: string | null
  approvalId: string | null
  prompt: string | null
  size: string | null
  error: string | null
  code: string | null
  reason: string | null
}

/** 安全提取 `tool_call` / `tool_result` / `approval` 载荷中的可选展示字段。 */
export function extractToolPayloadInfo(item: Pick<AgentItemDTO, 'payload'>): ToolPayloadInfo {
  const payload = safePayload(item.payload)
  return {
    toolName: asString(payload.toolName),
    message: asString(payload.message) ?? asString(payload.content),
    status: asString(payload.status),
    approvalId: asString(payload.approvalId),
    prompt: asString(payload.prompt),
    size: asString(payload.size),
    error: asString(payload.error),
    code: asString(payload.code),
    reason: asString(payload.reason),
  }
}

export type MediaJobStatus = 'completed' | 'failed' | 'cancelled' | 'succeeded' | 'running'

export interface MediaJobInfo {
  jobId: string
  status: MediaJobStatus
  assetIds: string[]
}

/** 单次工具结果最多展示的 job 数与每个 job 的资产数，避免异常载荷撑爆时间线。 */
export const MAX_MEDIA_JOBS = 8
export const MAX_MEDIA_ASSETS_PER_JOB = 16

const MEDIA_JOB_STATUS_ALIASES: Record<string, MediaJobStatus> = {
  completed: 'completed',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  // 媒体 job 的数据库终态拼写是 `canceled`（单 l），展示时归一到 `cancelled`。
  canceled: 'cancelled',
  running: 'running',
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function asUuidId(value: JsonValue | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return UUID_REGEX.test(trimmed) ? trimmed.toLowerCase() : null
}

/** `tool_result` 的 `jobs` 既可能在持久化载荷的 `result` 里，也可能直接平铺，或藏在 JSON 字符串正文中。 */
function mediaJobLists(payload: JsonObject): JsonValue[] {
  const lists: JsonValue[] = []
  const resultJobs = asObject(payload.result)?.jobs
  if (resultJobs !== undefined) lists.push(resultJobs)
  if (payload.jobs !== undefined) lists.push(payload.jobs)
  const content = asString(payload.content)
  if (content && content.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(content) as JsonValue
      const jobs = asObject(parsed)?.jobs
      if (jobs !== undefined) lists.push(jobs)
    } catch {
      // 正文不是 JSON 时忽略，不影响其它候选来源。
    }
  }
  return lists
}

/**
 * 安全解析媒体工具结果中的 `{ content, jobs: [{ jobId, status, assetIds }] }`。
 * 只认 UUID 形态的 id 与已知状态；超出上限、结构不符或字段未知时返回空数组。
 */
export function extractMediaJobs(payload: JsonObject | null | undefined): MediaJobInfo[] {
  const root = safePayload(payload)
  for (const list of mediaJobLists(root)) {
    if (!Array.isArray(list)) continue
    const jobs: MediaJobInfo[] = []
    for (const entry of list.slice(0, MAX_MEDIA_JOBS)) {
      const job = asObject(entry)
      if (!job) continue
      const jobId = asUuidId(job.jobId)
      const rawStatus = typeof job.status === 'string' ? job.status.trim().toLowerCase() : ''
      const status = MEDIA_JOB_STATUS_ALIASES[rawStatus]
      if (!jobId || !status) continue
      const assetIds: string[] = []
      const rawAssetIds = Array.isArray(job.assetIds) ? job.assetIds : []
      for (const rawAssetId of rawAssetIds.slice(0, MAX_MEDIA_ASSETS_PER_JOB)) {
        const assetId = asUuidId(rawAssetId)
        if (assetId && !assetIds.includes(assetId)) assetIds.push(assetId)
      }
      jobs.push({ jobId, status, assetIds })
    }
    if (jobs.length > 0) return jobs
  }
  return []
}

/** 媒体 job 状态复用工具状态文案（`succeeded` 与 `completed` 等价）。 */
export function formatMediaJobStatus(status: MediaJobStatus): StatusPresentation {
  return formatToolStatus(status === 'succeeded' ? 'completed' : status)
}

/** 仅允许站内相对路径或 http(s)/blob/安全图片 data URI，拒绝 `javascript:` 等协议。 */
export function isSafeDisplayUrl(url: string | null | undefined): boolean {
  if (!url) return false
  const trimmed = url.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) return true
  if (trimmed.startsWith('data:image/')) return true
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'blob:'
  } catch {
    return false
  }
}
