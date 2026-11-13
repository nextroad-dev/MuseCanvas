/**
 * Pure pagination maths, split out from the component so `node --test` can cover
 * the edge cases (1 page, first/last page windows, truncation) without a DOM.
 */

export type PageItem = { kind: 'page'; page: number } | { kind: 'gap'; key: string }

/**
 * First page, last page, a window of `siblingCount` around the current page, and a
 * `…` wherever numbers were skipped.
 */
export function buildPageItems(page: number, pageCount: number, siblingCount = 1): PageItem[] {
  const safePageCount = Math.max(1, Math.floor(pageCount) || 1)
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), safePageCount)
  const siblings = Math.max(0, Math.floor(siblingCount))
  const pages = new Set<number>([1, safePageCount])
  for (let offset = siblings; offset >= -siblings; offset -= 1) {
    const candidate = safePage + offset
    if (candidate >= 1 && candidate <= safePageCount) pages.add(candidate)
  }
  const sorted = [...pages].sort((a, b) => a - b)
  const items: PageItem[] = []
  sorted.forEach((value, index) => {
    const previous = sorted[index - 1]
    if (previous !== undefined && value - previous > 1) items.push({ kind: 'gap', key: `gap-${previous}-${value}` })
    items.push({ kind: 'page', page: value })
  })
  return items
}

/** `第 21–40 条，共 128 条` — the count line shared by page and cursor modes. */
export function describeRange(page: number, pageSize: number, total: number): string {
  if (total <= 0) return '共 0 条'
  const safeSize = Math.max(1, Math.floor(pageSize) || 1)
  const from = Math.min(total, Math.max(1, (Math.max(1, page) - 1) * safeSize + 1))
  const to = Math.min(total, from + safeSize - 1)
  return `第 ${from}–${to} 条，共 ${total} 条`
}

/** Clamp a requested page into `[1, pageCount]`; cursor mode never calls this. */
export function clampPage(page: number, pageCount: number): number {
  const max = Math.max(1, Math.floor(pageCount) || 1)
  return Math.min(Math.max(1, Math.floor(page) || 1), max)
}
