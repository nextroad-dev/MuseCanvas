'use client'

import { cloneElement, isValidElement, useId, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

interface TooltipProps {
  /** Short explanation shown on hover AND focus. Interactive content belongs
   *  in a popover, not here. */
  content: ReactNode
  /** The focusable trigger. Receives the hover/focus/Esc handlers. */
  children: ReactElement<{ onFocus?: () => void; onBlur?: () => void; onMouseEnter?: () => void; onMouseLeave?: () => void; onKeyDown?: (e: React.KeyboardEvent) => void; 'aria-describedby'?: string }>
  /** Placement relative to the trigger. */
  side?: 'top' | 'bottom'
}

/**
 * Hover-only tooltips are unusable for keyboard and touch users, so the
 * trigger opens on focus as well; Escape dismisses without moving focus.
 * The tip is decorative-adjacent but wired with `aria-describedby` so the
 * explanation reaches assistive tech.
 */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  const id = useId()
  const [open, setOpen] = useState(false)

  if (!isValidElement(children)) return children

  const show = () => setOpen(true)
  const hide = () => setOpen(false)

  const trigger = cloneElement(children, {
    onFocus: show,
    onBlur: hide,
    onMouseEnter: show,
    onMouseLeave: hide,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        hide()
      }
      children.props.onKeyDown?.(event)
    },
    'aria-describedby': id,
  })

  const placement =
    side === 'top'
      ? 'bottom-full left-1/2 -translate-x-1/2 mb-2'
      : 'top-full left-1/2 -translate-x-1/2 mt-2'

  return (
    <span className="relative inline-flex">
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute z-tooltip whitespace-nowrap rounded-popover bg-foreground px-2.5 py-1.5 text-xs leading-[1.5] text-foreground-inverse shadow-md motion-hover-fade ${placement} ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {content}
      </span>
    </span>
  )
}
