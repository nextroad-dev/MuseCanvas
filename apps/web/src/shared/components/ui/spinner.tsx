import { CircleNotchIcon as Loader2 } from '@phosphor-icons/react/ssr'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { iconSize } from './size'

/** Icon sizes from `--icon-*`: the spinner never invents a size. */
const sizeClass = {
  xs: iconSize.xs,
  sm: iconSize.sm,
  md: iconSize.md,
  lg: iconSize.lg,
} as const

export interface SpinnerProps {
  /** `sm` (16px) sits inside a 40px control; `lg` is for page-level loading. */
  size?: keyof typeof sizeClass
  /**
   * 给读屏的文字（`加载中`）。图形永远是装饰，忙碌状态靠这段文字或所属控件的
   * `aria-busy` 播报。
   */
  label?: string
  /** Swap the glyph without changing the behaviour contract. */
  icon?: PhosphorIcon
  className?: string
}

/**
 * 忙碌指示器。旋转来自 `.motion-spin`（globals.css 里的 token 时长），不用 Tailwind
 * 的 `animate-spin`；reduced-motion 下变成静止图形，状态仍然可读。
 */
export function Spinner({ size = 'sm', label, icon: Icon = Loader2, className }: SpinnerProps) {
  return (
    <>
      <Icon weight="bold" aria-hidden="true" className={cn('motion-spin shrink-0', sizeClass[size], className)} />
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  )
}
