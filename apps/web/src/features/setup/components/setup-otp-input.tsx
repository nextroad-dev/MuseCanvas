'use client'

// 安装向导专用的 6 位验证码输入。保持最小可用行为：
// 数字清洗、整串粘贴、退格回退、方向键、输满自动提交。

import { useEffect, useRef } from 'react'
import type { ClipboardEvent, KeyboardEvent, Ref } from 'react'

import { cn } from '@/shared/lib/cn'

const OTP_LENGTH = 6

function sanitize(raw: string): string {
  return raw.replace(/[^0-9]/g, '').slice(0, OTP_LENGTH)
}

export interface SetupOtpInputProps {
  value: string
  onChange: (next: string) => void
  /** 输满 6 位（键入或粘贴）时回调；管理员步骤据此自动提交。 */
  onComplete?: (code: string) => void
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
  label?: string
  /** 暴露第一格，便于提交失败后把焦点送回验证码组。 */
  firstInputRef?: Ref<HTMLInputElement>
}

export function SetupOtpInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
  autoFocus = false,
  label = '验证码',
  firstInputRef,
}: SetupOtpInputProps) {
  const cellsRef = useRef<Array<HTMLInputElement | null>>([])
  const completedRef = useRef<string | null>(null)
  const digits = sanitize(value)
  const activeIndex = Math.min(digits.length, OTP_LENGTH - 1)

  function focusCell(index: number) {
    const node = cellsRef.current[Math.max(0, Math.min(OTP_LENGTH - 1, index))]
    node?.focus()
    node?.select()
  }

  useEffect(() => {
    if (autoFocus) focusCell(0)
  }, [autoFocus])

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
    if (focusIndex !== null) requestAnimationFrame(() => focusCell(focusIndex))
  }

  /** 在 `index` 位置写入一段数字，返回合并后的值与落座位置。 */
  function merge(index: number, chunk: string): { next: string; focusIndex: number } {
    const merged = digits.padEnd(OTP_LENGTH, ' ').split('')
    for (let offset = 0; offset < chunk.length && index + offset < OTP_LENGTH; offset += 1) {
      merged[index + offset] = chunk[offset]
    }
    const next = merged.join('').replace(/ /g, '').slice(0, OTP_LENGTH)
    return { next, focusIndex: Math.min(index + chunk.length, OTP_LENGTH - 1) }
  }

  function handleChange(index: number, raw: string) {
    if (disabled) return
    const chunk = sanitize(raw)
    if (chunk.length > 1) {
      const result = merge(index, chunk)
      commit(result.next, result.focusIndex)
      return
    }
    if (chunk === '') {
      const next = (digits.slice(0, index) + digits.slice(index + 1)).slice(0, OTP_LENGTH)
      commit(next, index)
      return
    }
    const result = merge(index, chunk)
    commit(result.next, result.focusIndex)
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return
    if (event.key === 'Backspace') {
      event.preventDefault()
      if (digits[index]) {
        commit((digits.slice(0, index) + digits.slice(index + 1)).slice(0, OTP_LENGTH), index)
      } else if (index > 0) {
        const previous = index - 1
        commit((digits.slice(0, previous) + digits.slice(previous + 1)).slice(0, OTP_LENGTH), previous)
      }
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusCell(index - 1)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusCell(index + 1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      focusCell(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      focusCell(OTP_LENGTH - 1)
    }
  }

  function handlePaste(index: number, event: ClipboardEvent<HTMLInputElement>) {
    if (disabled) return
    const chunk = sanitize(event.clipboardData?.getData('text') ?? '')
    if (!chunk) return
    event.preventDefault()
    const result = merge(index, chunk)
    commit(result.next, result.focusIndex)
  }

  return (
    <fieldset className="m-0 flex min-w-0 flex-col border-0 p-0">
      <legend className="mb-2 text-sm font-medium text-foreground">{label}</legend>
      <div className="grid grid-cols-6 gap-2">
        {Array.from({ length: OTP_LENGTH }, (_, index) => {
          const isActive = index === activeIndex
          return (
            <input
              key={index}
              ref={(node) => {
                cellsRef.current[index] = node
                if (index !== 0) return
                if (typeof firstInputRef === 'function') firstInputRef(node)
                else if (firstInputRef) (firstInputRef as { current: HTMLInputElement | null }).current = node
              }}
              type="text"
              inputMode="numeric"
              autoComplete={index === 0 ? 'one-time-code' : 'off'}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={OTP_LENGTH}
              value={digits[index] ?? ''}
              disabled={disabled}
              aria-label={`第 ${index + 1} 位输入框`}
              aria-invalid={invalid || undefined}
              onChange={(event) => handleChange(index, event.target.value)}
              onKeyDown={(event) => handleKeyDown(index, event)}
              onPaste={(event) => handlePaste(index, event)}
              onFocus={(event) => event.target.select()}
              className={cn(
                'h-12 min-w-0 rounded-control border bg-surface text-center font-mono text-subtitle tabular-nums text-foreground transition-colors',
                invalid
                  ? 'border-danger bg-danger-soft'
                  : isActive
                    ? 'border-border-focus'
                    : 'border-border-control hover:border-border-strong',
                disabled && 'is-disabled',
              )}
            />
          )
        })}
      </div>
    </fieldset>
  )
}
