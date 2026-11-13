'use client'

import { cn } from '@/shared/lib/cn'
import { outlineHover } from './interaction'
import { controlSquare } from './size'

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
 * 轨道 32px（`--control-sm`）× 56px、滑块 24px（`--control-xs`）内缩 3px，滑动距离
 * 恰好 24px。开态保持墨色填充、关态保留 `border-control` 描边——状态不靠明暗差
 * 单独辨认。原生 `<button role="switch">` 免费提供 Enter/Space，滑块位移走
 * `.motion-position`（base 时长 / standard 缓动）。
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
          'flex items-center justify-center rounded-pill border motion-position',
          controlSquare.xs,
          checked ? 'translate-x-6 border-transparent bg-on-primary' : 'border-border-control bg-surface',
        )}
      />
    </button>
  )
}
