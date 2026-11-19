'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { colourTransition } from './interaction'
import { nextEnabledIndex, thumbGeometry } from './segmented-math'
import type { ThumbGeometry } from './segmented-math'
import { controlMinHeight, iconSlot, touchTarget } from './size'

export interface SegmentedControlItem<T extends string = string> {
  value: T
  label: ReactNode
  title?: string
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string = string> {
  items: SegmentedControlItem<T>[]
  value: T | undefined
  onChange: (value: T) => void
  /** `md` = 36px targets (default), `sm` = 32px for dense toolbars. */
  size?: 'sm' | 'md'
  /** Stretch the track to the container and share width evenly. */
  fullWidth?: boolean
  /** Accessible name for the group. Give this or `labelledBy`. */
  label?: string
  labelledBy?: string
  className?: string
}

const useSafeLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

const TRACK_CLASS = 'relative inline-flex gap-1 rounded-control border border-border/70 bg-tonal p-1'

const ITEM_SIZE = {
  sm: `${controlMinHeight.xs} ${touchTarget} px-2.5 text-xs`,
  md: `${controlMinHeight.sm} ${touchTarget} px-3 text-ui`,
} as const

const ITEM_BASE = [
  'relative inline-flex min-w-0 shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap',
  'rounded-control font-medium',
  `${iconSlot.sm} [&>svg]:shrink-0`,
  colourTransition,
].join(' ')

/**
 * 分段控件（radiogroup + radio）：选中值滑块由 `.motion-position` 弹簧驱动。
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
        event.preventDefault()
        select(item)
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
      className={cn(TRACK_CLASS, fullWidth && 'flex w-full', className)}
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
              checked ? 'text-foreground' : 'text-muted-foreground not-disabled:hover:text-foreground',
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
