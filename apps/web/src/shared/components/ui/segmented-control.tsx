'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { colourTransition } from './interaction'
import { controlMinHeight, iconSlot } from './size'

export interface SegmentedControlItem<T extends string = string> {
  /** Wire value — the string that leaves this component and comes back as `value`. */
  value: T
  label: ReactNode
  /** Long-form explanation for hover / focus, e.g. what an aspect ratio costs. */
  title?: string
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string = string> {
  items: SegmentedControlItem<T>[]
  /** Controlled selection: the value the group currently holds. */
  value: T | undefined
  onChange: (value: T) => void
  /** `md` = 40px hit targets, `sm` = 32px for dense toolbars. Labels stay 14/12px. */
  size?: 'sm' | 'md'
  /** Accessible name for the group. Give this or `labelledBy`, never neither. */
  label?: string
  labelledBy?: string
  className?: string
}

const TRACK_CLASS = 'relative flex gap-1 rounded-control bg-tonal p-1'

const RADIO_SIZE = {
  sm: `${controlMinHeight.sm} px-3 text-xs`,
  md: `${controlMinHeight.md} px-3 text-sm`,
} as const

const RADIO_BASE = [
  'relative inline-flex shrink-0 select-none items-center justify-center gap-1 whitespace-nowrap',
  'rounded-control font-medium',
  `${iconSlot.sm} [&>svg]:shrink-0`,
  colourTransition,
].join(' ')

/**
 * Tonal segmented control — the choice of a *value*, not of a panel. It is
 * therefore a `radiogroup` of `radio`s (aria-checked + arrow keys), never a
 * `tablist`: `Tabs` answers "which panel am I looking at", this answers "what
 * does the request say". Components.md Tabs row keeps the shared track look; the
 * current segment is a white `surface` thumb on the tonal track (design mock). The
 * brand green is reserved for the logo and for status graphics.
 *
 * The selected surface is a single measured element that travels on
 * `.motion-position`, so changing a value glides instead of teleporting, and the
 * re-measure on resize keeps it honest when a label wraps or a font lands late.
 */
export function SegmentedControl<T extends string = string>({
  items,
  value,
  onChange,
  size = 'md',
  label,
  labelledBy,
  className,
}: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const radioRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)

  const enabled = items.filter((item) => !item.disabled)
  const checkedValue = items.some((item) => item.value === value) ? value : undefined
  // One tab stop for the whole group; arrows roam inside it. When no value is selected,
  // the first enabled item serves as the roving focus anchor.
  const rovingValue = checkedValue !== undefined
    ? (items.find((item) => item.value === checkedValue)?.disabled ? enabled[0]?.value : checkedValue)
    : enabled[0]?.value

  const measure = useCallback(() => {
    if (checkedValue === undefined) return setThumb(null)
    const node = radioRefs.current.get(checkedValue)
    if (!node) return setThumb(null)
    setThumb({ left: node.offsetLeft, width: node.offsetWidth })
  }, [checkedValue])

  useEffect(() => {
    measure()
    const track = trackRef.current
    if (!track || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(track)
    return () => observer.disconnect()
  }, [measure])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  function select(item: SegmentedControlItem<T>) {
    if (item.disabled) return
    onChange(item.value)
    radioRefs.current.get(item.value)?.focus()
  }

  /** Radio groups select as they are arrowed (APG `automatic`): no separate commit. */
  function moveFocus(from: number, delta: number) {
    if (enabled.length === 0) return
    const next = (from + delta + enabled.length) % enabled.length
    select(enabled[next])
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, item: SegmentedControlItem<T>) {
    if (item.disabled) return
    const index = enabled.findIndex((candidate) => candidate.value === item.value)
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        moveFocus(index, 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        moveFocus(index, -1)
        break
      case 'Home':
        event.preventDefault()
        moveFocus(-1, 1)
        break
      case 'End':
        event.preventDefault()
        moveFocus(enabled.length - 2, 1)
        break
      case 'Enter':
      case ' ':
        // Already selected via the native click for Space; Enter on a `role=radio`
        // button has no platform behaviour, so give it the same outcome.
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
      className={cn(TRACK_CLASS, className)}
    >
      {thumb && checkedValue !== undefined ? (
        // `offsetLeft` and an absolutely positioned child share the track's inner
        // border edge as origin, so the measured number is the travel distance —
        // the same arithmetic `Tabs` uses for its underline.
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
              radioRefs.current.set(item.value, node)
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
              RADIO_BASE,
              RADIO_SIZE[size],
              checked
                ? 'text-foreground'
                : 'text-muted-foreground not-disabled:hover:bg-tonal-hover not-disabled:hover:text-foreground not-disabled:active:bg-tonal-active',
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
