import type { HTMLAttributes, Ref } from 'react'
import { cn } from '@/shared/lib/cn'

export type CardVariant = 'surface' | 'tonal' | 'panel' | 'outline'
export type CardDensity = 'comfortable' | 'compact' | 'none'

/**
 * 卡片表面：
 *  · surface 标准内容卡：`bg-surface` + `shadow-soft` + 14 圆角；
 *  · tonal   安静分组块（`bg-tonal`），用在卡片内部；
 *  · panel   创作台等大浮层：18 圆角 + `shadow-floating`；
 *  · outline 带发丝描边的扁平表面，无阴影（后台密集行）。
 *
 * 密度只负责内边距与内部间距；设计规范要求卡片分区用留白而不是分割线，
 * 所以 `<CardBody>` 只按 gap 堆叠。
 */
const VARIANT_CLASS: Record<CardVariant, string> = {
  surface: 'bg-surface shadow-soft',
  tonal: 'bg-tonal',
  panel: 'bg-surface shadow-floating',
  outline: 'border border-border bg-surface',
}

const DENSITY_SPEC: Record<CardDensity, { card: string; block: string; radius: string }> = {
  comfortable: { card: 'gap-4 p-6', block: 'gap-4', radius: 'rounded-card' },
  compact: { card: 'gap-3 p-4', block: 'gap-3', radius: 'rounded-card' },
  none: { card: 'gap-0 p-0', block: 'gap-0', radius: 'rounded-card' },
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
  const spec = DENSITY_SPEC[density]
  return (
    <div
      ref={ref}
      className={cn(
        // 颜色只在这里设一次：字号 token 与 text-<color> 在同一元素上会被 tailwind-merge
        // 归入同一组而互相删除。
        'flex flex-col text-foreground',
        variant === 'panel' ? 'rounded-panel' : spec.radius,
        VARIANT_CLASS[variant],
        spec.card,
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

/** Footer actions; separated from the body by space, never a rule. */
export function CardFooter({ className, ref, ...rest }: CardFooterProps) {
  return <div ref={ref} className={cn('flex flex-wrap items-center justify-between gap-2', className)} {...rest} />
}

/** Convenience alias for a card that is really a plain section surface. */
export type CardContentProps = CardBodyProps
export const CardContent = CardBody
