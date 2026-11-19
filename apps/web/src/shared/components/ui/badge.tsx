import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/shared/lib/cn'
import { iconSlot } from './size'

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent'
export type BadgeVariant = 'soft' | 'solid' | 'outline'

/**
 * 徽标 / 状态胶囊：胶囊形、12px/500，状态色始终伴随文字。
 */
const badgeClasses: Record<BadgeVariant, Record<BadgeTone, string>> = {
  soft: {
    neutral: 'bg-neutral-soft text-neutral-status',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
    info: 'bg-info-soft text-info',
    accent: 'bg-accent-soft text-accent-strong',
  },
  solid: {
    neutral: 'bg-primary text-on-primary',
    success: 'bg-success text-on-primary',
    warning: 'bg-warning text-on-primary',
    danger: 'bg-danger text-on-danger',
    info: 'bg-info text-on-primary',
    accent: 'bg-accent text-on-primary',
  },
  outline: {
    neutral: 'border border-border-control text-foreground',
    success: 'border border-success-border text-success',
    warning: 'border border-warning-border text-warning',
    danger: 'border border-danger-border text-danger',
    info: 'border border-info-border text-info',
    accent: 'border border-accent text-accent',
  },
}

const dotClasses: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-status',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent',
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  variant?: BadgeVariant
  /** Optional leading icon; decorative unless it is the whole message. */
  icon?: ReactNode
  /** 6px status dot before the label, for a state that should be scannable. */
  dot?: boolean
  ref?: Ref<HTMLSpanElement>
}

export function Badge({
  tone = 'neutral',
  variant = 'soft',
  icon,
  dot,
  className,
  ref,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex min-h-5 max-w-full items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-medium',
        badgeClasses[variant][tone],
        className,
      )}
      {...rest}
    >
      {dot ? <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-pill', dotClasses[tone])} /> : null}
      {icon ? (
        <span aria-hidden="true" className={cn('inline-flex shrink-0', iconSlot.xs)}>
          {icon}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  )
}
