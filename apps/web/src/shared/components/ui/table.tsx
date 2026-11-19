'use client'

import { createContext, useContext, isValidElement } from 'react'
import type { ReactNode, Ref, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '@/shared/lib/cn'
import { Card } from './card'

export type TableDensity = 'default' | 'dense'

interface TableContextValue {
  density: TableDensity
  columns?: number
}

const TableContext = createContext<TableContextValue>({ density: 'default' })

const useDensity = () => useContext(TableContext).density

const tableClass: Record<TableDensity, string> = {
  default: 'w-full text-left text-sm',
  dense: 'w-full text-left text-xs',
}

const headClass: Record<TableDensity, string> = {
  default: 'border-b border-border bg-tonal/70 text-muted-foreground',
  dense: 'border-b border-border text-muted-foreground',
}

const bodyClass: Record<TableDensity, string> = {
  default: 'divide-y divide-border',
  dense: 'divide-y divide-border font-mono text-foreground',
}

const cellBox: Record<TableDensity, string> = {
  default: 'px-4 py-3',
  dense: 'px-3 py-1.5',
}

export interface TableFrameProps {
  /** Announced to assistive tech; the table has no visible title of its own. */
  caption: ReactNode
  density?: TableDensity
  /** Column count so `TableStateRow` can span the full width automatically. */
  columns?: number
  className?: string
  children: ReactNode
}

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
  columns?: number
  className?: string
  cardClassName?: string
  children: ReactNode
}

/** Standard carded data table with crisp surface border and clipped corners. */
export function Table({ caption, columns, className, cardClassName, children }: TableProps) {
  return (
    <Card density="none" className={cn('overflow-hidden', cardClassName)}>
      <TableFrame caption={caption} density="default" columns={columns} className={className}>
        {children}
      </TableFrame>
    </Card>
  )
}

export const DataTable = Table

export interface TableHeaderProps {
  className?: string
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

export const TableHead = TableHeader

export interface TableHeadCellProps extends Omit<ThHTMLAttributes<HTMLTableCellElement>, 'scope' | 'align'> {
  align?: 'left' | 'right'
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
        density === 'default' ? 'text-ui font-medium' : 'font-normal',
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

const cellTone = {
  default: '',
  muted: 'text-muted-foreground',
  strong: 'font-medium text-foreground',
  foreground: 'text-foreground',
} as const

export interface TableCellProps extends Omit<TdHTMLAttributes<HTMLTableCellElement>, 'align'> {
  align?: 'left' | 'right'
  tone?: keyof typeof cellTone
  mono?: boolean
  tabular?: boolean
  ref?: Ref<HTMLTableCellElement>
}

export function TableCell({
  align = 'left',
  tone = 'default',
  mono,
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
  colSpan?: number
  className?: string
  children: ReactNode
}

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
  cells: Array<ReactNode | TableSkeletonCell>
  className?: string
}

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
