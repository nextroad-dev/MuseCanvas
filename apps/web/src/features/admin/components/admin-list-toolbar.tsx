import type { FormEventHandler, ReactNode } from 'react'
import { AdminFilterPanel } from './admin-filter-panel'

interface AdminListToolbarProps {
  title: string
  description?: ReactNode
  summary?: ReactNode
  actions?: ReactNode
  filters?: ReactNode
  filterActions?: ReactNode
  activeCount?: number
  appliedSummary?: ReactNode
  onSubmit?: FormEventHandler<HTMLFormElement>
}

/** Shared list composition only; queries, drafts, cursors and mutations stay with each view. */
export function AdminListToolbar({
  title, description, summary, actions, filters, filterActions,
  activeCount = 0, appliedSummary, onSubmit,
}: AdminListToolbarProps) {
  return (
    <section aria-label={title} className="@container/toolbar flex min-w-0 flex-col gap-4 rounded-card bg-tonal p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-module">{title}</h2>
          {description && <p className="max-w-reading text-sm text-muted-foreground">{description}</p>}
          {summary && <div className="min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{summary}</div>}
        </div>
        {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {filters && (
        <AdminFilterPanel activeCount={activeCount} summary={appliedSummary}>
          {onSubmit ? (
            <form className="flex min-w-0 flex-col gap-4" onSubmit={onSubmit}>
              <div className="grid min-w-0 grid-cols-1 items-start gap-4 @min-[560px]/toolbar:grid-cols-2 @min-[900px]/toolbar:grid-cols-3">{filters}</div>
              {filterActions && <div className="flex flex-wrap items-center gap-2">{filterActions}</div>}
            </form>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">{filters}{filterActions && <div className="flex flex-wrap gap-2">{filterActions}</div>}</div>
          )}
        </AdminFilterPanel>
      )}
    </section>
  )
}
