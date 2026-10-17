import { CircleNotchIcon as Loader2 } from '@phosphor-icons/react/ssr'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { iconSize } from './size'

/** Icon sizes from `--icon-*` (icons.md §3): the spinner never invents a size. */
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
   * Text for assistive tech (`加载中`). The glyph itself is always decorative
   * per icons.md §1, so a busy state is announced through this text or through
   * `aria-busy` on the owning control — never through the icon.
   */
  label?: string
  /** Swap the glyph for another loader without changing the behaviour contract. */
  icon?: PhosphorIcon
  className?: string
}

/**
 * Busy indicator. Rotation comes from `.motion-spin` (600ms linear, globals.css)
 * rather than Tailwind's `animate-spin`, so the duration stays a token and
 * reduced-motion turns it into a static glyph while the state stays legible.
 */
export function Spinner({ size = 'sm', label, icon: Icon = Loader2, className }: SpinnerProps) {
  return (
    <>
      <Icon weight="bold" aria-hidden="true" className={cn('motion-spin shrink-0', sizeClass[size], className)} />
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  )
}
