'use client'

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { MOTION_FALLBACK_EASING, MOTION_FALLBACK_MS, readMotionEasing, readMotionMs } from '@/shared/lib/motion'
import {
  planFlipDeltas,
  prefersReducedMotion,
  type FlipPoint,
} from '@/shared/lib/flip'

/**
 * FLIP list-reorder animation (plan §3.2). No `motion` dependency: only the Web
 * Animations API plus the `--motion-*` / `--ease-*` tokens.
 *
 * Contract for callers (toast stack, task rows, reference grid):
 * - Put `data-flip-key="<stable id>"` on the **outer wrapper** of each item. A
 *   CSS keyframe (`.motion-toast-in`, `.motion-fade-out`, …) must stay on an
 *   *inner* element: WAAPI and CSS keyframes both drive `transform`, and the
 *   CSS animation wins the conflict, so sharing one node would swallow the FLIP.
 * - `orderKey` is the only measurement trigger (e.g.
 *   `rows.map((r) => r.id).join()`). Timer re-renders (job polling, countdowns)
 *   must not change it, or every tick would re-measure and re-animate.
 * - Positions are measured relative to the container, so a scrollable list does
 *   not mistake a scroll offset for a reorder.
 * - `prefers-reduced-motion: reduce` skips the animation entirely (the CSS side
 *   already zeroes keyframes globally; JS has to opt out itself).
 *
 * The diff math (`computeFlipDelta` / `runFlipTransitions`) lives in the
 * import-free `shared/lib/flip.ts` so `node --test` can cover it directly.
 */

export interface UseFlipListOptions {
  /** Child selector carrying `data-flip-key`. Defaults to `'[data-flip-key]'`. */
  itemSelector?: string
  /** Duration token. Defaults to `'--motion-base'`. */
  durationToken?: `--${string}`
  /** Easing token. Defaults to `'--ease-standard'`. */
  easingToken?: `--${string}`
}

// `useLayoutEffect` warns on SSR prerenders; the isomorphic alias keeps the
// measurement before paint on the client without tripping the server warning.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Animate a reordered list with FLIP. See the module docstring for the caller
 * contract. Only `orderKey` changes trigger a measurement pass.
 */
export function useFlipList<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  orderKey: string,
  options?: UseFlipListOptions,
): void {
  const prevRef = useRef<Map<string, FlipPoint>>(new Map())
  const selector = options?.itemSelector ?? '[data-flip-key]'
  const durationToken = options?.durationToken ?? '--motion-base'
  const easingToken = options?.easingToken ?? '--ease-standard'

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const elements = Array.from(container.querySelectorAll(selector)) as HTMLElement[]
    const containerRect = container.getBoundingClientRect()
    const current = new Map<string, FlipPoint>()
    for (const el of elements) {
      const key = el.getAttribute('data-flip-key')
      if (!key) continue
      const rect = el.getBoundingClientRect()
      current.set(key, { left: rect.left - containerRect.left, top: rect.top - containerRect.top })
    }
    const prev = prevRef.current
    prevRef.current = current
    // Reduced motion short-circuits everything: no `animate` call is made. The
    // CSS side already zeroes keyframes globally; JS has to opt out itself.
    if (prefersReducedMotion()) return

    const planned = planFlipDeltas(
      elements
        .map((el) => {
          const key = el.getAttribute('data-flip-key')
          if (!key) return null
          const curr = current.get(key)
          if (!curr) return null
          return { key, prev: prev.get(key), curr }
        })
        .filter((entry): entry is { key: string; prev: FlipPoint | undefined; curr: FlipPoint } => entry !== null),
    )
    if (planned.length === 0) return
    const duration = readMotionMs(durationToken, MOTION_FALLBACK_MS.base)
    const easing = readMotionEasing(easingToken, MOTION_FALLBACK_EASING)
    const byKey = new Map(elements.map((el) => [el.getAttribute('data-flip-key'), el]))
    for (const { key, dx, dy } of planned) {
      byKey.get(key)?.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration, easing },
      )
    }
    // orderKey is the only intended trigger; options are tokens/selectors, not per-render values.
  }, [containerRef, orderKey])
}
