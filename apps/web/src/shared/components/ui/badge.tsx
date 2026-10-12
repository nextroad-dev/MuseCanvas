import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/shared/lib/cn'
import { iconSlot } from './size'

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent'
export type BadgeVariant = 'soft' | 'solid' | 'outline'

/**
 * Badge / Tag (components.md): pill, 12px/500, status colour used locally and
 * always next to text — `soft` is the default because a solid fill is reserved
 * for actions, and a static badge never pretends to be a button.
 * `accent` is the one place the brand green may appear as a graphic fill.
 */
const badgeClasses: Record<BadgeVariant, Record<BadgeTone, string>> = {
  soft: {
    neutral: 'bg-neutral-soft text-foreground',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
    info: 'bg-info-soft text-info',
    accent: 'bg-accent-soft text-accent-strong',
  },
  solid: {
    // `on-*` tokens are the WCAG-checked pairings for a solid semantic fill.
    neutral: 'bg-neutral-status text-on-primary',
    success: 'bg-success text-on-success',
    warning: 'bg-warning text-on-warning',
    danger: 'bg-danger text-on-danger',
    info: 'bg-info text-on-info',
    accent: 'bg-accent text-accent-contrast',
  },
  outline: {
    neutral: 'border border-border-strong text-foreground',
    success: 'border border-success text-success',
    warning: 'border border-warning text-warning',
    danger: 'border border-danger text-danger',
    info: 'border border-info text-info',
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
  /** Optional leading status icon; decorative unless it is the whole message. */
  icon?: ReactNode
  ref?: Ref<HTMLSpanElement>
}

export function Badge({ tone = 'neutral', variant = 'soft', icon, className, ref, children, ...rest }: BadgeProps) {
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
      {icon ? (
        <span aria-hidden="true" className={`inline-flex shrink-0 ${iconSlot.xs}`}>
          {icon}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  )
}

export interface BadgeDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  /** Accessible name: a dot alone must never carry meaning by colour only. */
  label: string
  ref?: Ref<HTMLSpanElement>
}

/**
 * 8px status dot (components.md → Badge Variants). Position it over a parent with
 * an absolute `className` (spec offset is -4px top-right); the `label` is rendered
 * as `sr-only` text so the state survives without sight or colour.
 */
export function BadgeDot({ tone = 'danger', label, className, ref, ...rest }: BadgeDotProps) {
  return (
    <span ref={ref} className={cn('inline-flex items-center', className)} {...rest}>
      <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-pill', dotClasses[tone])} />
      <span className="sr-only">{label}</span>
    </span>
  )
}

export interface BadgeCountProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  count: number
  /** Caps the display at `${max}+`, per the spec's 99+ rule. */
  max?: number
  tone?: BadgeTone
  /** Noun for the screen-reader text, e.g. `条未读` → `12 条未读`. */
  label?: string
  ref?: Ref<HTMLSpanElement>
}

/** Pill counter: min-width/height 20px, `99+` cap, `sr-only` expansion. */
export function BadgeCount({ count, max = 99, tone = 'danger', label = '项', className, ref, ...rest }: BadgeCountProps) {
  const capped = count > max
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex min-h-5 min-w-5 items-center justify-center rounded-pill px-1.5 text-xs font-medium tabular-nums',
        badgeClasses.solid[tone],
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true" className="font-mono">
        {capped ? `${max}+` : count}
      </span>
      <span className="sr-only">
        {capped ? `超过 ${max} ${label}` : `${count} ${label}`}
      </span>
    </span>
  )
}
