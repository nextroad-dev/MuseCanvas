'use client'

import { useRef, useState } from 'react'

interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Accessible name. Pair with a visible label via `labelledBy` when one exists. */
  'aria-label'?: string
  'aria-labelledby'?: string
  disabled?: boolean
}

/**
 * Immediate-setting toggle: tonal track, clear thumb, and honest failure
 * handling — if `onCheckedChange` throws/rejects, the thumb springs back to
 * the previous value so the control never lies about what was persisted.
 * Native button semantics give Enter/Space activation for free.
 */
export function Switch({ checked, onCheckedChange, disabled, ...aria }: SwitchProps) {
  const [pending, setPending] = useState(false)
  const lastError = useRef('')

  const handleToggle = async () => {
    if (disabled || pending) return
    const next = !checked
    setPending(true)
    try {
      await onCheckedChange(next)
      lastError.current = ''
    } catch {
      // Visual state never moved (checked prop unchanged) — the failure is the
      // caller's to surface; remember it for the accessible name.
      lastError.current = '，保存失败，设置未更改'
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled || pending}
      onClick={handleToggle}
      className={`inline-flex h-10 min-w-14 items-center rounded-pill px-2 transition-colors motion-press ${
        checked ? 'justify-end bg-primary' : 'justify-start bg-surface-subtle-strong'
      } ${disabled ? 'opacity-50' : ''}`}
      {...aria}
      aria-label={
        aria['aria-label']
          ? `${aria['aria-label']}${checked ? '，已开启' : '，已关闭'}${lastError.current}`
          : undefined
      }
    >
      <span
        aria-hidden="true"
        className={`h-5 w-5 rounded-full shadow-sm transition-transform motion-hover-fade ${
          checked ? 'bg-foreground-inverse' : 'bg-surface'
        }`}
        style={{ transitionDuration: 'var(--motion-base)' }}
      />
    </button>
  )
}
