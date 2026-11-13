'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { colourTransition } from './interaction'
import { nextEnabledIndex, thumbGeometry } from './segmented-math'
import type { ThumbGeometry } from './segmented-math'
import { controlMinHeight, iconSlot, touchTarget } from './size'

export interface SegmentedControlItem<T extends string = string> {
  /** Wire value — the string that leaves this component and comes back as `value`. */
  value: T
  label: ReactNode
  /** Long-form explanation for hover / focus. */
  title?: string
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string = string> {
  items: SegmentedControlItem<T>[]
  /** Controlled selection: the value the group currently holds. */
  value: T | undefined
  onChange: (value: T) => void
  /** `md` = 40px targets (default), `sm` = 32px for dense toolbars. */
  size?: 'sm' | 'md'
  /** Stretch the track to the container and share width evenly. */
  fullWidth?: boolean
  /** Accessible name for the group. Give this or `labelledBy`. */
  label?: string
  labelledBy?: string
  className?: string
}

/** Layout effect that degrades to `useEffect` on the server (no SSR warning). */
const useSafeLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

const TRACK_CLASS = 'relative flex gap-1 rounded-control bg-tonal p-1'

const ITEM_SIZE = {
  sm: `${controlMinHeight.sm} ${touchTarget} px-3 text-xs`,
  md: `${controlMinHeight.md} ${touchTarget} px-3.5 text-sm`,
} as const

const ITEM_BASE = [
  'relative inline-flex min-w-0 shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap',
  'rounded-control font-medium',
  `${iconSlot.sm} [&>svg]:shrink-0`,
  colourTransition,
].join(' ')

/**
 * 分段控件——选择“值”，不是切换面板，所以是 `radiogroup` + `radio`（方向键即选中），
 * 而不是 `tablist`；`Tabs` 回答“我在看哪个面板”。
 *
 * 选中白块是一个可测量的独立元素，用 `.motion-position`（180ms / standard 缓动）平移，
 * 切换时滑动而不是瞬移。`ResizeObserver` 负责 resize 与文案变化后的重新测量；
 * reduced-motion 由 globals.css 把过渡归零。每个实例自己持有 ref 与测量状态，
 * 同屏多个分段控件互不干扰。
 */
export function SegmentedControl<T extends string = string>({
  items,
  value,
  onChange,
  size = 'md',
  fullWidth = false,
  label,
  labelledBy,
  className,
}: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const [thumb, setThumb] = useState<ThumbGeometry | null>(null)

  const enabledItems = items.filter((item) => !item.disabled)
  const selected = items.find((item) => item.value === value && !item.disabled)
  const checkedValue = selected?.value
  // 整组只有一个 Tab 停靠点；没有合法选中值时，第一个可用项作为漫游锚点。
  const rovingValue = checkedValue ?? enabledItems[0]?.value

  const measure = useCallback(() => {
    if (checkedValue === undefined) {
      setThumb(null)
      return
    }
    const node = itemRefs.current.get(checkedValue)
    if (!node) {
      setThumb(null)
      return
    }
    setThumb(thumbGeometry(node.offsetLeft, node.offsetWidth))
  }, [checkedValue])

  // 布局阶段测量：白块不会先在 (0,0) 闪一帧。
  useSafeLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(() => measure())
    observer.observe(track)
    for (const node of itemRefs.current.values()) {
      if (node) observer.observe(node)
    }
    return () => observer.disconnect()
  }, [measure, items.length])

  function select(item: SegmentedControlItem<T>) {
    if (item.disabled) return
    onChange(item.value)
    itemRefs.current.get(item.value)?.focus()
  }

  function moveFocus(fromValue: T, delta: number) {
    const currentIndex = enabledItems.findIndex((item) => item.value === fromValue)
    const next = nextEnabledIndex(
      enabledItems.map(() => true),
      currentIndex < 0 ? 0 : currentIndex,
      delta,
    )
    if (next < 0) return
    select(enabledItems[next])
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, item: SegmentedControlItem<T>) {
    if (item.disabled) return
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        moveFocus(item.value, 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        moveFocus(item.value, -1)
        break
      case 'Home':
        event.preventDefault()
        select(enabledItems[0])
        break
      case 'End':
        event.preventDefault()
        select(enabledItems[enabledItems.length - 1])
        break
      case 'Enter':
      case ' ':
        // Space 由原生按钮行为触发；`role=radio` 的 Enter 没有平台行为，补上。
        if (event.key === 'Enter') {
          event.preventDefault()
          select(item)
        }
        break
      default:
        break
    }
  }

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={cn(TRACK_CLASS, fullWidth && 'w-full', className)}
    >
      {thumb && checkedValue !== undefined ? (
        <span
          aria-hidden="true"
          className="motion-position pointer-events-none absolute inset-y-1 rounded-control bg-surface shadow-soft"
          style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }}
        />
      ) : null}

      {items.map((item) => {
        const checked = item.value === checkedValue
        return (
          <button
            key={item.value}
            ref={(node) => {
              itemRefs.current.set(item.value, node)
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            title={item.title}
            tabIndex={item.value === rovingValue ? 0 : -1}
            onClick={() => select(item)}
            onKeyDown={(event) => onKeyDown(event, item)}
            className={cn(
              ITEM_BASE,
              ITEM_SIZE[size],
              fullWidth && 'flex-1',
              checked
                ? 'text-foreground'
                : 'text-muted-foreground not-disabled:hover:text-foreground',
              item.disabled && 'is-disabled',
            )}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
