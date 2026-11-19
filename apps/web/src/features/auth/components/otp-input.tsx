'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { ClipboardEvent, KeyboardEvent, Ref } from 'react'
import { cn } from '@/shared/lib/cn'
import { activeOtpIndex, mergeOtpChunk, OTP_LENGTH, removeOtpDigit, sanitizeOtpChunk } from '../lib/otp'

export interface OtpInputProps {
  value: string
  onChange: (next: string) => void
  /** 格子数量；后端固定 6 位，保留参数是为了复用与测试。 */
  length?: number
  disabled?: boolean
  autoFocus?: boolean
  /** 输满（键入或粘贴）时回调；登录页据此自动提交。 */
  onComplete?: (code: string) => void
  /** 父级错误态：红边 + `aria-invalid`，错误文案由父级用 `describedBy` 关联。 */
  invalid?: boolean
  describedBy?: string
  /** 暴露第一格，便于父级在提交失败后把焦点送回验证码组。 */
  firstInputRef?: Ref<HTMLInputElement>
  /** 第一格的 id，供外部 label / 测试定位。 */
  id?: string
  /** 按 Esc 时由父级决定是否返回上一步（不阻断其它键）。 */
  onEscape?: () => void
  /** 可见的组标题；默认「验证码」。传 `null` 则只保留读屏用的 aria-label。 */
  label?: string | null
}

/**
 * 六格数字验证码输入。
 *
 * · 每格提供 `aria-label="第 n 位输入框"`，读屏能逐位读出当前进度；
 * · 整串粘贴与移动端一次性验证码自动填充会从当前格起逐位落座；
 * · 退格删除本格或回退删上一格，Delete 删除本格；
 * · ArrowLeft / ArrowRight / Home / End 在组内移动，Enter 交给外层表单提交；
 * · 输满第 6 位（键入或粘贴）通过 `onComplete` 通知父级自动提交。
 */
export function OtpInput({
  value,
  onChange,
  length = OTP_LENGTH,
  disabled = false,
  autoFocus = false,
  onComplete,
  invalid = false,
  describedBy,
  firstInputRef,
  id,
  onEscape,
  label = '验证码',
}: OtpInputProps) {
  const cellsRef = useRef<Array<HTMLInputElement | null>>([])
  const completedRef = useRef<string | null>(null)
  const digits = value.slice(0, length)
  const activeIndex = activeOtpIndex(digits, length)

  const focusCell = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(length - 1, index))
      // 受控值需等这一帧提交后再聚焦，避免选中旧值。
      requestAnimationFrame(() => {
        const cell = cellsRef.current[clamped]
        cell?.focus()
        cell?.select()
      })
    },
    [length],
  )

  useEffect(() => {
    if (!autoFocus) return
    focusCell(activeOtpIndex(digits, length))
    // 仅在挂载时定位一次；后续焦点由用户交互驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus])

  const commit = useCallback(
    (next: string, focusIndex: number | null) => {
      onChange(next)
      if (next.length === length) {
        if (completedRef.current !== next) {
          completedRef.current = next
          onComplete?.(next)
        }
      } else {
        completedRef.current = null
      }
      if (focusIndex !== null) focusCell(focusIndex)
    },
    [focusCell, length, onChange, onComplete],
  )

  function handleChange(index: number, raw: string) {
    if (disabled) return
    const chunk = sanitizeOtpChunk(raw, length)
    if (chunk.length > 1) {
      commit(mergeOtpChunk(digits, chunk, index, length), Math.min(index + chunk.length, length - 1))
      return
    }
    if (chunk === '') {
      commit(removeOtpDigit(digits, index, length), Math.max(0, index))
      return
    }
    commit(mergeOtpChunk(digits, chunk, index, length), Math.min(index + 1, length - 1))
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      onEscape?.()
      return
    }
    if (disabled) return

    if (event.key === 'Backspace') {
      event.preventDefault()
      if (digits[index]) {
        commit(removeOtpDigit(digits, index, length), index)
      } else if (index > 0) {
        commit(removeOtpDigit(digits, index - 1, length), index - 1)
      }
      return
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      if (digits[index]) {
        commit(removeOtpDigit(digits, index, length), index)
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
      focusCell(length - 1)
    }
  }

  function handlePaste(index: number, event: ClipboardEvent<HTMLInputElement>) {
    if (disabled) return
    const chunk = sanitizeOtpChunk(event.clipboardData?.getData('text') ?? '', length)
    if (!chunk) return
    event.preventDefault()
    commit(mergeOtpChunk(digits, chunk, index, length), Math.min(index + chunk.length, length - 1))
  }

  function assignCell(index: number) {
    return (node: HTMLInputElement | null) => {
      cellsRef.current[index] = node
      if (index !== 0) return
      if (typeof firstInputRef === 'function') firstInputRef(node)
      else if (firstInputRef) (firstInputRef as { current: HTMLInputElement | null }).current = node
    }
  }

  return (
    <fieldset className="m-0 flex min-w-0 flex-col border-0 p-0">
      {label ? <legend className="mb-2 text-sm font-medium text-foreground">{label}</legend> : null}
      <div className={cn('grid grid-cols-6 gap-2 sm:gap-2.5', invalid && 'motion-shake')}>
        {Array.from({ length }, (_, index) => {
          const isActive = index === activeIndex
          const hasValue = Boolean(digits[index])
          return (
            <input
              key={index}
              ref={assignCell(index)}
              id={index === 0 ? id : undefined}
              type="text"
              inputMode="numeric"
              autoComplete={index === 0 ? 'one-time-code' : 'off'}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={length}
              value={digits[index] ?? ''}
              disabled={disabled}
              aria-label={`第 ${index + 1} 位输入框`}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => handleChange(index, event.target.value)}
              onKeyDown={(event) => handleKeyDown(index, event)}
              onPaste={(event) => handlePaste(index, event)}
              onFocus={(event) => event.target.select()}
              className={cn(
                'h-12 min-w-0 rounded-control border bg-surface text-center font-mono text-subtitle font-medium tabular-nums text-foreground transition-[border-color,background-color,box-shadow,transform] duration-[var(--motion-spring-snappy)] ease-spring-snappy outline-none',
                'focus-visible:border-border-focus focus-visible:bg-surface focus-visible:ring-2 focus-visible:ring-accent-soft',
                invalid
                  ? 'border-danger bg-danger-soft text-danger focus-visible:border-danger focus-visible:ring-danger/20'
                  : isActive && !disabled
                    ? 'scale-[1.02] border-border-focus bg-surface shadow-soft ring-2 ring-accent-soft'
                    : hasValue
                      ? 'border-border-strong bg-surface'
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
