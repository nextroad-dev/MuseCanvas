import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/shared/lib/cn'

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'title'> {
  title: ReactNode
  description?: ReactNode
  /** Right-aligned actions: primary first from the right, then secondary/ghost. */
  actions?: ReactNode
  /** Content above the title — breadcrumbs, tabs, a status row. */
  meta?: ReactNode
  /**
   * Jude-Frontweb v22: primary page title H1 defaults to 32px (`page`, `text-title`),
   * significantly larger than module/view subtitle H2 (20px, `text-subtitle`).
   * `section` = 24px (`text-section`) for sub-sections.
   */
  size?: 'page' | 'section'
  actionsClassName?: string
  ref?: Ref<HTMLElement>
}

/**
 * Page header (components.md 场景模式 → 数据表格页): page title + description with
 * the main action right-aligned, wrapping to two rows on narrow viewports instead
 * of squeezing the title.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  size = 'page',
  className,
  actionsClassName,
  ref,
  ...rest
}: PageHeaderProps) {
  return (
    <header
      ref={ref}
      className={cn('flex flex-wrap items-start justify-between gap-x-6 gap-y-3', className)}
      {...rest}
    >
      <div className="flex min-w-0 flex-col gap-1 text-foreground">
        {meta}
        <h1
          className={cn(
            size === 'page'
              ? 'text-title font-normal text-foreground leading-[1.25]'
              : 'text-section font-normal text-foreground leading-[1.35]',
          )}
        >
          {title}
        </h1>
        {description ? <p className="max-w-reading text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? (
        <div className={cn('flex shrink-0 flex-wrap items-center gap-2', actionsClassName)}>{actions}</div>
      ) : null}
    </header>
  )
}
