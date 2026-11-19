'use client'

import { createContext, useContext, useId } from 'react'
import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { WarningCircleIcon as CircleAlert } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { iconSize } from './size'

export interface FieldContextValue {
  /** Control id the `<label htmlFor>` points at — also the base for hint/error ids. */
  id: string
  /** Space-separated ids of the help/error nodes, for `aria-describedby`. */
  describedBy: string
  /** True while an error message is showing; drives `aria-invalid` + red border. */
  invalid: boolean
  required?: boolean
  disabled?: boolean
}

const FieldContext = createContext<FieldContextValue | null>(null)

/** Read by `Input` / `Textarea` / `Select` so they self-wire inside a `Field`. */
export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext)
}

/** Back-compat alias for the old name. */
export const useFormFieldContext = useFieldContext

export interface FieldProps extends HTMLAttributes<HTMLDivElement> {
  /** Omit to let `Field` generate one and hand it to the control via context. */
  id?: string
  label: ReactNode
  required?: boolean
  /** 12px secondary text under the control. Replaced by `error` when set. */
  hint?: ReactNode
  error?: ReactNode
  /** Keep the hint visible even while an error shows. */
  keepHintOnError?: boolean
  ref?: Ref<HTMLDivElement>
  children: ReactNode
}

/**
 * label + 控件 + 提示/错误包装器。错误节点替换提示槽位，并通过 `aria-describedby`
 * 关联；`aria-invalid` 由 `error` 推导，保证红边永远伴随读屏播报。
 */
export function Field({
  id,
  label,
  required,
  hint,
  error,
  keepHintOnError,
  className,
  ref,
  children,
  ...rest
}: FieldProps) {
  const auto = useId()
  const controlId = id ?? `field${auto}`
  const hintId = `${controlId}-hint`
  const errorId = `${controlId}-error`
  const showError = Boolean(error)
  const showHint = Boolean(hint) && (!showError || keepHintOnError)
  const describedBy = [showError ? errorId : null, showHint ? hintId : null].filter(Boolean).join(' ')

  return (
    <FieldContext.Provider value={{ id: controlId, describedBy, invalid: showError, required }}>
      <div ref={ref} className={cn('flex flex-col', className)} {...rest}>
        <label htmlFor={controlId} className="mb-1.5 text-sm font-medium text-foreground">
          {label}
          {required ? (
            <>
              {' '}
              <span aria-hidden="true" className="text-danger">
                *
              </span>
              <span className="sr-only">（必填）</span>
            </>
          ) : null}
        </label>

        {children}

        {showError ? (
          <p id={errorId} className="mt-1.5 flex items-start gap-1 text-xs text-danger">
            <CircleAlert weight="fill" aria-hidden="true" className={cn('mt-0.5 shrink-0', iconSize.xs)} />
            <span>{error}</span>
          </p>
        ) : null}

        {showHint ? (
          <p id={hintId} className="mt-1.5 text-xs text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  )
}

/** Alias kept so older call sites/imports keep working. */
export const FormField = Field

export type FieldGroupProps = HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }

/** Stack of fields with clean vertical rhythm. */
export function FieldGroup({ className, ref, ...rest }: FieldGroupProps) {
  return <div ref={ref} className={cn('flex flex-col gap-5', className)} {...rest} />
}
