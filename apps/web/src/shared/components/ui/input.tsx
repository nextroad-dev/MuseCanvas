'use client'

import { useId } from 'react'
import type { InputHTMLAttributes, Ref } from 'react'
import { cn } from '@/shared/lib/cn'
import { useFieldContext } from './field'
import { colourTransition, outlineHover } from './interaction'
import { controlMinHeight, touchTarget } from './size'

/**
 * `Input` / `Textarea` / `Select` 共享的控件表面：
 * 统一 `rounded-control`（10px）、柔和清晰 `border-border-control`、
 * 与 `Button` 像素级对齐的 3 档高度（sm 32 / md 36 默认 / lg 44）。
 */
export const controlClasses = [
  'w-full rounded-control border bg-surface px-3 text-sm text-foreground',
  colourTransition,
  'placeholder:text-muted-foreground',
  touchTarget,
  outlineHover,
  'focus-visible:border-border-focus',
  'aria-[invalid=true]:border-danger aria-[invalid=true]:bg-danger-soft',
].join(' ')

export const controlSurface = {
  outline: 'border-border-control bg-surface',
  subtle: 'border-transparent bg-tonal hover:border-border-control',
} as const

export const controlHeight = {
  sm: `${controlMinHeight.sm} text-ui`,
  md: `${controlMinHeight.md} text-sm`,
  lg: `${controlMinHeight.lg} text-sm`,
} as const

export type ControlVariant = keyof typeof controlSurface
export type ControlSize = keyof typeof controlHeight

/**
 * 控件与外围 `Field` 共享的接线：label 指向的 id，以及 describedby / invalid / required 属性。
 */
export function useControlWiring(providedId?: string) {
  const fallbackId = useId()
  const field = useFieldContext()
  return { field, id: field?.id ?? providedId ?? fallbackId }
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  variant?: ControlVariant
  size?: ControlSize
  /** Error state when the input is *not* inside a `Field`. */
  invalid?: boolean
  ref?: Ref<HTMLInputElement>
}

export function Input({ variant = 'outline', size = 'md', invalid, className, id, ...rest }: InputProps) {
  const { field, id: controlId } = useControlWiring(id)
  const isError = invalid ?? field?.invalid ?? false

  return (
    <input
      id={controlId}
      aria-invalid={isError || undefined}
      aria-describedby={field?.describedBy || undefined}
      aria-required={field?.required || undefined}
      className={cn(
        controlClasses,
        controlSurface[variant],
        controlHeight[size],
        rest.disabled && 'is-disabled',
        className,
      )}
      {...rest}
    />
  )
}
