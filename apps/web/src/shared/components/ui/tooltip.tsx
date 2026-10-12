'use client'

import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { MOTION_FALLBACK_MS, readMotionMs } from '@/shared/lib/motion'

type TooltipSide = 'top' | 'bottom'

interface TooltipProps {
  /** Short explanation shown on hover AND focus. Interactive content belongs
   *  in a popover, not here. */
  content: ReactNode
  /** The focusable trigger. Hover, focus and Escape are observed on the wrapper,
   *  so a caller's own `onMouseEnter` / `onFocus` / … handlers are never replaced;
   *  only `aria-describedby` is added, and only while the tip is open. */
  children: ReactNode
  /** Preferred placement; the tip flips to the other side when this one would
   *  leave the viewport. */
  side?: TooltipSide
}

/** Gap between trigger and tip (`mb-2` / `mt-2`) and the safe viewport edge. */
const GAP = 8
const EDGE = 8
/** `--motion-fast`: the fade-in duration, applied in CSS. */
const FADE_DURATION = 'var(--motion-fast)'

/**
 * Dark 12px tip (`rounded-popover`, `bg-foreground` + `text-foreground-inverse`)
 * that opens from hover *and* keyboard focus, dismisses on Escape without moving
 * focus, and flips / clamps instead of running off the viewport edge.
 *
 * Mount-only: a hidden tooltip keeps no `aria-describedby` on the trigger, so
 * assistive tech never announces an empty description, and the tip is absent from
 * the accessibility tree until it is actually shown.
 */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  const id = useId()
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const tipRef = useRef<HTMLSpanElement | null>(null)
  const hideTimer = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<{ side: TooltipSide; dx: number }>({ side, dx: 0 })

  const show = () => {
    if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current)
    setOpen(true)
  }
  // Grace period (`--motion-fast`), so travelling from the trigger to the tip does
  // not dismiss it.
  const hide = () => {
    if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current)
    const graceMs = readMotionMs('--motion-fast', MOTION_FALLBACK_MS.fast)
    hideTimer.current = window.setTimeout(() => setOpen(false), graceMs)
  }
  const dismissNow = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation()
      if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current)
      setOpen(false)
    }
  }

  // A pending grace timer must not outlive the tip.
  useEffect(
    () => () => {
      if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current)
    },
    [],
  )

  // Corrected before paint: the tip mounts at its requested side and is measured
  // in the same frame, so a flip never shows up as a jump.
  useLayoutEffect(() => {
    if (!open) return
    const wrap = wrapRef.current
    const tip = tipRef.current
    if (!wrap || !tip) return
    const trigger = wrap.getBoundingClientRect()
    const { width, height } = tip.getBoundingClientRect()
    const flips =
      side === 'top'
        ? trigger.top - height - GAP < EDGE
        : trigger.bottom + height + GAP > window.innerHeight - EDGE
    const nextSide: TooltipSide = flips ? (side === 'top' ? 'bottom' : 'top') : side
    const centre = trigger.left + trigger.width / 2
    let dx = 0
    if (centre - width / 2 < EDGE) dx = EDGE - (centre - width / 2)
    else if (centre + width / 2 > window.innerWidth - EDGE) dx = window.innerWidth - EDGE - (centre + width / 2)
    setPlacement((prev) => (prev.side === nextSide && prev.dx === dx ? prev : { side: nextSide, dx }))
  }, [open, side])

  const existingDescribedBy = isValidElement(children)
    ? (children.props as { 'aria-describedby'?: string })['aria-describedby']
    : undefined
  const describedBy = existingDescribedBy ? `${existingDescribedBy} ${id}` : id

  const trigger =
    open && isValidElement(children)
      ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': describedBy })
      : children

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={dismissNow}
    >
      {trigger}
      {open ? (
        <span
          ref={tipRef}
          id={id}
          role="tooltip"
          onMouseEnter={show}
          onMouseLeave={hide}
          style={{ transform: `translateX(calc(-50% + ${placement.dx}px))`, animationDuration: FADE_DURATION }}
          className={cn(
            'pointer-events-auto absolute left-1/2 z-tooltip w-max max-w-xs rounded-popover bg-foreground',
            'px-2.5 py-1.5 text-xs text-foreground-inverse shadow-dropdown motion-fade-in',
            placement.side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  )
}
