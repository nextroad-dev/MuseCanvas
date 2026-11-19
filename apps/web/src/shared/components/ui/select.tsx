'use client'

import type { ReactNode, Ref, SelectHTMLAttributes } from 'react'
import { CaretDownIcon } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { controlClasses, controlHeight, controlSurface, useControlWiring } from './input'
import type { ControlSize, ControlVariant } from './input'
import { iconSize } from './size'

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  variant?: ControlVariant
  size?: ControlSize
  /** Error state when the select is *not* inside a `Field`. */
  invalid?: boolean
  /** `full` fills the field; `content` sizes to the longest option (toolbars). */
  width?: 'full' | 'content'
  /** Escape hatch for the `<select>` itself; `className` sizes the wrapper. */
  selectClassName?: string
  ref?: Ref<HTMLSelectElement>
  children: ReactNode
}

const WIDTH_CLASS = {
  full: 'w-full',
  content: 'w-fit shrink-0',
} as const

/**
 * 原生 `<select>` 统一样式封装：内置右侧 `CaretDown` 指示箭头，
 * 完整保留原生键盘导航、type-ahead 与移动端选择器体验。
 */
export function Select({
  variant = 'outline',
  size = 'md',
  invalid,
  width = 'full',
  className,
  selectClassName,
  id,
  children,
  ...rest
}: SelectProps) {
  const { field, id: controlId } = useControlWiring(id)
  const isError = invalid ?? field?.invalid ?? false

  return (
    <span className={cn('relative inline-flex items-center', WIDTH_CLASS[width], className)}>
      <select
        id={controlId}
        aria-invalid={isError || undefined}
        aria-describedby={field?.describedBy || undefined}
        aria-required={field?.required || undefined}
        className={cn(
          controlClasses,
          controlSurface[variant],
          controlHeight[size],
          'cursor-pointer appearance-none pr-8',
          rest.disabled && 'is-disabled',
          selectClassName,
        )}
        {...rest}
      >
        {children}
      </select>
      <CaretDownIcon
        weight="bold"
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute right-2.5 text-muted-foreground',
          iconSize.xs,
          rest.disabled && 'is-disabled',
        )}
      />
    </span>
  )
}
