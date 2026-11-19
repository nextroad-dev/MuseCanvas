import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/shared/lib/cn'

export interface SectionHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'id'> {
  /** 渲染的 `<h2>`/`<h3>` id，供外层 `<section aria-labelledby>` 关联；保持 RSC-safe。 */
  id: string
  title: ReactNode
  /** One or two sentences of context; wraps at `max-w-reading`. */
  description?: ReactNode
  /** Right-aligned actions; wraps under the title on narrow viewports. */
  actions?: ReactNode
  /** Heading level for the outline (styling is the same). */
  level?: 2 | 3
  ref?: Ref<HTMLDivElement>
}

/** 页内区块标题：18px `text-module`，右侧可带操作。 */
export function SectionHeader({
  id,
  title,
  description,
  actions,
  level = 2,
  className,
  ref,
  ...rest
}: SectionHeaderProps) {
  const titleClass = 'text-module'
  return (
    <div
      ref={ref}
      className={cn('flex flex-wrap items-start justify-between gap-3 text-foreground', className)}
      {...rest}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {level === 3 ? (
          <h3 id={id} className={titleClass}>
            {title}
          </h3>
        ) : (
          <h2 id={id} className={titleClass}>
            {title}
          </h2>
        )}
        {description ? <p className="max-w-reading text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
