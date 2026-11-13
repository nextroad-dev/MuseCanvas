'use client'

import type { ReactNode } from 'react'
import { CaretLeftIcon as ChevronLeft, CaretRightIcon as ChevronRight } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { IconButton, buttonVariants } from './button'
import { buildPageItems, clampPage, describeRange } from './pagination-math'
import { controlSquare } from './size'

interface PaginationBaseProps {
  size?: 'sm' | 'md'
  className?: string
  listClassName?: string
  'aria-label'?: string
}

/** Numbered pagination for a list endpoint that reports a total. */
export interface PagePaginationProps extends PaginationBaseProps {
  mode?: 'page'
  /** 1-based current page. */
  page: number
  total: number
  pageSize?: number
  /** Override the derived page count (server-side paging often knows it). */
  pageCount?: number
  onPageChange: (page: number) => void
  /** Pages shown on each side of the current one before truncation. */
  siblingCount?: number
  /** Hide the count line when the parent already shows it. */
  showTotal?: boolean
}

/** Cursor pagination: only previous/next + a count line, per the library API. */
export interface CursorPaginationProps extends PaginationBaseProps {
  mode: 'cursor'
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
  /** How many items are loaded so far. */
  count?: number
  /** Text before the count, e.g. `已加载`. */
  countLabel?: string
}

export type PaginationProps = PagePaginationProps | CursorPaginationProps

/**
 * 列表页脚：左侧计数行，右侧翻页控件。页码模式用 `aria-current="page"` +
 * `bg-tonal-selected` 标记当前页；cursor 模式只渲染上一页/下一页，因为游标无法
 * 跳到第 N 页。
 */
export function Pagination(props: PaginationProps) {
  const { size = 'md', className, listClassName } = props
  const ariaLabel = props['aria-label'] ?? '分页'
  const square = `${size === 'sm' ? controlSquare.sm : controlSquare.md} px-0`

  if (props.mode === 'cursor') {
    const { hasPrevious, hasNext, onPrevious, onNext, count, countLabel = '已加载' } = props
    const label: ReactNode = typeof count === 'number' ? `${countLabel} ${count} 个` : null
    return (
      <nav aria-label={ariaLabel} className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2', className)}>
        <p className="text-sm tabular-nums text-muted-foreground">{label}</p>
        <div className={cn('flex items-center gap-1', listClassName)}>
          <IconButton
            variant="ghost"
            size="icon"
            aria-label="上一页"
            aria-disabled={!hasPrevious || undefined}
            onClick={hasPrevious ? onPrevious : undefined}
            icon={<ChevronLeft weight="bold" aria-hidden="true" />}
            className={size === 'sm' ? controlSquare.sm : controlSquare.md}
          />
          <IconButton
            variant="ghost"
            size="icon"
            aria-label="下一页"
            aria-disabled={!hasNext || undefined}
            onClick={hasNext ? onNext : undefined}
            icon={<ChevronRight weight="bold" aria-hidden="true" />}
            className={size === 'sm' ? controlSquare.sm : controlSquare.md}
          />
        </div>
      </nav>
    )
  }

  const { page, total, pageSize = 20, pageCount, onPageChange, siblingCount = 1, showTotal = true } = props
  const derivedPages = Math.ceil(total / (pageSize || 1))
  const safePageCount = Math.max(1, pageCount ?? (Number.isFinite(derivedPages) ? derivedPages : 1))
  const safePage = clampPage(page, safePageCount)
  const items = buildPageItems(safePage, safePageCount, siblingCount)

  const go = (next: number) => {
    const target = clampPage(next, safePageCount)
    if (target === safePage) return
    onPageChange(target)
  }

  return (
    <nav aria-label={ariaLabel} className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2', className)}>
      <p className="text-sm tabular-nums text-muted-foreground">{showTotal ? describeRange(safePage, pageSize, total) : null}</p>

      <div className={cn('flex items-center gap-1', listClassName)}>
        <IconButton
          variant="ghost"
          size="icon"
          aria-label="上一页"
          aria-disabled={safePage <= 1 || undefined}
          onClick={() => go(safePage - 1)}
          icon={<ChevronLeft weight="bold" aria-hidden="true" />}
          className={size === 'sm' ? controlSquare.sm : controlSquare.md}
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
              aria-current={item.page === safePage ? 'page' : undefined}
              onClick={() => go(item.page)}
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'icon' }),
                square,
                item.page === safePage
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
          size="icon"
          aria-label="下一页"
          aria-disabled={safePage >= safePageCount || undefined}
          onClick={() => go(safePage + 1)}
          icon={<ChevronRight weight="bold" aria-hidden="true" />}
          className={size === 'sm' ? controlSquare.sm : controlSquare.md}
        />
      </div>
    </nav>
  )
}
