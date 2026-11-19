import type { HTMLAttributes, Ref } from 'react'
import { cn } from '@/shared/lib/cn'

export type CardVariant = 'surface' | 'tonal' | 'panel' | 'outline'
export type CardDensity = 'comfortable' | 'compact' | 'none'

/**
 * 卡片表面：
 *  - `surface`（默认）：1px `border-border` + 白底 + `shadow-soft` + 14px 圆角；
 *  - `tonal`：安静分组块（`bg-tonal` + 柔和发丝描边）；
 *  - `panel`：浮层大容器（18px 圆角 + `border-border` + `shadow-floating`）；
 *  - `outline`：无阴影扁平描边表面。
 */
const VARIANT_CLASS: Record<CardVariant, string> = {
  surface: 'rounded-card border border-border bg-surface shadow-soft',
  tonal: 'rounded-card border border-border/70 bg-tonal',
  panel: 'rounded-panel border border-border bg-surface shadow-floating',
  outline: 'rounded-card border border-border bg-surface',
}

const DENSITY_CLASS: Record<CardDensity, string> = {
  comfortable: 'gap-4 p-5 sm:p-6',
  compact: 'gap-3 p-4',
  none: 'gap-0 p-0',
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant
  density?: CardDensity
  ref?: Ref<HTMLDivElement>
}

export function Card({
  variant = 'surface',
  density = 'comfortable',
  className,
  ref,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col text-foreground',
        VARIANT_CLASS[variant],
        DENSITY_CLASS[density],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

export type CardHeaderProps = HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }

export function CardHeader({ className, ref, ...rest }: CardHeaderProps) {
  return <div ref={ref} className={cn('flex flex-col gap-1', className)} {...rest} />
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /** Heading level in the document outline; styling is the same at every level. */
  level?: 2 | 3 | 4
  ref?: Ref<HTMLHeadingElement>
}

/** Card / module title: 18px at weight 500 (`text-module`); colour inherits from Card. */
export function CardTitle({ level = 3, className, ref, ...rest }: CardTitleProps) {
  const titleClass = cn('text-module', className)
  if (level === 2) return <h2 ref={ref} className={titleClass} {...rest} />
  if (level === 4) return <h4 ref={ref} className={titleClass} {...rest} />
  return <h3 ref={ref} className={titleClass} {...rest} />
}

export type CardDescriptionProps = HTMLAttributes<HTMLParagraphElement> & { ref?: Ref<HTMLParagraphElement> }

export function CardDescription({ className, ref, ...rest }: CardDescriptionProps) {
  return <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...rest} />
}

export type CardBodyProps = HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }

export function CardBody({ className, ref, ...rest }: CardBodyProps) {
  return <div ref={ref} className={cn('flex flex-col gap-4', className)} {...rest} />
}

export type CardFooterProps = HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }

export function CardFooter({ className, ref, ...rest }: CardFooterProps) {
  return <div ref={ref} className={cn('flex flex-wrap items-center justify-between gap-2', className)} {...rest} />
}

export type CardContentProps = CardBodyProps
export const CardContent = CardBody
