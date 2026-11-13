'use client'

import { createContext, useContext, useId, useState } from 'react'
import type { ChangeEvent, InputHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { colourTransition, focusRingPeer, peerOutlineHover } from './interaction'
import { controlMinHeight, controlSquare, touchTarget, touchTargetSquare } from './size'

interface RadioGroupContextValue {
  name?: string
  value?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null)

export interface RadioGroupProps {
  name?: string
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  orientation?: 'horizontal' | 'vertical'
  children: ReactNode
  className?: string
  'aria-label'?: string
  'aria-labelledby'?: string
}

/** Native radio group: browser arrow-key roving and form semantics come for free. */
export function RadioGroup({
  name,
  value: controlledValue,
  defaultValue,
  onValueChange,
  disabled = false,
  orientation = 'vertical',
  children,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: RadioGroupProps) {
  const generatedName = useId()
  const groupName = name ?? generatedName
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
  const isControlled = controlledValue !== undefined
  const currentValue = isControlled ? controlledValue : uncontrolledValue

  return (
    <RadioGroupContext.Provider
      value={{
        name: groupName,
        value: currentValue,
        disabled,
        onValueChange: (next) => {
          if (!isControlled) setUncontrolledValue(next)
          onValueChange?.(next)
        },
      }}
    >
      <div
        role="radiogroup"
        aria-orientation={orientation}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn('flex', orientation === 'horizontal' ? 'flex-row flex-wrap gap-4' : 'flex-col gap-1', className)}
      >
        {children}
      </div>
    </RadioGroupContext.Provider>
  )
}

export interface RadioProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'value' | 'onChange' | 'checked'> {
  value?: string
  /** Visible clickable text. Omit for a standalone radio dot. */
  label?: ReactNode
  'aria-label'?: string
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

/** Circular radio: 16px ring + centred dot; same peer-input wiring as `Checkbox`. */
export function Radio({
  label,
  'aria-label': ariaLabel,
  checked: controlledChecked,
  onCheckedChange,
  disabled: itemDisabled = false,
  className,
  id: customId,
  name: explicitName,
  value,
}: RadioProps) {
  const group = useContext(RadioGroupContext)
  const generatedId = useId()
  const id = customId ?? (label ? generatedId : undefined)
  const name = explicitName ?? group?.name
  const isChecked = group?.value !== undefined && value !== undefined ? group.value === value : controlledChecked
  const isDisabled = Boolean(group?.disabled || itemDisabled)

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onCheckedChange?.(event.target.checked)
    if (group?.onValueChange && value !== undefined) group.onValueChange(value)
  }

  const visual = (
    <span
      aria-hidden="true"
      className={cn(
        'relative flex size-4 shrink-0 items-center justify-center rounded-pill border',
        colourTransition,
        focusRingPeer,
        isChecked
          ? 'border-primary bg-surface'
          : cn('border-border-control bg-surface', !isDisabled && peerOutlineHover),
      )}
    >
      {isChecked ? <span className="size-1.5 rounded-pill bg-primary" /> : null}
    </span>
  )

  const nativeInput = (
    <input
      id={id}
      type="radio"
      name={name}
      value={value}
      checked={isChecked}
      disabled={isDisabled}
      aria-label={label ? undefined : ariaLabel}
      onChange={handleChange}
      className="peer sr-only"
    />
  )

  if (!label) {
    return (
      <label
        htmlFor={id}
        className={cn(
          'group inline-flex select-none items-center justify-center rounded-control',
          controlSquare.md,
          touchTargetSquare,
          isDisabled ? 'is-disabled' : 'cursor-pointer',
          className,
        )}
      >
        {nativeInput}
        {visual}
      </label>
    )
  }

  return (
    <label
      htmlFor={id}
      className={cn(
        'group inline-flex select-none items-center gap-2.5 text-sm text-foreground',
        controlMinHeight.md,
        touchTarget,
        isDisabled ? 'is-disabled' : 'cursor-pointer',
        className,
      )}
    >
      {nativeInput}
      {visual}
      <span>{label}</span>
    </label>
  )
}
