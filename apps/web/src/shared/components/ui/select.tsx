'use client'

import { useId } from 'react'
import type { ReactNode, Ref, SelectHTMLAttributes } from 'react'
import { CaretDownIcon as ChevronDown } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { useFormFieldContext } from './field'
import { controlClasses, controlHeight, controlSurface } from './input'
import type { ControlSize, ControlVariant } from './input'
import { iconSize } from './size'

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  variant?: ControlVariant
  size?: ControlSize
  /** Error state when the select is *not* inside a `FormField`. */
  invalid?: boolean
  /**
   * Wrapper sizing. `full` (default) fills the field — what a stacked form wants.
   * `content` sizes the wrapper to the longest option, which is what a dense
   * toolbar needs: without it a `flex-col` field stretches the control across the
   * whole row. Reach for this instead of hand-writing `w-auto shrink-0` here and
   * at every toolbar.
   */
  width?: 'full' | 'content'
  /** Escape hatch for the `<select>` itself; `className` sizes the wrapper. */
  selectClassName?: string
  ref?: Ref<HTMLSelectElement>
  children: ReactNode
}

/** Registered with tailwind-merge as width utilities, so a caller's `className`
 *  replaces the default rather than stacking next to it. */
const WIDTH_CLASS = {
  full: 'w-full',
  content: 'w-fit shrink-0',
} as const

/**
 * Native `<select>` restyled (components.md: 简单选择优先原生 select). Keyboard,
 * type-ahead and the mobile picker come from the platform, and the chosen value
 * is always visible — `appearance-none` removes only the OS chrome, and the
 * decorative chevron is pointer-transparent so it never eats a click.
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
  const fallbackId = useId()
  const field = useFormFieldContext()
  const selectId = field?.id ?? id ?? fallbackId
  const isError = invalid ?? field?.invalid ?? false

  return (
    <span className={cn('relative flex items-center', WIDTH_CLASS[width], className)}>
      <select
        id={selectId}
        aria-invalid={isError ? true : undefined}
        aria-describedby={field?.describedBy || undefined}
        aria-required={field?.required ? true : undefined}
        className={cn(
          controlClasses,
          controlSurface[variant],
          controlHeight[size],
          'cursor-pointer appearance-none pr-9',
          rest.disabled && 'is-disabled',
          selectClassName,
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown weight="bold"
        aria-hidden="true"
        className={`pointer-events-none absolute right-3 ${iconSize.sm} text-muted-foreground`}
      />
    </span>
  )
}
