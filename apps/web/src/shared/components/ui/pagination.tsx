'use client'

import type { ReactNode } from 'react'
import { CaretLeftIcon as ChevronLeft, CaretRightIcon as ChevronRight } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { IconButton, buttonVariants } from './button'
import type { ButtonSize } from './button'
import { controlSquare } from './size'

export interface PaginationProps {
  /** 1-based current page. */
  page: number
  /** Row count for the `共 X 条` line on the left. */
  total: number
  /** Rows per page, used to derive `pageCount` when it is not given. */
  pageSize?: number
  /** Override the derived page count (server-side paging often knows it). */
  pageCount?: number
  onPageChange: (page: number) => void
  size?: 'sm' | 'md'
  /** Pages shown on each side of the current one before truncating. */
  siblingCount?: number
  /** Hide the `共 X 条` line when the parent already shows it. */
  showTotal?: boolean
  className?: string
  listClassName?: string
  'aria-label'?: string
}

type PageItem = { kind: 'page'; page: number } | { kind: 'gap'; key: string }

/** First, last, a window around `page`, and `…` wherever numbers were skipped. */
function buildItems(page: number, pageCount: number, siblingCount: number): PageItem[] {
  const pages = new Set<number>([1, pageCount])
  for (let offset = siblingCount; offset >= -siblingCount; offset -= 1) {
    const candidate = page + offset
    if (candidate >= 1 && candidate <= pageCount) pages.add(candidate)
  }
  const sorted = [...pages].sort((a, b) => a - b)
  const items: PageItem[] = []
  sorted.forEach((value, index) => {
    const previous = sorted[index - 1]
    if (previous !== undefined && value - previous > 1) items.push({ kind: 'gap', key: `gap-${previous}-${value}` })
    items.push({ kind: 'page', page: value })
  })
  return items
}

/**
 * Listing footer (components.md Pagination row + 场景模式 → 数据表格页):
 * `共 X 条` left, 32/40px page controls right, the current page marked with
 * `bg-tonal-selected` + `aria-current="page"`, and boundaries that stay in the
 * tab order but block activation through `aria-disabled` (components.md requires
 * the mouse *and* keyboard blocking, which `Button` implements).
 */
export function Pagination({
  page,
  total,
  pageSize = 20,
  pageCount,
  onPageChange,
  size = 'md',
  siblingCount = 1,
  showTotal = true,
  className,
  listClassName,
  'aria-label': ariaLabel = '分页',
}: PaginationProps) {
  const derivedPages = Math.ceil(total / (pageSize || 1))
  const safePageCount = Math.max(1, pageCount ?? (Number.isFinite(derivedPages) ? derivedPages : 1))
  const items = buildItems(page, safePageCount, siblingCount)
  const controlSize: ButtonSize = size === 'sm' ? 'sm' : 'md'
  const square = `${size === 'sm' ? controlSquare.sm : controlSquare.md} px-0`
  const go = (next: number) => {
    if (next < 1 || next > safePageCount || next === page) return
    onPageChange(next)
  }

  const label: ReactNode = showTotal ? `共 ${total} 条` : null

  return (
    <nav aria-label={ariaLabel} className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2', className)}>
      <p className="text-sm tabular-nums text-muted-foreground">{label}</p>

      <div className={cn('flex items-center gap-1', listClassName)}>
        <IconButton
          variant="ghost"
          size={controlSize}
          aria-label="上一页"
          aria-disabled={page <= 1 || undefined}
          onClick={() => go(page - 1)}
          icon={<ChevronLeft weight="bold" aria-hidden="true" />}
        />

        {items.map((item) =>
          item.kind === 'gap' ? (
            <span key={item.key} aria-hidden="true" className="px-1 text-sm text-muted-foreground">
              …
            </span>
          ) : (
            <button
              key={item.page}
              type="button"
              aria-current={item.page === page ? 'page' : undefined}
              onClick={() => go(item.page)}
              className={cn(
                buttonVariants({ variant: 'ghost', size: controlSize }),
                square,
                item.page === page
                  ? 'bg-tonal-selected text-foreground not-disabled:hover:bg-tonal-selected'
                  : 'text-muted-foreground',
              )}
            >
              <span className="font-mono tabular-nums">{item.page}</span>
            </button>
          ),
        )}

        <IconButton
          variant="ghost"
          size={controlSize}
          aria-label="下一页"
          aria-disabled={page >= safePageCount || undefined}
          onClick={() => go(page + 1)}
          icon={<ChevronRight weight="bold" aria-hidden="true" />}
        />
      </div>
    </nav>
  )
}
