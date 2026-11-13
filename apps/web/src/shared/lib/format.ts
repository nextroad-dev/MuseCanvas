// 展示层格式化：只做「已校验值的呈现」，不承担解析/业务规则。
// 约定：缺失值显示 `—`；无法解析的输入原样返回，避免把坏数据静默抹掉。

const pad = (part: number): string => String(part).padStart(2, '0')

function parseDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function raw(value: string | number | Date | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value)
}

/** `YYYY-MM-DD`（设计系统日期格式）。 */
export function formatDate(value: string | number | Date | null | undefined): string {
  const date = parseDate(value)
  if (!date) return raw(value)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `YYYY-MM-DD HH:mm`，24 小时制。 */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = parseDate(value)
  if (!date) return raw(value)
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `MM-DD`：卡片次要信息里年份不值得占宽度。 */
export function formatMonthDay(value: string | number | Date | null | undefined): string {
  const date = parseDate(value)
  if (!date) return raw(value)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `zh-CN` 本地化日期（后台表格的完整时间戳）。地区固定，不随浏览器变化。 */
export function formatLocalizedDate(value: string | number | Date | null | undefined): string {
  const date = parseDate(value)
  if (!date) return raw(value)
  return date.toLocaleDateString('zh-CN')
}

export function formatLocalizedDateTime(value: string | number | Date | null | undefined): string {
  const date = parseDate(value)
  if (!date) return raw(value)
  return date.toLocaleString('zh-CN')
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * 对话/任务列表的相对时间：`刚刚` / `N 分钟前` / `今天 HH:mm` / `昨天 HH:mm` /
 * `M 月 D 日` / `YYYY 年 M 月 D 日`。
 */
export function formatRelativeTime(
  value: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  const date = parseDate(value)
  if (!date) return raw(value)
  const current = new Date(now)
  const diff = now - date.getTime()
  if (diff >= 0 && diff < 60_000) return '刚刚'
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (isSameDay(date, current)) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  const yesterday = new Date(current.getTime())
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameDay(date, yesterday)) return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.getFullYear() === current.getFullYear()) {
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
  }
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** 千分位计数；万/亿按中文习惯缩写，供后台指标与图库计数使用。 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (absolute >= 100_000_000) return `${sign}${(absolute / 100_000_000).toFixed(1).replace(/\.0$/, '')} 亿`
  if (absolute >= 10_000) return `${sign}${(absolute / 10_000).toFixed(1).replace(/\.0$/, '')} 万`
  return `${sign}${Math.round(absolute).toLocaleString('en-US')}`
}

/** 字节数：十进制单位，与后端 `maxImageBytes` 等上限口径一致。 */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—'
  const trim = (text: string) => text.replace(/\.0$/, '')
  if (value < 1000) return `${Math.round(value)} B`
  const kilobytes = value / 1000
  if (kilobytes < 1000) return `${trim(kilobytes.toFixed(kilobytes < 100 ? 1 : 0))} KB`
  const megabytes = value / 1_000_000
  if (megabytes < 1000) return `${trim(megabytes.toFixed(megabytes < 100 ? 1 : 0))} MB`
  return `${trim((value / 1_000_000_000).toFixed(1))} GB`
}

/** 任务耗时 `MM:SS`，从 startedAt（缺失时 createdAt）起算。 */
export function formatElapsed(
  job: { startedAt?: string | null; createdAt?: string | null },
  now: number = Date.now(),
): string {
  const rawTime = job.startedAt || job.createdAt
  const started = rawTime ? Date.parse(rawTime) : NaN
  if (!Number.isFinite(started)) return '00:00'
  const total = Math.max(0, Math.floor((now - started) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds)}`
  }
  return `${pad(minutes)}:${pad(seconds)}`
}

/** 秒数 → `1:05` / `12 秒`；视频时长展示用。 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  if (total < 60) return `${total} 秒`
  return `${Math.floor(total / 60)}:${pad(total % 60)}`
}

export function truncateText(value: string | null | undefined, max = 40): string {
  if (!value) return ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}
