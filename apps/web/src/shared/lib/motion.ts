/**
 * Runtime readers for the `--motion-*` tokens in `app/globals.css`.
 *
 * A JS timer that has to line up with a CSS animation reads the token instead of
 * keeping a hand-typed copy of it, so retuning `--motion-exit` in globals.css
 * retunes the unmount timers too. Always call these from an effect or an event
 * handler: they touch `window`/`document` and must not run during SSR.
 */

const TIME_PATTERN = /^(-?\d*\.?\d+)(ms|s)$/

/** Fallbacks mirror the token values, so a missing stylesheet still gets a sane timer. */
export const MOTION_FALLBACK_MS = {
  fast: 120,
  base: 180,
  slow: 240,
} as const

/** Extra time a backstop timer waits past the exit, so the native `animationend`
 *  normally wins and the timer only fires when that event never arrives. */
const BACKSTOP_SLACK_MS = 80

/** Parses a plain CSS time (`120ms`, `1.5s`) to milliseconds, or `null`. */
export function parseCssTimeMs(value: string): number | null {
  const match = TIME_PATTERN.exec(value.trim())
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  return match[2] === 's' ? amount * 1000 : amount
}

/**
 * Milliseconds of a `--motion-*` token as computed on the document root. Returns
 * `fallbackMs` when there is no document, the token is not defined, or its value is
 * not a plain time.
 */
export function readMotionMs(token: `--${string}`, fallbackMs: number): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallbackMs
  try {
    const raw = window.getComputedStyle(document.documentElement).getPropertyValue(token)
    return parseCssTimeMs(raw) ?? fallbackMs
  } catch {
    return fallbackMs
  }
}

/** Teardown time of every exit animation (`--motion-exit`). */
export function exitDurationMs(): number {
  return readMotionMs('--motion-exit', MOTION_FALLBACK_MS.fast)
}

/** Backstop for an exit: the exit duration plus slack. Never shorter than the exit. */
export function exitBackstopMs(): number {
  return exitDurationMs() + BACKSTOP_SLACK_MS
}
