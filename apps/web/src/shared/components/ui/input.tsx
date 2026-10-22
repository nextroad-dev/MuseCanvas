'use client'

import { useId } from 'react'
import type { InputHTMLAttributes, Ref, TextareaHTMLAttributes } from 'react'
import { cn } from '@/shared/lib/cn'
import { useFormFieldContext } from './field'
import { colourTransition, outlineHover } from './interaction'
import { controlMinHeight } from './size'

/**
 * Shared control surface for `Input` / `Textarea` / `Select` (states.md §3):
 * white surface + `border-border-control` (3.6:1, the outline a control needs —
 * `border-border` is decoration only), 10px radius, 40px min-height via
 * min-height so zoom and wrapping never clip it, error red on `aria-invalid`.
 * Hover and colour timing match every other control (`interaction.ts`); no focus
 * utility here: globals.css paints the one ring.
 */
export const controlClasses = [
  'w-full rounded-control border bg-surface px-3 text-sm text-foreground',
  colourTransition,
  'placeholder:text-muted-foreground',
  outlineHover,
  'aria-[invalid=true]:border-danger aria-[invalid=true]:bg-danger-soft',
].join(' ')

export const controlSurface = {
  /** Readable outline for a standalone field. */
  outline: 'border-border-control',
  /** Borderless tonal fill: dense toolbars and inline editors (components.md Input row). */
  subtle: 'border-transparent bg-tonal',
} as const

export const controlHeight = {
  sm: controlMinHeight.sm,
  md: controlMinHeight.md,
  lg: controlMinHeight.lg,
} as const

export type ControlVariant = keyof typeof controlSurface
export type ControlSize = keyof typeof controlHeight

/** Wiring every control shares with its enclosing `FormField`. */
function useFieldWiring(providedId?: string) {
  const fallbackId = useId()
  const field = useFormFieldContext()
  return { field, id: field?.id ?? providedId ?? fallbackId }
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  variant?: ControlVariant
  size?: ControlSize
  /** Error state when the input is *not* inside a `FormField`. */
  invalid?: boolean
  ref?: Ref<HTMLInputElement>
}

export function Input({ variant = 'outline', size = 'md', invalid, className, id, ...rest }: InputProps) {
  const { field, id: controlId } = useFieldWiring(id)
  const isError = invalid ?? field?.invalid ?? false

  return (
    <input
      id={controlId}
      aria-invalid={isError ? true : undefined}
      aria-describedby={field?.describedBy || undefined}
      aria-required={field?.required ? true : undefined}
      // `disabled` stays native: paste, autofill and copy keep working on the
      // enabled path, and `not-disabled:` variants switch the hover paint off.
      className={cn(controlClasses, controlSurface[variant], controlHeight[size], rest.disabled && 'is-disabled', className)}
      {...rest}
    />
  )
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: ControlVariant
  invalid?: boolean
  ref?: Ref<HTMLTextAreaElement>
}

/**
 * Multiline control. `min-h` plus `resize-y` keeps the 40px floor without
 * trapping content: a failed submit must never lose what the user typed
 * (components.md Input row: 失败保留输入).
 */
export function Textarea({
  variant = 'outline',
  invalid,
  className,
  id,
  rows = 3,
  ...rest
}: TextareaProps) {
  const { field, id: controlId } = useFieldWiring(id)
  const isError = invalid ?? field?.invalid ?? false

  return (
    <textarea
      id={controlId}
      rows={rows}
      aria-invalid={isError ? true : undefined}
      aria-describedby={field?.describedBy || undefined}
      aria-required={field?.required ? true : undefined}
      className={cn(
        controlClasses,
        controlSurface[variant],
        'min-h-[88px] resize-y py-2',
        rest.disabled && 'is-disabled',
        className,
      )}
      {...rest}
    />
  )
}
