'use client'

import { createContext, isValidElement, useContext } from 'react'
import type { ReactNode, Ref, ThHTMLAttributes, TdHTMLAttributes } from 'react'
import { cn } from '@/shared/lib/cn'
import { Card } from './card'

/**
 * Table primitives for the admin surface.
 *
 * Before this module every admin view re-declared the same shell — `Card` +
 * `overflow-x-auto` + `<table>` + `sr-only` caption + a tonal `thead` + a
 * `divide-y` `tbody` — and then repeated `px-4 py-3` on every cell. The padding,
 * the row rhythm and the header treatment are one decision each, so they live
 * here instead of in seven files.
 *
 * Two densities, because the app really has two tables:
 *  · `default` — the data grid: 40px row rhythm, tonal header, hairline row
 *    rules, colour-only row hover. This is `DataTable`.
 *  · `dense` — the manifest/code listing (a plugin's file list): `text-xs`, mono
 *    body, no header fill, no row rules, no hover, tighter `py-1`. It sits inside
 *    an already-styled disclosure, so it uses the bare `TableFrame`, never the
 *    `Card`.
 *
 * Density rides a context (same approach as `Card`'s density) so a call site
 * states it once on the frame and never threads it through every cell. The
 * alternative — a `density` prop on each of the six child components — would be
 * six chances to forget one and silently ship a half-dense table.
 *
 * Accessibility is not optional and is therefore baked in rather than left to the
 * caller: `caption` is required, header cells always carry `scope="col"`, the body
 * owns `aria-busy`, and sortable columns get `aria-sort` on the header cell.
 */

type TableDensity = 'default' | 'dense'

interface TableContextValue {
  density: TableDensity
  /** Column count, so state rows span the grid without repeating it. */
  columns?: number
}

const TableContext = createContext<TableContextValue>({ density: 'default' })

const useDensity = () => useContext(TableContext).density

const tableClass: Record<TableDensity, string> = {
  default: 'w-full text-left text-sm',
  dense: 'w-full text-left text-xs',
}

const headClass: Record<TableDensity, string> = {
  default: 'bg-tonal text-muted-foreground',
  dense: 'text-muted-foreground',
}

const bodyClass: Record<TableDensity, string> = {
  // Rows are separated by a hairline; the card itself never gets an inner rule.
  default: 'divide-y divide-border',
  dense: 'font-mono text-foreground',
}

/** Cell box, shared by `<th>` and `<td>` so headers and columns always align. */
const cellBox: Record<TableDensity, string> = {
  default: 'px-4 py-3',
  dense: 'py-1 pr-3',
}

export interface TableFrameProps {
  /** Announced to assistive tech; the table has no visible title of its own. */
  caption: ReactNode
  density?: TableDensity
  /**
   * Number of columns. Stated once here it becomes the `colSpan` of every
   * `TableStateRow`, so a full-width state cell can never disagree with the header
   * it spans. Keep it equal to the number of `TableHeadCell`s.
   */
  columns?: number
  className?: string
  children: ReactNode
}

/**
 * Bare table shell — `<div>` + `<table>` + caption. Use `DataTable` for the
 * standard carded grid; reach for this when the table is already inside a
 * surface of its own (the plugin file manifest) or needs a different container.
 */
export function TableFrame({ caption, density = 'default', columns, className, children }: TableFrameProps) {
  return (
    <TableContext.Provider value={{ density, columns }}>
      <div className={cn('overflow-x-auto', className)}>
        <table className={tableClass[density]}>
          <caption className="sr-only">{caption}</caption>
          {children}
        </table>
      </div>
    </TableContext.Provider>
  )
}

export interface DataTableProps {
  caption: ReactNode
  /** See `TableFrameProps['columns']`. */
  columns?: number
  /** Merged onto the `overflow-x-auto` wrapper, not the card. */
  className?: string
  /** Merged onto the card, for the rare grid that needs a wider/narrower frame. */
  cardClassName?: string
  children: ReactNode
}

/**
 * The standard admin grid: a card that clips its own corners, with the table
 * flush to the edges (`p-0`) and no gap between card and content (`gap-0`), so the
 * tonal header reads as part of the card rather than a floating band.
 */
export function DataTable({ caption, columns, className, cardClassName, children }: DataTableProps) {
  return (
    <Card className={cn('gap-0 overflow-hidden p-0', cardClassName)}>
      <TableFrame caption={caption} density="default" columns={columns} className={className}>
        {children}
      </TableFrame>
    </Card>
  )
}

export interface TableHeadProps {
  className?: string
  /** Header cells. `TableHead` owns the `<tr>`, so pass cells directly. */
  children: ReactNode
}

export function TableHead({ className, children }: TableHeadProps) {
  const density = useDensity()
  return (
    <thead className={cn(headClass[density], className)}>
      <tr>{children}</tr>
    </thead>
  )
}

export interface TableHeadCellProps extends Omit<ThHTMLAttributes<HTMLTableCellElement>, 'scope' | 'align'> {
  align?: 'left' | 'right'
  /** Current sort direction of this column, if it is sortable. */
  sort?: 'ascending' | 'descending' | 'none' | 'other'
  ref?: Ref<HTMLTableCellElement>
}

export function TableHeadCell({ align = 'left', sort, className, children, ...rest }: TableHeadCellProps) {
  const density = useDensity()
  return (
    <th
      scope="col"
      aria-sort={sort}
      className={cn(
        cellBox[density],
        density === 'default' ? 'text-sm font-medium' : 'font-normal',
        align === 'right' && 'text-right',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  )
}

export interface TableBodyProps {
  /** Renders `aria-busy` while a fetch is in flight. */
  busy?: boolean
  className?: string
  children: ReactNode
}

export function TableBody({ busy, className, children }: TableBodyProps) {
  const density = useDensity()
  return (
    <tbody className={cn(bodyClass[density], className)} aria-busy={busy || undefined}>
      {children}
    </tbody>
  )
}

export interface TableRowProps {
  /** Colour-only hover. Off for skeleton and state rows, which are not targets. */
  hover?: boolean
  className?: string
  children: ReactNode
}

export function TableRow({ hover = true, className, children }: TableRowProps) {
  const density = useDensity()
  // `|| undefined` rather than an empty string: a row that only exists to hold
  // placeholders (skeleton, dense manifest) should carry no `class` attribute at
  // all, so its markup matches a plain `<tr>` exactly.
  return (
    <tr
      className={
        cn(density === 'default' && hover && 'transition-colors hover:bg-surface-hover', className) || undefined
      }
    >
      {children}
    </tr>
  )
}

/** Cell colour / weight. Orthogonal to `align`, `mono`, `tabular`. */
const cellTone = {
  default: '',
  muted: 'text-muted-foreground',
  strong: 'font-medium text-foreground',
  foreground: 'text-foreground',
} as const

export interface TableCellProps extends Omit<TdHTMLAttributes<HTMLTableCellElement>, 'align'> {
  align?: 'left' | 'right'
  tone?: keyof typeof cellTone
  /** Identifier/code column: `font-mono`. */
  mono?: boolean
  /** Only meaningful with `mono`: the 12px step used for dense identifiers. */
  textSize?: 'sm' | 'xs'
  /** Digit column: `tabular-nums` so numbers line up across rows. */
  tabular?: boolean
  ref?: Ref<HTMLTableCellElement>
}

export function TableCell({
  align = 'left',
  tone = 'default',
  mono,
  textSize,
  tabular,
  className,
  children,
  ...rest
}: TableCellProps) {
  const density = useDensity()
  return (
    <td
      className={cn(
        cellBox[density],
        align === 'right' && 'text-right',
        cellTone[tone],
        mono && 'font-mono',
        textSize === 'xs' && 'text-xs',
        tabular && 'tabular-nums',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  )
}

export interface TableStateRowProps {
  /**
   * Columns to span. Omit it and the frame's `columns` is used, which is the
   * intended form; passing it is only for a table that declares no `columns`.
   */
  colSpan?: number
  className?: string
  children: ReactNode
}

/**
 * Full-width row for the empty / no-results / error states. It deliberately does
 * not paint a hover or a row rule: it is a message, not a record.
 */
export function TableStateRow({ colSpan, className, children }: TableStateRowProps) {
  const { columns } = useContext(TableContext)
  const span = colSpan ?? columns
  if (span === undefined) {
    // Fail loud: a silent fallback would render the message in a single cell and
    // leave the rest of the row blank, which reads as broken data, not a bug report.
    throw new Error('TableStateRow needs either its own `colSpan` or a `columns` value on the surrounding DataTable/TableFrame.')
  }
  return (
    <tr>
      <td colSpan={span} className={className}>
        {children}
      </td>
    </tr>
  )
}

export interface TableSkeletonCell {
  align?: 'left' | 'right'
  content: ReactNode
}

export interface TableSkeletonRowProps {
  /**
   * One entry per column. Pass the placeholder itself; wrap it in
   * `{ align: 'right', content }` only when the column is right-aligned, so the
   * common case stays a bare element.
   */
  cells: Array<ReactNode | TableSkeletonCell>
  className?: string
}

/**
 * Placeholder row that keeps the table's geometry while data is in flight. The
 * placeholders themselves come from `SkeletonText` / `SkeletonTile` — this only
 * supplies the matching cell box, so nothing reflows when the data lands.
 */
export function TableSkeletonRow({ cells, className }: TableSkeletonRowProps) {
  return (
    <TableRow hover={false} className={className}>
      {cells.map((cell, index) => {
        const spec: TableSkeletonCell =
          cell !== null && typeof cell === 'object' && !isValidElement(cell) && 'content' in cell
            ? (cell as TableSkeletonCell)
            : { content: cell as ReactNode }
        return (
          <TableCell key={index} align={spec.align}>
            {spec.content}
          </TableCell>
        )
      })}
    </TableRow>
  )
}
