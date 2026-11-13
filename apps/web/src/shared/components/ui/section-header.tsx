import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/shared/lib/cn'

export interface SectionHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'id'> {
  /**
   * 渲染的 `<h2>` id。外层 `<section>` 用 `aria-labelledby` 指向它来获得可访问名；
   * 必须由调用方提供，这样本模块不依赖 `useId`，RSC 可直接渲染。
   */
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

/**
 * 页内区块标题：18px `text-module` 的 `<h2>`，右侧可带操作。刻意不复用 `PageHeader`
 * （它持有唯一的 `<h1>`），避免页面出现两个一级标题。
 */
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
    <div ref={ref} className={cn('flex flex-wrap items-start justify-between gap-3 text-foreground', className)} {...rest}>
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
