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
 * 多行控件：`min-h` 保留控件高度下限又不困住内容，`resize-y` 让长提示词可伸展——
 * 提交失败绝不能丢用户输入。
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
        'min-h-[88px] resize-y py-2',
        rest.disabled && 'is-disabled',
        className,
      )}
      {...rest}
    />
  )
}
