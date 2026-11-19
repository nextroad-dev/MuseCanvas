import { CircleNotchIcon as Loader2 } from '@phosphor-icons/react/ssr'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { iconSize } from './size'

const sizeClass = {
  xs: iconSize.xs,
  sm: iconSize.sm,
  md: iconSize.md,
  lg: iconSize.lg,
} as const

export interface SpinnerProps {
  /** `sm` (16px) sits inside standard controls; `lg` is for page-level loading. */
  size?: keyof typeof sizeClass
  /** 给读屏的文字（如 `加载中`）。图形本身为装饰。 */
  label?: string
  /** Swap the glyph without changing the behaviour contract. */
  icon?: PhosphorIcon
  className?: string
}

/** 忙碌指示器：旋转走 `.motion-spin` token，不使用 Tailwind `animate-spin`。 */
export function Spinner({ size = 'sm', label, icon: Icon = Loader2, className }: SpinnerProps) {
  return (
    <>
      <Icon weight="bold" aria-hidden="true" className={cn('motion-spin shrink-0', sizeClass[size], className)} />
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  )
}
