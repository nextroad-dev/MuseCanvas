import { cn } from '@/shared/lib/cn'
import type { CSSProperties } from 'react'
import { controlMinHeight } from './size'

/**
 * Loading placeholders. The shimmer sweep (1.5s, `--motion-shimmer`) lives in
 * `globals.css` and its base state is a static tonal block, so reduced-motion
 * users still get a legible placeholder. Placeholders are `aria-hidden`: the
 * region says it is busy, the boxes never get read out.
 *
 * Pick the shape that matches what is coming — a row of text for a paragraph, a
 * `SkeletonTile` for a media cell, a `SkeletonRow` for a table line — so nothing
 * reflows when the real content swaps in. A spinner is the wrong tool for any of
 * these three.
 */
interface SkeletonProps {
  /** Size the block close to the content it replaces so layout does not jump. */
  className?: string
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return <span aria-hidden="true" className={cn('motion-shimmer block rounded-control', className)} />
}

interface SkeletonTextProps {
  /** Number of lines to reserve. */
  lines?: number
  /** Measure of the block; the last line ends at 75% so the paragraph keeps a
   *  ragged edge instead of looking like a stack of bars. */
  width?: number | string
  className?: string
}

/** Paragraph placeholder: each line is 1.4em tall, i.e. the surrounding type's own
 *  line box, so it matches whatever text class the caller already has. */
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

interface SkeletonTileProps {
  /** Override the box (e.g. `aspect-video` or a rail width); defaults to the
   *  library grid's square media cell with the card radius. */
  className?: string
}

/** Media / card tile placeholder — same radius as the card that replaces it. */
export function SkeletonTile({ className }: SkeletonTileProps) {
  return (
    <span
      aria-hidden="true"
      className={cn('motion-shimmer block aspect-square w-full rounded-card', className)}
    />
  )
}

interface SkeletonRowProps {
  /** Cells per row: 1 reads as a list item, 3-5 as a table line. */
  cells?: number
  /** flex-basis of each cell, e.g. `120px` for a leading column. */
  cellWidth?: number | string
  className?: string
}

/** List / table row placeholder at the 40px control height, so a table keeps its
 *  rhythm while the data is in flight. */
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
