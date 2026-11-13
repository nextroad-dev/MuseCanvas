import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/shared/lib/cn'

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode
  description?: ReactNode
  /** Right-aligned actions: primary first from the right, then secondary/ghost. */
  actions?: ReactNode
  /** Content above the title — breadcrumbs, tabs, a status row. */
  meta?: ReactNode
  /**
   * `page` = 32px 主标题（`text-title`），`section` = 24px（`text-section`）用于子页面。
   * 颜色从外层继承：标题上不要同时写 `text-*` 颜色，否则字号类会被合并掉。
   */
  size?: 'page' | 'section'
  actionsClassName?: string
  ref?: Ref<HTMLElement>
}

/**
 * 页头：标题 + 说明 + 右侧主操作；窄屏自动换行而不是挤压标题。
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
    <header ref={ref} className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3 text-foreground', className)} {...rest}>
      <div className="flex min-w-0 flex-col gap-1">
        {meta}
        <h1 className={size === 'page' ? 'text-title font-normal' : 'text-section font-normal'}>{title}</h1>
        {description ? <p className="max-w-reading text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className={cn('flex shrink-0 flex-wrap items-center gap-2', actionsClassName)}>{actions}</div> : null}
    </header>
  )
}
