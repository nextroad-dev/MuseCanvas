import type { CSSProperties } from 'react'
import { cn } from '@/shared/lib/cn'
import { controlMinHeight } from './size'

/**
 * 加载占位块。
 *
 * `.motion-shimmer` 已同时包含弱色底与扫光，占位块只需再给尺寸——再叠 `bg-tonal`
 * 会重复上色。占位块是 `aria-hidden`：忙碌区域由所有者播报，盒子本身不朗读。
 */

export interface SkeletonProps {
  /** Size the block close to the content it replaces so layout does not jump. */
  className?: string
}

/** One block placeholder (defaults to a 16px text line box). */
export function Skeleton({ className }: SkeletonProps) {
  return <span aria-hidden="true" className={cn('motion-shimmer block h-4 rounded-control', className)} />
}

export interface SkeletonTextProps {
  /** Number of lines to reserve. */
  lines?: number
  /** Max width of the paragraph placeholder. */
  width?: number | string
  className?: string
}

/** Paragraph placeholder: the last line ends at 75% so it keeps a ragged edge. */
export function SkeletonText({ lines = 1, width = '100%', className }: SkeletonTextProps) {
  const total = Math.max(1, Math.floor(lines))
  return (
    <span aria-hidden="true" className={cn('flex flex-col gap-2', className)} style={{ maxWidth: width }}>
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={cn('motion-shimmer block rounded-pill', index === total - 1 && total > 1 && 'w-3/4')}
          style={{ height: '1.4em' }}
        />
      ))}
    </span>
  )
}

export interface SkeletonTileProps {
  /** Override the box (e.g. `aspect-video` or a rail width). */
  className?: string
}

/** Media / card tile placeholder — same radius as the card that replaces it. */
export function SkeletonTile({ className }: SkeletonTileProps) {
  return <span aria-hidden="true" className={cn('motion-shimmer block aspect-square w-full rounded-card', className)} />
}

export interface SkeletonRowProps {
  /** Cells per row: 1 reads as a list item, 3-5 as a table line. */
  cells?: number
  /** flex-basis of each cell, e.g. `120px` for a leading column. */
  cellWidth?: number | string
  className?: string
}

/** List / table row placeholder at the 40px control height. */
export function SkeletonRow({ cells = 1, cellWidth, className }: SkeletonRowProps) {
  const total = Math.max(1, Math.floor(cells))
  const style: CSSProperties | undefined = cellWidth === undefined ? undefined : { flexBasis: cellWidth }
  return (
    <span aria-hidden="true" className={cn('flex items-center gap-3', controlMinHeight.md, className)}>
      {Array.from({ length: total }, (_, index) => (
        <span key={index} style={style} className="motion-shimmer block h-4 min-w-0 flex-1 rounded-pill" />
      ))}
    </span>
  )
}
