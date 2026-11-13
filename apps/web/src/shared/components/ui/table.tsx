'use client'

import { createContext, useContext, isValidElement } from 'react'
import type { ReactNode, Ref, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '@/shared/lib/cn'
import { Card } from './card'

/**
 * 后台表格原语（画板 07/08）。
 *
 * 每个后台页面曾经都重复声明同一层壳（卡片 + `overflow-x-auto` + `<table>` +
 * `sr-only` caption + 弱色表头 + 逐格 `px-4 py-3`），所以内边距、行节奏与表头样式
 * 各自只在这里决定一次；密度通过 context 传，调用方只写一次。
 *
 * 可访问性内置而不是留给调用方：`caption` 必填、表头单元格始终 `scope="col"`、
 * body 自带 `aria-busy`、可排序列有 `aria-sort`；行 hover 默认关闭，只有整行可点
 * 的表格显式开启，静态表格不会暗示可操作。
 */

export type TableDensity = 'default' | 'dense'

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
  default: 'divide-y divide-border',
  dense: 'font-mono text-foreground',
}

/** Cell box, shared by `<th>` and `<td>` so headers and columns always align. */
const cellBox: Record<TableDensity, string> = {
  default: 'px-5 py-3',
  dense: 'py-1 pr-3',
}

export interface TableFrameProps {
  /** Announced to assistive tech; the table has no visible title of its own. */
  caption: ReactNode
  density?: TableDensity
  /**
   * 列数。在这里声明一次，`TableStateRow` 就能取到 colSpan，整行状态就不会与表头
   * 对不上。
   */
  columns?: number
  /** Merged onto the scrolling wrapper. */
  className?: string
  children: ReactNode
}

/** Bare table shell — use `Table` for the standard carded grid. */
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

export interface TableProps {
  caption: ReactNode
  /** See `TableFrameProps['columns']`. */
  columns?: number
  /** Merged onto the `overflow-x-auto` wrapper, not the card. */
  className?: string
  /** Merged onto the card, for the rare grid that needs a wider/narrower frame. */
  cardClassName?: string
  children: ReactNode
}

/** Standard admin grid: a card that clips its corners, table flush to the edges. */
export function Table({ caption, columns, className, cardClassName, children }: TableProps) {
  return (
    <Card density="none" className={cn('overflow-hidden', cardClassName)}>
      <TableFrame caption={caption} density="default" columns={columns} className={className}>
        {children}
      </TableFrame>
    </Card>
  )
}

/** Alias — `Table` is the carded shell, `TableFrame` the bare one. */
export const DataTable = Table

export interface TableHeaderProps {
  className?: string
  /** Header cells. `TableHeader` owns the `<tr>`, so pass cells directly. */
  children: ReactNode
}

export function TableHeader({ className, children }: TableHeaderProps) {
  const density = useDensity()
  return (
    <thead className={cn(headClass[density], className)}>
      <tr>{children}</tr>
    </thead>
  )
}

/** Alias kept for the previous component name. */
export const TableHead = TableHeader

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
  /**
   * 仅颜色变化的 hover。默认关闭：只有整行可点的表格才开启，静态表格不暗示操作。
   */
  hover?: boolean
  className?: string
  children: ReactNode
}

export function TableRow({ hover = false, className, children }: TableRowProps) {
  const density = useDensity()
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

/** Cell colour / weight; orthogonal to `align`, `mono`, `tabular`. */
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
  /** Digit column: `tabular-nums` so numbers line up across rows. */
  tabular?: boolean
  ref?: Ref<HTMLTableCellElement>
}

export function TableCell({ align = 'left', tone = 'default', mono, tabular, className, children, ...rest }: TableCellProps) {
  const density = useDensity()
  return (
    <td
      className={cn(
        cellBox[density],
        align === 'right' && 'text-right',
        cellTone[tone],
        mono && 'font-mono',
        density === 'default' && mono && 'text-xs',
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
   * 跨列数。省略时用外层 `columns`（推荐用法）；只有未声明 `columns` 的表格才显式传。
   */
  colSpan?: number
  className?: string
  children: ReactNode
}

/** Full-width row for empty / no-results / error states; no hover, no rule. */
export function TableStateRow({ colSpan, className, children }: TableStateRowProps) {
  const { columns } = useContext(TableContext)
  const span = colSpan ?? columns
  if (span === undefined) {
    throw new Error('TableStateRow needs either its own `colSpan` or a `columns` value on the surrounding Table/TableFrame.')
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
   * `{ align: 'right', content }` only when the column is right-aligned.
   */
  cells: Array<ReactNode | TableSkeletonCell>
  className?: string
}

/** Placeholder row that keeps the table's geometry while data is in flight. */
export function TableSkeletonRow({ cells, className }: TableSkeletonRowProps) {
  return (
    <TableRow className={className}>
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
