/**
 * Display formatting for values the API has already validated.
 *
 * Only the *presentation* of a value lives here — never parsing, validation or
 * business rules. Collecting it in one module is what stops each view from picking
 * its own locale: before this file `account-view`, `library-view` and
 * `asset-lightbox` each carried a private `formatDate`, and `library-view`'s own
 * comment said why it could not share one ("shared/lib has no date formatter to
 * reuse"). Now it does.
 *
 * There are two formats in the app, and the names say which is which:
 *
 *  · `formatDate` / `formatDateTime` — the design system's format (copy.md §9):
 *    `YYYY-MM-DD` and `YYYY-MM-DD HH:mm`, 24-hour. This is the default; reach for
 *    it unless a screen needs a full machine-style timestamp.
 *  · `formatLocalizedDate` / `formatLocalizedDateTime` — the `zh-CN` locale
 *    rendering. The admin tables show a complete timestamp including seconds, so
 *    they use these rather than the shorter spec form.
 *
 * Both fall back instead of rendering `NaN`: a missing value shows `—`, and an
 * unparseable one is passed through as-is so a bad payload is visible rather than
 * silently blanked.
 */

const SPEC_LOCALE_PAD = 2

function pad(part: number): string {
  return String(part).padStart(SPEC_LOCALE_PAD, '0')
}

/** Parse, or `null` for anything that is not a usable date. */
function parse(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Whatever the caller passed, rendered as text, for the pass-through fallback. */
function raw(value: string | number | Date | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value)
}

/** `YYYY-MM-DD` (copy.md §9). */
export function formatDate(value: string | number | Date | null | undefined): string {
  const date = parse(value)
  if (!date) return raw(value)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `YYYY-MM-DD HH:mm` (copy.md §9): the spec's date format with 24-hour time. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = parse(value)
  if (!date) return raw(value)
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Locale-rendered date, e.g. `2026/10/5`.
 *
 * The locale is pinned rather than read from the browser: the console is a
 * single-locale product surface, and a date must not re-shape itself because an
 * operator's machine is set to another region.
 */
export function formatLocalizedDate(value: string | number | Date | null | undefined): string {
  const date = parse(value)
  if (!date) return raw(value)
  return date.toLocaleDateString('zh-CN')
}

/** Locale-rendered date and time, e.g. `2026/10/5 18:47:22`. */
export function formatLocalizedDateTime(value: string | number | Date | null | undefined): string {
  const date = parse(value)
  if (!date) return raw(value)
  return date.toLocaleString('zh-CN')
}
