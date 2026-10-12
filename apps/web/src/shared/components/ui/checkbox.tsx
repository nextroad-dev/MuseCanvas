'use client'

import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { colourTransition, focusRingPeer, peerOutlineHover } from './interaction'
import { controlMinHeight, controlSquare } from './size'

export interface CheckboxProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Visible clickable text. Omit for a standalone circle (icon tiles, table rows). */
  label?: ReactNode
  'aria-label'?: string
  disabled?: boolean
  /** Half-selected parent (a "select all" header over a partial batch).
   *  Renders a centered horizontal dash (-) per Jude-Frontweb v22. */
  indeterminate?: boolean
  className?: string
  id?: string
  name?: string
  value?: string
}

/**
 * Jude-Frontweb v22 Circular Checkbox:
 * - 16px circular outline (`h-4 w-4 rounded-checkbox`, 50%).
 * - Unchecked: `bg-surface border border-border-control`, hover deepens border to foreground.
 * - Checked: Solid filled circle (●, `bg-primary border-primary`, no checkmark ✓, no hollow center).
 * - Indeterminate: Centered horizontal dash (-) in `bg-on-primary`.
 * - Hit target: 40px (`--control-md`) via comfortable label padding.
 * - Native keyboard accessibility: Space to toggle, focus-visible outline on keyboard focus.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  indeterminate = false,
  className,
  id: customId,
  'aria-label': ariaLabel,
  name,
  value,
  ...rest
}: CheckboxProps) {
  const generatedId = useId()
  const id = customId ?? (label ? generatedId : undefined)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = Boolean(indeterminate)
    }
  }, [indeterminate])

  const visualCircle = (
    <span
      aria-hidden="true"
      className={cn(
        'relative flex h-4 w-4 shrink-0 items-center justify-center rounded-checkbox border',
        colourTransition,
        focusRingPeer,
        indeterminate || checked
          ? 'border-primary bg-primary text-on-primary'
          : cn('border-border-control bg-surface', !disabled && peerOutlineHover),
      )}
    >
      {indeterminate ? (
        <span className="h-[2px] w-2 rounded-pill bg-on-primary" />
      ) : null}
    </span>
  )

  const nativeInput = (
    <input
      ref={inputRef}
      id={id}
      type="checkbox"
      name={name}
      value={value}
      checked={checked}
      disabled={disabled}
      aria-label={label ? undefined : ariaLabel}
      onChange={(event) => onCheckedChange(event.target.checked)}
      className="sr-only peer"
      {...rest}
    />
  )

  if (!label) {
    return (
      <label
        htmlFor={id}
        className={cn(
          'group inline-flex select-none items-center justify-center rounded-control',
          controlSquare.md,
          disabled ? 'is-disabled' : 'cursor-pointer',
          className,
        )}
      >
        {nativeInput}
        {visualCircle}
      </label>
    )
  }

  return (
    <label
      htmlFor={id}
      className={cn(
        'group inline-flex select-none items-center gap-2.5 text-sm text-foreground',
        controlMinHeight.md,
        disabled ? 'is-disabled' : 'cursor-pointer',
        className,
      )}
    >
      {nativeInput}
      {visualCircle}
      <span>{label}</span>
    </label>
  )
}
