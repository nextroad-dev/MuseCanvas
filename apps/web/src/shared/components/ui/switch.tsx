'use client'

import { cn } from '@/shared/lib/cn'
import { outlineHover } from './interaction'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Accessible name. Pair with a visible label via `aria-labelledby` when one exists. */
  'aria-label'?: string
  'aria-labelledby'?: string
  disabled?: boolean
  className?: string
}

/**
 * 开关控件：32px（`--control-sm`）× 56px 轨道 + 24px 滑块（内缩 3px + 1px 描边，精确居中），
 * 滑动行程 24px；滑块位移由 `.motion-position` 驱动。
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'inline-flex h-[var(--control-sm)] w-14 shrink-0 items-center rounded-pill border p-[3px] motion-press',
        checked
          ? 'border-primary bg-primary not-disabled:hover:border-primary-hover not-disabled:hover:bg-primary-hover not-disabled:active:bg-primary-active'
          : cn('border-border-control bg-tonal not-disabled:hover:bg-tonal-hover not-disabled:active:bg-tonal-active', outlineHover),
        disabled && 'is-disabled',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-6 items-center justify-center rounded-pill border motion-position',
          checked ? 'translate-x-6 border-transparent bg-on-primary' : 'border-border-control bg-surface',
        )}
      />
    </button>
  )
}
