/**
 * 读取 `globals.css` 里 `--motion-*` / `--ease-*` token 的运行时工具。
 *
 * JS 计时器必须与 CSS 动画使用同一个值，否则一旦在 globals.css 调整 token，
 * 卸载计时器就会和动画对不上。所有函数都只在 effect / 事件处理器里调用，
 * 会触碰 window / document，禁止在 SSR 渲染期间执行。
 */

const TIME_PATTERN = /^(-?\d*\.?\d+)(ms|s)$/

/** token 缺失时的兜底值，与 globals.css 的取值保持一致。 */
export const MOTION_FALLBACK_MS = {
  fast: 120,
  base: 180,
  slow: 240,
} as const

/** 退出计时器的兜底值（`--motion-exit` 的等价时间）。 */
export const MODAL_EXIT_MS = MOTION_FALLBACK_MS.fast

/** 动画结束事件的兜底余量：正常情况下 animationend 先到，计时器只在事件丢失时触发。 */
const BACKSTOP_SLACK_MS = 80

/** 把 CSS 时间（`120ms` / `1.5s`）解析成毫秒；无法解析时返回 null。 */
export function parseCssTimeMs(value: string): number | null {
  const match = TIME_PATTERN.exec(value.trim())
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  return match[2] === 's' ? amount * 1000 : amount
}

/**
 * 读取 `--motion-*` token 的毫秒值。SSR、token 未定义或值非法时返回 fallback。
 */
export function readMotionMs(token: string, fallback: number): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback
  try {
    const raw = window.getComputedStyle(document.documentElement).getPropertyValue(token)
    return parseCssTimeMs(raw) ?? fallback
  } catch {
    return fallback
  }
}

/** 兜底缓动与 `--ease-standard` 一致。 */
export const MOTION_FALLBACK_EASING = 'cubic-bezier(0.2, 0, 0, 1)'

/**
 * 读取 `--ease-*` token 的缓动字符串。SSR、token 缺失时返回 fallback。
 */
export function readMotionEasing(token: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback
  try {
    const raw = window.getComputedStyle(document.documentElement).getPropertyValue(token).trim()
    return raw || fallback
  } catch {
    return fallback
  }
}

/** 退出动画时长（所有退出都走 `--motion-exit`）。 */
export function exitDurationMs(): number {
  return readMotionMs('--motion-exit', MODAL_EXIT_MS)
}

/**
 * 退出兜底计时：退出时长 + 余量，保证 animationend 正常时先到，
 * 事件丢失时也能卸载。入参缺省时按当前退出 token 计算。
 */
export function exitBackstopMs(ms: number = exitDurationMs()): number {
  return (Number.isFinite(ms) ? ms : exitDurationMs()) + BACKSTOP_SLACK_MS
}
