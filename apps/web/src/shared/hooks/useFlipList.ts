'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * FLIP 列表重排动画（WAAPI + token，不引入 motion 依赖）。
 *
 * 调用约定：
 * - 列表项**外层**挂 `data-flip-key="<稳定 id>"`；CSS 入场动画（`.motion-*`）
 *   必须放在内层节点，因为 WAAPI 与 CSS 动画都写 transform，同节点会被覆盖。
 * - `orderKey` 是唯一测量触发器（例如 `rows.map((r) => r.id).join()`）；
 *   计时器/轮询重渲染不应改变它，否则每次 tick 都会重新测量并动画。
 * - 坐标相对容器测量，可滚动列表不会把滚动位移误判成重排。
 * - `prefers-reduced-motion: reduce` 直接跳过动画（CSS 侧的全站归零管不到 WAAPI）。
 *
 * 纯计算（矩形 → dx/dy、计划哪些项需要动画）从这里导出，`useFlipList.test.mjs`
 * 可以直接用 `node --test` 覆盖。为了让 Node 原生类型剥离能解析本模块，
 * token 读取函数内联在此（Node 不做无后缀相对导入解析）。
 */

export interface FlipPoint {
  left: number
  top: number
}

export interface FlipDelta {
  dx: number
  dy: number
}

/** 把元素从旧位置搬到新位置所需的位移。 */
export function computeFlipDelta(prev: FlipPoint, curr: FlipPoint): FlipDelta {
  return { dx: prev.left - curr.left, dy: prev.top - curr.top }
}

/** 用户是否要求减少动效；SSR 安全（默认 false）。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export interface FlipInput {
  /** 稳定的 `data-flip-key`。 */
  key: string
  /** 上一次 orderKey 时的位置；首次渲染 / 新项为 undefined。 */
  prev: FlipPoint | undefined
  curr: FlipPoint
}

export interface FlipPlan {
  key: string
  dx: number
  dy: number
}

/**
 * 哪些项需要 WAAPI 位移、位移多少。没有旧位置（首次 / 新增）或位移为零的项
 * 不产生条目，因此顺序没变时 hook 不会发起任何动画。
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

const TIME_PATTERN = /^(-?\d*\.?\d+)(ms|s)$/

/** 与 `shared/lib/motion` 相同的解析规则（此处内联以保持本模块可被单测直接导入）。 */
function readMotionMs(token: string, fallback: number): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback
  try {
    const match = TIME_PATTERN.exec(window.getComputedStyle(document.documentElement).getPropertyValue(token).trim())
    if (!match) return fallback
    const amount = Number(match[1])
    if (!Number.isFinite(amount)) return fallback
    return match[2] === 's' ? amount * 1000 : amount
  } catch {
    return fallback
  }
}

const FALLBACK_EASING =
  'linear(0, 0.061, 0.1928, 0.3446, 0.4895, 0.6153, 0.7182, 0.7987, 0.8596, 0.9045, 0.9366, 0.959, 0.9744, 0.9846, 0.9912, 0.9954, 1)'

/** 与 `shared/lib/motion` 相同的缓动读取规则。 */
function readMotionEasing(token: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback
  try {
    const raw = window.getComputedStyle(document.documentElement).getPropertyValue(token).trim()
    return raw || fallback
  } catch {
    return fallback
  }
}

export interface UseFlipListOptions {
  /** 子元素选择器，默认 `'[data-flip-key]'`。 */
  itemSelector?: string
  /** 时长 token，默认 `'--motion-spring-gentle'`。 */
  durationToken?: string
  /** 缓动 token，默认 `'--ease-spring-gentle'`。 */
  easingToken?: string
}

// useLayoutEffect 在 SSR 预渲染时会告警；同构别名让浏览器端仍在绘制前测量。
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * 让 orderKey 变化后的列表重排平滑过渡。回调/选项都只读不写 DOM 结构，
 * 测量与动画都在 layout effect 内完成（避免先绘制旧位置再跳变）。
 * 支持中断：快速连点重新触发时先取消旧动画，再从当前位置平滑过渡。
 */
export function useFlipList<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  orderKey: string,
  options?: UseFlipListOptions,
): void {
  const previousPoints = useRef<Map<string, FlipPoint>>(new Map())
  const activeAnimations = useRef<WeakMap<HTMLElement, Animation>>(new WeakMap())
  const itemSelector = options?.itemSelector ?? '[data-flip-key]'
  const durationToken = options?.durationToken ?? '--motion-spring-gentle'
  const easingToken = options?.easingToken ?? '--ease-spring-gentle'

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const elements = Array.from(container.querySelectorAll<HTMLElement>(itemSelector))
    // 若上一段重排动画尚未播完，先记录当前视觉位置之前取消旧动画，避免与新布局叠加。
    for (const element of elements) {
      const running = activeAnimations.current.get(element)
      if (running) {
        running.cancel()
        activeAnimations.current.delete(element)
      }
    }

    const containerRect = container.getBoundingClientRect()
    const current = new Map<string, FlipPoint>()
    for (const element of elements) {
      const key = element.getAttribute('data-flip-key')
      if (!key) continue
      const rect = element.getBoundingClientRect()
      current.set(key, {
        left: rect.left - containerRect.left,
        top: rect.top - containerRect.top,
      })
    }

    const previous = previousPoints.current
    previousPoints.current = current
    // 减少动效：先记录位置再短路，顺序保持准确，但绝不调用 animate。
    if (prefersReducedMotion()) return

    const planned = planFlipDeltas(
      elements.flatMap((element) => {
        const key = element.getAttribute('data-flip-key')
        if (!key) return []
        const curr = current.get(key)
        if (!curr) return []
        return [{ key, prev: previous.get(key), curr }]
      }),
    )
    if (planned.length === 0) return

    const duration = readMotionMs(durationToken, 300)
    const easing = readMotionEasing(easingToken, FALLBACK_EASING)
    const byKey = new Map<string, HTMLElement>()
    for (const element of elements) {
      const key = element.getAttribute('data-flip-key')
      if (key) byKey.set(key, element)
    }

    for (const { key, dx, dy } of planned) {
      const target = byKey.get(key)
      if (!target) continue
      const anim = target.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration, easing },
      )
      activeAnimations.current.set(target, anim)
    }
  }, [containerRef, orderKey, itemSelector, durationToken, easingToken])
}
