'use client'

import { useId } from 'react'

interface CheckboxProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Visible clickable text. Omit for a standalone box (icon tiles, table rows). */
  label?: string
  'aria-label'?: string
  disabled?: boolean
}

/**
 * Native input (keyboard, autofill, form semantics) restyled to the system:
 * 5px checkbox radius, control-border outline, ink fill when checked. The
 * input stays focusable and screen-reader-visible — the styled box is a
 * sibling, not a replacement.
 */
export function Checkbox({ checked, onCheckedChange, label, disabled, ...aria }: CheckboxProps) {
  const id = useId()
  const box = (
    <>
      <input
        id={label ? id : undefined}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
        aria-label={label ? undefined : aria['aria-label']}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`inline-flex h-4 w-4 items-center justify-center rounded-checkbox border transition-colors motion-hover-fade peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary ${
          checked
            ? 'border-primary bg-primary'
            : 'border-border-control bg-surface hover:border-foreground'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 256 256"
          fill="none"
          className={`text-foreground-inverse transition-opacity ${checked ? 'opacity-100' : 'opacity-0'}`}
        >
          <path d="M48 136l48 48 112-112" stroke="currentColor" strokeWidth="28" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </>
  )

  if (!label) {
    return <span className="inline-flex">{box}</span>
  }
  return (
    <label htmlFor={id} className={`inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm leading-[1.5] text-foreground ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}>
      {box}
      {label}
    </label>
  )
}
