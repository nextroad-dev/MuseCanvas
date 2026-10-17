/**
 * Pure FLIP math for `shared/hooks/useFlipList.ts`.
 *
 * This module has no imports (not even React), so `node --test` can import it
 * directly. The hook itself lives in `useFlipList.ts` and owns DOM measurement,
 * the `--motion-*` / `--ease-*` token reads, and the single `el.animate` call
 * site (enforced by `scripts/check-web-tokens.mjs` rule I).
 */

export interface FlipPoint {
  left: number
  top: number
}

export interface FlipDelta {
  dx: number
  dy: number
}

/** Container-relative translate needed to move an element from `prev` to `curr`. */
export function computeFlipDelta(prev: FlipPoint, curr: FlipPoint): FlipDelta {
  return { dx: prev.left - curr.left, dy: prev.top - curr.top }
}

/** True when the user asked for reduced motion. SSR-safe (defaults to false). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export interface FlipInput {
  /** Stable `data-flip-key` of the item. */
  key: string
  /** Position at the previous `orderKey`; absent on the first run / new items. */
  prev: FlipPoint | undefined
  curr: FlipPoint
}

export interface FlipPlan {
  key: string
  dx: number
  dy: number
}

/**
 * Which items need a WAAPI translate, and by how much. Items without a previous
 * position (first run, newly added) and items whose delta is zero (orderKey
 * unchanged in effect) produce no entry, so the hook animates nothing for them.
 */
export function planFlipDeltas(items: FlipInput[]): FlipPlan[] {
  const planned: FlipPlan[] = []
  for (const { key, prev, curr } of items) {
    if (!prev) continue
    const { dx, dy } = computeFlipDelta(prev, curr)
    if (dx === 0 && dy === 0) continue
    planned.push({ key, dx, dy })
  }
  return planned
}
