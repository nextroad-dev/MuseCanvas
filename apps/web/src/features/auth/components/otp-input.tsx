'use client'

import { useRef } from 'react'
import type { ClipboardEvent, KeyboardEvent, Ref } from 'react'
import { cn } from '@/shared/lib/cn'

/** The backend issues 6-digit numeric codes; the grid is fixed at six cells. */
export const OTP_LENGTH = 6

/** Keep ASCII digits only, capped at the code length. */
export function sanitizeOtpChunk(raw: string): string {
  return raw.replace(/[^0-9]/g, '').slice(0, OTP_LENGTH)
}

export interface OtpInputProps {
  value: string
  onChange: (next: string) => void
  /** Fires once the sixth digit lands (typing or pasting). The parent submits. */
  onComplete?: (code: string) => void
  disabled?: boolean
  autoFocus?: boolean
  /** Receives the first cell so a failed submit can move focus to the group. */
  firstInputRef?: Ref<HTMLInputElement>
  /** Id for the first cell, so an external label or `htmlFor` can still target the code. */
  id?: string
  /** Mirrors the parent's error state: red cells and `aria-invalid` on every cell. */
  invalid?: boolean
  /** Space-separated ids of the parent's hint or error node, for `aria-describedby`. */
  describedBy?: string
}

/**
 * Six-cell verification code input (login design board 06).
 *
 * The cells sit in a `fieldset` whose visible legend names the code, so the group
 * is announced by its legend rather than a separate label. Each cell carries
 * `aria-label` 第 n 位 so a screen reader names every stop. Typing the sixth digit
 * (or pasting a full code) calls `onComplete`; Backspace on an empty cell steps back
 * and clears the previous one. Enter still submits the surrounding form. The parent
 * owns the hint and error text and passes their id in as `describedBy`.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus,
  firstInputRef,
  id,
  invalid = false,
  describedBy,
}: OtpInputProps) {
  const cellsRef = useRef<Array<HTMLInputElement | null>>([])
  const completedRef = useRef<string | null>(null)
  const digits = sanitizeOtpChunk(value)

  function focusCell(index: number) {
    const clamped = Math.max(0, Math.min(OTP_LENGTH - 1, index))
    cellsRef.current[clamped]?.focus()
    cellsRef.current[clamped]?.select()
  }

  function commit(next: string, focusIndex: number | null) {
    onChange(next)
    if (next.length === OTP_LENGTH) {
      if (completedRef.current !== next) {
        completedRef.current = next
        onComplete?.(next)
      }
    } else {
      completedRef.current = null
    }
    if (focusIndex !== null) {
      // The newly rendered cell exists after this commit paints.
      requestAnimationFrame(() => focusCell(focusIndex))
    }
  }

  function setCellRef(index: number) {
    return (node: HTMLInputElement | null) => {
      cellsRef.current[index] = node
      if (index === 0) {
        if (typeof firstInputRef === 'function') firstInputRef(node)
        else if (firstInputRef) (firstInputRef as { current: HTMLInputElement | null }).current = node
      }
      if (node && autoFocus && index === 0 && document.activeElement !== node) {
        const firstEmpty = digits.split('').findIndex((digit) => !digit)
        if (index === 0) {
          // Focus lands on the first empty cell (or the first cell when full)
          // once, right after the group mounts on the code step.
          const target = firstEmpty === -1 ? 0 : firstEmpty
          if (target === 0) node.focus()
          else requestAnimationFrame(() => focusCell(target))
        }
      }
    }
  }

  function handleCellChange(index: number, raw: string) {
    if (disabled) return
    const chunk = sanitizeOtpChunk(raw)
    const current = digits.split('')
    if (chunk.length > 1) {
      // Autocomplete / IME / mobile autofill dropped a run into one cell.
      const next = [...current]
      for (let offset = 0; offset < chunk.length && index + offset < OTP_LENGTH; offset += 1) {
        next[index + offset] = chunk[offset]
      }
      const joined = next.join('').slice(0, OTP_LENGTH)
      const filled = joined.length
      commit(joined, filled >= OTP_LENGTH ? OTP_LENGTH - 1 : Math.min(index + chunk.length, OTP_LENGTH - 1))
      return
    }
    const next = [...current]
    if (chunk === '') {
      delete next[index]
    } else {
      next[index] = chunk
    }
    const joined = next.join('').slice(0, OTP_LENGTH)
    commit(joined, chunk === '' ? index : Math.min(index + 1, OTP_LENGTH - 1))
  }

  function handleCellKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return
    const current = digits.split('')
    if (event.key === 'Backspace') {
      if (!current[index]) {
        // Empty cell: step back and clear the previous digit in one gesture.
        event.preventDefault()
        if (index > 0) {
          const next = [...current]
          delete next[index - 1]
          commit(next.join('').slice(0, OTP_LENGTH), index - 1)
        }
      } else if (current.length === OTP_LENGTH && index === OTP_LENGTH - 1) {
        // Full code: one Backspace clears the last cell without leaving.
        event.preventDefault()
        const next = [...current]
        delete next[index]
        commit(next.join('').slice(0, OTP_LENGTH), index)
      }
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusCell(index - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusCell(index + 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusCell(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusCell(OTP_LENGTH - 1)
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>, index: number) {
    if (disabled) return
    const chunk = sanitizeOtpChunk(event.clipboardData?.getData('text') ?? '')
    if (!chunk) return
    event.preventDefault()
    const next = digits.split('')
    for (let offset = 0; offset < chunk.length && index + offset < OTP_LENGTH; offset += 1) {
      next[index + offset] = chunk[offset]
    }
    const joined = next.join('').slice(0, OTP_LENGTH)
    const lastFilled = Math.min(index + chunk.length, OTP_LENGTH) - 1
    commit(joined, joined.length >= OTP_LENGTH ? OTP_LENGTH - 1 : lastFilled)
  }

  const firstEmpty = digits.split('').findIndex((digit) => !digit)
  const activeIndex = firstEmpty === -1 ? OTP_LENGTH - 1 : firstEmpty

  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-2 text-sm font-medium text-foreground">验证码</legend>
      <div className="grid grid-cols-6 gap-2">
        {Array.from({ length: OTP_LENGTH }, (_, index) => {
          const isActive = index === activeIndex
          return (
            <input
              key={index}
              ref={setCellRef(index)}
              id={index === 0 ? id : undefined}
              type="text"
              inputMode="numeric"
              autoComplete={index === 0 ? 'one-time-code' : 'off'}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={OTP_LENGTH}
              value={digits[index] ?? ''}
              disabled={disabled}
              aria-label={`第 ${index + 1} 位`}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={describedBy}
              onChange={(event) => handleCellChange(index, event.target.value)}
              onKeyDown={(event) => handleCellKeyDown(index, event)}
              onPaste={(event) => handlePaste(event, index)}
              onFocus={(event) => event.target.select()}
              className={cn(
                'h-[var(--control-xl)] min-w-0 rounded-control border bg-surface text-center font-mono text-[22px] tabular-nums text-foreground transition-colors placeholder:text-muted-foreground',
                invalid
                  ? 'border-danger bg-danger-soft'
                  : isActive
                    ? 'border-2 border-border-focus'
                    : 'border-border-control',
                disabled && 'is-disabled',
              )}
            />
          )
        })}
      </div>
    </fieldset>
  )
}
