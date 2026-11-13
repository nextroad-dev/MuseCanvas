'use client'

// 后台概览的数据层：TanStack Query 查询 + 纯视图模型（图表高度、默认模型摘要）。
// 纯函数与 hook 放在一起，是因为它们只服务这一处；纯函数输入输出都是普通对象，
// 不依赖 React，便于在组件外推理（例如柱高、aria-label 汇总）。

import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'

import { queryKeys } from '@/shared/hooks/query-keys'
import { clientApi } from '@/shared/services/client-api'
import type {
  AdminDashboardDto,
  AdminJobDto,
  MediaModelDefaultsDto,
  PublicModelDto,
} from '@/shared/types'

/** 概览数据 30s 内视为新鲜；前台每 60s 主动刷新一次，「更新于」才有意义。 */
export const ADMIN_DASHBOARD_STALE_MS = 30_000
export const ADMIN_DASHBOARD_REFRESH_MS = 60_000

/** 画板 07「最近任务」固定 10 条。 */
export const ADMIN_RECENT_JOBS_LIMIT = 10

/** 图表柱区的最大高度（px，对应画板 07 的 112px 柱区）。 */
export const ADMIN_CHART_BAR_HEIGHT = 112

export interface AdminDashboardDay {
  /** `YYYY-MM-DD`（后端按数据库会话时区的自然日分桶）。 */
  date: string
  total: number
  succeeded: number
  failed: number
}

/** 图表的一列：已算好像素高度与 `MM-DD` 轴标签。 */
export interface AdminChartDay extends AdminDashboardDay {
  label: string
  /** 窄屏轴标签（只保留当月第几天），避免 7 列在 320px 下互相挤压。 */
  shortLabel: string
  successHeight: number
  failHeight: number
}

export interface AdminDashboardSummary {
  /** 近 7 天生成总数（`days` 求和；无序列时为 0）。 */
  total: number
  succeeded: number
  failed: number
  /** 0-100 的百分比；无可统计任务时为 `null`。 */
  successRate: number | null
  successRateLabel: string
}

export type AdminDefaultModelState = 'ready' | 'unset' | 'unresolved'

export interface AdminDefaultModelEntry {
  id: string | null
  name: string | null
  state: AdminDefaultModelState
}

export interface AdminDefaultModelSummary {
  image: AdminDefaultModelEntry
  video: AdminDefaultModelEntry
  /** 图像与视频都有可用默认模型。 */
  complete: boolean
}

type AdminJobsPage = Awaited<ReturnType<typeof clientApi.admin.listJobs>>

function toCount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

/** `YYYY-MM-DD` → `MM-DD`；格式不符时原样返回，不推测日期。 */
function monthDayLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  return match ? `${match[2]}-${match[3]}` : date
}

/**
 * 读取近 7 天序列：优先 B1 新增的 `days`，其次兼容旧前端镜像的 `daily`
 * （旧形状没有 `total`，用 succeeded + failed 兜底）。永不推测缺失日期。
 */
export function normalizeDashboardDays(payload: unknown): AdminDashboardDay[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as { days?: unknown; daily?: unknown }
  const raw = Array.isArray(record.days) ? record.days : Array.isArray(record.daily) ? record.daily : []
  const days: AdminDashboardDay[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const day = entry as { date?: unknown; total?: unknown; succeeded?: unknown; failed?: unknown }
    const date = typeof day.date === 'string' ? day.date : ''
    if (!date) continue
    const succeeded = toCount(day.succeeded)
    const failed = toCount(day.failed)
    const total = day.total === undefined ? succeeded + failed : toCount(day.total)
    days.push({ date, total, succeeded, failed })
  }
  return days
}

/**
 * 柱高：以 7 天内的最大 total 为满格，失败段最少 3px（有失败就看得见）。
 * 失败段在成功段之上——与画板 07 的堆叠顺序一致；成功段取 `total - failed`
 * （与画板同口径），这样柱高与「每日总数」标签始终一致，进行中/已取消不会让
 * 柱体凭空变矮。
 */
export function buildChartDays(
  days: AdminDashboardDay[],
  barHeight: number = ADMIN_CHART_BAR_HEIGHT,
): AdminChartDay[] {
  const max = Math.max(1, ...days.map((day) => day.total))
  return days.map((day) => {
    const failed = Math.max(0, day.failed)
    const positive = Math.max(0, day.total - failed)
    const label = monthDayLabel(day.date)
    return {
      ...day,
      label,
      shortLabel: /^\d{4}-\d{2}-\d{2}$/.test(day.date) ? day.date.slice(8, 10) : label,
      successHeight: Math.min(barHeight, Math.round((positive / max) * barHeight)),
      failHeight: failed > 0 ? Math.min(barHeight, Math.max(3, Math.round((failed / max) * barHeight))) : 0,
    }
  })
}

function formatSuccessRate(rate: number | null): string {
  if (rate === null) return '—'
  return `${Math.round(rate * 10) / 10}%`
}

/**
 * 汇总卡片文案：优先后端 `successRate7d`（滚动 7×24h 口径），
 * 序列为空时退回 `failedJobs7d`，两者都缺才显示 `—`。
 */
export function summarizeDashboard(
  payload: AdminDashboardDto | undefined,
  days: AdminDashboardDay[],
): AdminDashboardSummary {
  const total = days.reduce((sum, day) => sum + day.total, 0)
  const succeeded = days.reduce((sum, day) => sum + day.succeeded, 0)
  const failed = days.length > 0 ? days.reduce((sum, day) => sum + day.failed, 0) : toCount(payload?.failedJobs7d)

  const backendRate =
    payload && typeof payload.successRate7d === 'number' && Number.isFinite(payload.successRate7d)
      ? payload.successRate7d
      : null
  const decided = succeeded + failed
  const rate = backendRate ?? (days.length > 0 && decided > 0 ? (succeeded / decided) * 100 : null)

  return { total, succeeded, failed, successRate: rate, successRateLabel: formatSuccessRate(rate) }
}

/** 图表整体说明：一张 `role="img"` 的图表要让读屏一次听完结论。 */
export function buildChartLabel(days: AdminDashboardDay[], summary: AdminDashboardSummary): string {
  if (days.length === 0) return '近 7 天暂无生成任务数据'
  return `近 7 天每日生成任务数，共 ${summary.total} 个，其中失败 ${summary.failed} 个`
}

/** `更新于` 的 `HH:mm`；无时间戳（首帧未取到数据）显示 `—`。 */
export function formatUpdatedTime(timestamp: number | null | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const date = new Date(timestamp)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 默认模型摘要条：把默认 id 映射成模型名，并区分「未设置」与「已不可用」。 */
export function summarizeDefaultModels(
  defaults: MediaModelDefaultsDto | undefined,
  models: PublicModelDto[],
): AdminDefaultModelSummary {
  const names = new Map(models.map((model) => [model.id, model.displayName]))
  const entry = (id: string | null | undefined): AdminDefaultModelEntry => {
    if (!id) return { id: null, name: null, state: 'unset' }
    const name = names.get(id) ?? null
    return { id, name, state: name ? 'ready' : 'unresolved' }
  }
  const image = entry(defaults?.imageModelId)
  const video = entry(defaults?.videoModelId)
  return { image, video, complete: image.state === 'ready' && video.state === 'ready' }
}

/** 任务类型列：后端 `mediaKind` 是 `image | video`。 */
export function jobMediaKindLabel(mediaKind: string): string {
  if (mediaKind === 'image') return '图像'
  if (mediaKind === 'video') return '视频'
  return mediaKind
}

/** 任务 ID 列：UUID 只显示前 8 位，完整值交给 `title` 与任务监控页。 */
export function truncateJobId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

export function useAdminDashboard(): UseQueryResult<AdminDashboardDto> {
  return useQuery({
    queryKey: queryKeys.admin.dashboard,
    queryFn: () => clientApi.admin.getDashboard(),
    staleTime: ADMIN_DASHBOARD_STALE_MS,
    refetchInterval: ADMIN_DASHBOARD_REFRESH_MS,
  })
}

export function useAdminMediaModelDefaults(): UseQueryResult<MediaModelDefaultsDto> {
  return useQuery({
    queryKey: queryKeys.admin.mediaModelDefaults,
    queryFn: () => clientApi.admin.getMediaModelDefaults(),
    staleTime: 60_000,
  })
}

export function useAdminRecentJobs(limit: number = ADMIN_RECENT_JOBS_LIMIT): UseQueryResult<AdminJobsPage> {
  return useQuery({
    queryKey: queryKeys.admin.jobs({ limit, scope: 'recent' }),
    queryFn: () => clientApi.admin.listJobs({ limit }),
    staleTime: 15_000,
    refetchInterval: 30_000,
  })
}

export type { AdminJobDto, AdminJobsPage }
