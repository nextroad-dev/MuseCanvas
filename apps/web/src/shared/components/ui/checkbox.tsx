'use client'

import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { CheckIcon as Check, MinusIcon as Minus } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { colourTransition, focusRingPeer, peerOutlineHover } from './interaction'
import { controlMinHeight, controlSquare, iconSize, touchTarget, touchTargetSquare } from './size'

export interface CheckboxProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Visible clickable text. Omit for a standalone control (tiles, table rows). */
  label?: ReactNode
  /** Accessible name when there is no visible `label`. */
  'aria-label'?: string
  disabled?: boolean
  /** Half-selected parent of a partial batch; renders a centred dash. */
  indeterminate?: boolean
  className?: string
  id?: string
  name?: string
  value?: string
}

/**
 * 圆形复选框（`--radius-checkbox`）：16px 描边，选中实心，部分选中显示横杠。
 * 原生隐藏 `peer` 输入保证真实焦点与 Space 切换，键盘环由 `focusRingPeer` 映射到视觉圆。
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
}: CheckboxProps) {
  const generatedId = useId()
  const id = customId ?? (label ? generatedId : undefined)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = Boolean(indeterminate)
  }, [indeterminate])

  const visual = (
    <span
      aria-hidden="true"
      className={cn(
        'relative flex size-4 shrink-0 items-center justify-center rounded-checkbox border',
        colourTransition,
        focusRingPeer,
        indeterminate || checked
          ? 'border-primary bg-primary text-on-primary'
          : cn('border-border-control bg-surface', !disabled && peerOutlineHover),
      )}
    >
      {indeterminate ? (
        <Minus weight="bold" aria-hidden="true" className={cn(iconSize.xs, 'motion-check-pop')} />
      ) : checked ? (
        <Check weight="bold" aria-hidden="true" className={cn(iconSize.xs, 'motion-check-pop')} />
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
      className="peer sr-only"
    />
  )

  if (!label) {
    return (
      <label
        htmlFor={id}
        className={cn(
          'group inline-flex select-none items-center justify-center rounded-control',
          controlSquare.md,
          touchTargetSquare,
          disabled ? 'is-disabled' : 'cursor-pointer',
          className,
        )}
      >
        {nativeInput}
        {visual}
      </label>
    )
  }

  return (
    <label
      htmlFor={id}
      className={cn(
        'group inline-flex select-none items-center gap-2.5 text-sm text-foreground',
        controlMinHeight.md,
        touchTarget,
        disabled ? 'is-disabled' : 'cursor-pointer',
        className,
      )}
    >
      {nativeInput}
      {visual}
      <span>{label}</span>
    </label>
  )
}
