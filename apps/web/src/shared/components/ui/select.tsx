'use client'

import type { ReactNode, Ref, SelectHTMLAttributes } from 'react'
import { cn } from '@/shared/lib/cn'
import { controlClasses, controlHeight, controlSurface, useControlWiring } from './input'
import type { ControlSize, ControlVariant } from './input'

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
 * 原生 `<select>` 重新描样：键盘、type-ahead 与移动端选择器都来自平台，
 * `appearance-none` 去掉系统外观，不渲染额外的箭头图标。
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
    <span className={cn('relative flex items-center', WIDTH_CLASS[width], className)}>
      <select
        id={controlId}
        aria-invalid={isError || undefined}
        aria-describedby={field?.describedBy || undefined}
        aria-required={field?.required || undefined}
        className={cn(
          controlClasses,
          controlSurface[variant],
          controlHeight[size],
          'cursor-pointer appearance-none',
          rest.disabled && 'is-disabled',
          selectClassName,
        )}
        {...rest}
      >
        {children}
      </select>
    </span>
  )
}
