'use client'

import { createContext, useContext, useId } from 'react'
import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { WarningCircleIcon as CircleAlert } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { iconSize } from './size'

export interface FormFieldContextValue {
  /** Control id the `<label htmlFor>` points at — also the base for hint/error ids. */
  id: string
  /** Space-separated ids of the help/error nodes, for `aria-describedby`. */
  describedBy: string
  /** True while an error message is showing; drives `aria-invalid` + red border. */
  invalid: boolean
  required?: boolean
  disabled?: boolean
}

const FormFieldContext = createContext<FormFieldContextValue | null>(null)

/** Read by `Input` / `Textarea` / `Select` so they self-wire inside a `FormField`. */
export function useFormFieldContext(): FormFieldContextValue | null {
  return useContext(FormFieldContext)
}

export interface FormFieldProps extends HTMLAttributes<HTMLDivElement> {
  /** Omit to let `FormField` generate one and hand it to the control via context. */
  id?: string
  label: ReactNode
  required?: boolean
  /** 12px secondary text under the control. Replaced by `error` when set. */
  hint?: ReactNode
  error?: ReactNode
  /** Hide the hint once an error shows (default) or keep both. */
  keepHintOnError?: boolean
  ref?: Ref<HTMLDivElement>
  children: ReactNode
}

/**
 * Label + control + help/error wrapper (components.md 补充组件规范 → Form Field).
 * Spacing is fixed by the spec and therefore not configurable: label→control 8px,
 * control→hint 4px, field→field 24px (see `FieldGroup`). The error node replaces
 * the help slot, carries a 12px leading icon and is linked by `aria-describedby`.
 */
export function FormField({
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
}: FormFieldProps) {
  const auto = useId()
  const controlId = id ?? `field${auto}`
  const hintId = `${controlId}-hint`
  const errorId = `${controlId}-error`
  const showError = Boolean(error)
  const showHint = Boolean(hint) && (!showError || keepHintOnError)
  const describedBy = [showError ? errorId : null, showHint ? hintId : null].filter(Boolean).join(' ')

  return (
    <FormFieldContext.Provider value={{ id: controlId, describedBy, invalid: showError, required }}>
      <div ref={ref} className={cn('flex flex-col', className)} {...rest}>
        <label htmlFor={controlId} className="mb-2 text-sm font-medium text-foreground">
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
          <p id={errorId} className="mt-1 flex items-start gap-1 text-xs text-danger">
            <CircleAlert weight="fill" aria-hidden="true" className={`mt-0.5 ${iconSize.xs} shrink-0`} />
            <span>{error}</span>
          </p>
        ) : null}

        {showHint ? (
          <p id={hintId} className="mt-1 text-xs text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    </FormFieldContext.Provider>
  )
}

export interface FieldGroupProps extends HTMLAttributes<HTMLDivElement> {
  ref?: Ref<HTMLDivElement>
}

/** Stack of `FormField`s. The 24px between fields is the spec's field gap. */
export function FieldGroup({ className, ref, ...rest }: FieldGroupProps) {
  return <div ref={ref} className={cn('flex flex-col gap-6', className)} {...rest} />
}
