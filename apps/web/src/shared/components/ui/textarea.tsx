'use client'

import type { Ref, TextareaHTMLAttributes } from 'react'
import { cn } from '@/shared/lib/cn'
import { controlClasses, controlSurface, useControlWiring } from './input'
import type { ControlVariant } from './input'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: ControlVariant
  invalid?: boolean
  ref?: Ref<HTMLTextAreaElement>
}

/**
 * 多行输入控件：保留 `resize-y` 与合理最小高度，与 `Input` 共享表面与描边规范。
 */
export function Textarea({ variant = 'outline', invalid, className, id, rows = 3, ...rest }: TextareaProps) {
  const { field, id: controlId } = useControlWiring(id)
  const isError = invalid ?? field?.invalid ?? false

  return (
    <textarea
      id={controlId}
      rows={rows}
      aria-invalid={isError || undefined}
      aria-describedby={field?.describedBy || undefined}
      aria-required={field?.required || undefined}
      className={cn(
        controlClasses,
        controlSurface[variant],
        'min-h-22 resize-y py-2',
        rest.disabled && 'is-disabled',
        className,
      )}
      {...rest}
    />
  )
}
