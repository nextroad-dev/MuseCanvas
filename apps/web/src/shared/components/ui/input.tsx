'use client'

import { useId } from 'react'
import type { InputHTMLAttributes, Ref } from 'react'
import { cn } from '@/shared/lib/cn'
import { useFieldContext } from './field'
import { colourTransition, outlineHover } from './interaction'
import { controlMinHeight, touchTarget } from './size'

/**
 * `Input` / `Textarea` / `Select` 共用的控件表面：白底 + `border-border-control`
 * （控件需要 3:1 描边，`border-border` 只作装饰）、10 圆角、控件 token 的
 * `min-h`（缩放/换行不裁切）、`aria-invalid` 时红边。hover 与颜色时长与其他控件
 * 一致；焦点环用全局那一套。
 */
export const controlClasses = [
  'w-full rounded-control border bg-surface px-3 text-sm text-foreground',
  colourTransition,
  'placeholder:text-muted-foreground',
  touchTarget,
  outlineHover,
  'aria-[invalid=true]:border-danger aria-[invalid=true]:bg-danger-soft',
].join(' ')

/** Two surfaces: readable outline for a standalone field, borderless tonal for dense toolbars. */
export const controlSurface = {
  outline: 'border-border-control',
  subtle: 'border-transparent bg-tonal',
} as const

export const controlHeight = {
  sm: controlMinHeight.sm,
  md: controlMinHeight.md,
  lg: controlMinHeight.lg,
} as const

export type ControlVariant = keyof typeof controlSurface
export type ControlSize = keyof typeof controlHeight

/**
 * 控件与外围 `Field` 共享的接线：label 指向的 id，以及 describedby / invalid /
 * required 属性。
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
      // `disabled` 保持原生：粘贴/自动填充仍可用，`not-disabled:` 会关掉 hover 颜色。
      className={cn(controlClasses, controlSurface[variant], controlHeight[size], rest.disabled && 'is-disabled', className)}
      {...rest}
    />
  )
}
