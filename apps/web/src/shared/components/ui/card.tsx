'use client'

import { createContext, useContext } from 'react'
import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { ArrowDownIcon as ArrowDown, ArrowUpIcon as ArrowUp } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { Skeleton } from './skeleton'
import { iconSize } from './size'

type CardDensity = 'comfortable' | 'compact'

/**
 * Density drives padding *and* the internal rhythm, because the spec replaces a
 * card's divider lines with space alone: comfortable 24px padding / 16px between
 * blocks, compact 16px padding / 12px between blocks (components.md Card row).
 */
const densitySpec: Record<CardDensity, { card: string; block: string }> = {
  comfortable: { card: 'gap-4 p-6', block: 'gap-4' },
  compact: { card: 'gap-3 p-4', block: 'gap-3' },
}

const CardDensityContext = createContext<CardDensity>('comfortable')

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  density?: CardDensity
  /**
   * Colour-only hover (`hover:bg-surface-hover`). No lift, no shadow growth, no
   * translate: a card at rest stays at rest. When the whole card navigates,
   * render it inside a `<Link>`/`<button>` rather than adding onClick here.
   */
  interactive?: boolean
  ref?: Ref<HTMLDivElement>
}

export function Card({ density = 'comfortable', interactive, className, ref, children, ...rest }: CardProps) {
  return (
    <CardDensityContext.Provider value={density}>
      <div
        ref={ref}
        className={cn(
          // `text-foreground` is set here, once: a custom type-scale class
          // (`text-module`, `text-title`, …) lives in the same tailwind-merge
          // group as `text-<color>`, so pairing them on one element deletes the
          // size. Headings inherit their colour instead.
          'flex flex-col rounded-card bg-surface text-foreground shadow-soft',
          densitySpec[density].card,
          interactive &&
            'transition-colors hover:bg-surface-hover',
          className,
        )}
        {...rest}
      >
        {children}
      </div>
    </CardDensityContext.Provider>
  )
}

export function CardHeader({ className, ref, ...rest }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  return <div ref={ref} className={cn('flex flex-col gap-1', className)} {...rest} />
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /** Heading level in the document outline; styling is the same at every level. */
  level?: 2 | 3 | 4
  ref?: Ref<HTMLHeadingElement>
}

/**
 * Card / module title: 18px on weight 500 (`text-module`). Colour comes from
 * `Card` — see the tailwind-merge note there before adding a `text-*` colour.
 */
export function CardTitle({ level = 3, className, ref, ...rest }: CardTitleProps) {
  const titleClass = cn('text-module', className)
  if (level === 2) {
    return (
      <h2 ref={ref} className={titleClass} {...rest} />
    )
  }
  if (level === 4) {
    return (
      <h4 ref={ref} className={titleClass} {...rest} />
    )
  }
  return (
    <h3 ref={ref} className={titleClass} {...rest} />
  )
}

export function CardDescription({ className, ref, ...rest }: HTMLAttributes<HTMLParagraphElement> & { ref?: Ref<HTMLParagraphElement> }) {
  return <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...rest} />
}

export function CardBody({ className, ref, ...rest }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  const density = useContext(CardDensityContext)
  return <div ref={ref} className={cn('flex flex-col', densitySpec[density].block, className)} {...rest} />
}

/** Footer actions. Spacing separates it from the body — never a `border-t`. */
export function CardFooter({ className, ref, ...rest }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  const density = useContext(CardDensityContext)
  return (
    <div
      ref={ref}
      className={cn('flex flex-wrap items-center justify-between gap-2', densitySpec[density].block, className)}
      {...rest}
    />
  )
}

export interface StatCardProps extends Omit<CardProps, 'children' | 'density'> {
  /** KPI name, e.g. `本月生成数`. */
  label: string
  value: ReactNode
  /** Unit rendered after the value, e.g. `次`. */
  unit?: string
  /** Signed change vs the previous period. `null` hides the delta row. */
  delta?: number | null
  /** Suffix after the delta number; defaults to `%`. */
  deltaSuffix?: string
  /**
   * Set when a *rise* is bad (失败任务数, 额度消耗): the colours swap so the
   * delta never signals "good" by direction alone.
   */
  invertDelta?: boolean
  /** Time-window caption, e.g. `较上 7 日`. */
  hint?: ReactNode
  loading?: boolean
}

/**
 * KPI / metric card (components.md → KPI card): the value rides the 32px title
 * size in mono `tabular-nums` so digits align, the trend carries an arrow, an
 * explicit sign *and* text, and the loading state keeps the same geometry.
 */
export function StatCard({
  label,
  value,
  unit,
  delta,
  deltaSuffix = '%',
  invertDelta,
  hint,
  loading,
  className,
  ref,
  ...rest
}: StatCardProps) {
  const busy = loading || undefined
  const hasDelta = delta !== null && delta !== undefined
  const positive = hasDelta && (delta as number) > 0
  const negative = hasDelta && (delta as number) < 0
  const toneClass = positive ? (invertDelta ? 'text-danger' : 'text-success') : negative ? (invertDelta ? 'text-success' : 'text-danger') : 'text-muted-foreground'
  const DeltaIcon = positive ? ArrowUp : negative ? ArrowDown : ArrowUp

  return (
    <Card
      ref={ref}
      aria-busy={busy}
      className={cn('justify-between', className)}
      {...rest}
    >
      <CardHeader>
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        {loading ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            {/* Geometry matches the loaded value + delta rows, so nothing jumps. */}
            <Skeleton className="h-10 w-28" />
            <Skeleton className="h-4 w-36" />
          </div>
        ) : (
          <>
            <p className="flex items-baseline gap-1">
              <span className="text-title font-mono tabular-nums">{value}</span>
              {unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
            </p>
            {hasDelta || hint ? (
              <p className="flex flex-wrap items-center gap-1 text-xs">
                {hasDelta ? (
                  <span className={cn('inline-flex items-center gap-0.5 font-medium tabular-nums', toneClass)}>
                    <DeltaIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
                    {positive ? '+' : negative ? '-' : '±'}
                    {Math.abs(delta as number)}
                    {deltaSuffix}
                  </span>
                ) : null}
                {hint ? <span className="text-muted-foreground">{hint}</span> : null}
              </p>
            ) : null}
          </>
        )}
      </CardHeader>
    </Card>
  )
}
