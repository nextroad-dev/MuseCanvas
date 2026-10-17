import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/shared/lib/cn'

export interface SectionHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'id'> {
  /**
   * Id of the `<h2>` this renders. The enclosing `<section>` points its
   * `aria-labelledby` at it, which is what gives the section its accessible name —
   * so it is required rather than generated: `useId` would force this module to be
   * a client component for no benefit.
   */
  id: string
  title: ReactNode
  /** One or two sentences of context. Wraps at `max-w-reading`, never full-bleed. */
  description?: ReactNode
  /** Right-aligned actions; wraps under the title on narrow viewports. */
  actions?: ReactNode
  ref?: Ref<HTMLDivElement>
}

/**
 * In-page section heading for a stacked admin page (components.md 数据表格页).
 *
 * Deliberately not `PageHeader`: that renders the single `<h1>` at the 32px page
 * size, while a section inside a page is an `<h2>` at the 18px module size. The
 * two share a shape (title + description + trailing actions) but not a level, and
 * reusing one for the other would either emit two `<h1>`s or flatten the outline.
 *
 * The caller keeps the `<section aria-labelledby={id}>` wrapper, because only the
 * caller knows whether the section also needs `id`/`scroll-mt-*` for in-page links.
 */
export function SectionHeader({
  id,
  title,
  description,
  actions,
  className,
  ref,
  ...rest
}: SectionHeaderProps) {
  return (
    <div
      ref={ref}
      className={cn('flex flex-wrap items-start justify-between gap-3', className)}
      {...rest}
    >
      <div className="flex min-w-0 flex-col gap-1 text-foreground">
        <h2 id={id} className="text-module">
          {title}
        </h2>
        {description ? <p className="max-w-reading text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
