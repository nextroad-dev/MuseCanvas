'use client'

import { useState } from 'react'
import { CircleNotchIcon as Loader2 } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { outlineHover } from './interaction'
import { controlSquare } from './size'

interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Accessible name. Pair with a visible label via `aria-labelledby` when one exists. */
  'aria-label'?: string
  'aria-labelledby'?: string
  disabled?: boolean
}

/** Track 32px (`--control-sm`) × 56px, thumb 24px (`--control-xs`) with a 3px
 *  inset, so the glide distance is exactly 24px. */
const TRACK_CLASS = 'inline-flex h-[var(--control-sm)] w-14 shrink-0 cursor-pointer items-center rounded-pill border p-[3px]'

/** Appended to the accessible name after a rejected save: the control says out
 *  loud that nothing was persisted, instead of silently looking unchanged. */
const FAILURE_SUFFIX = '，保存失败，设置未更改'
const PENDING_SUFFIX = '，正在保存'

/**
 * Immediate-setting toggle: a tonal track that keeps a `border-control` outline so
 * the OFF state is never read from a lightness difference alone (states.md:
 * 不靠浅色差辨认), and a solid ink track when ON. The thumb glides on
 * `--motion-fast` (120ms) inside the spec's 120–180ms window.
 *
 * Native button semantics give Enter/Space activation for free. While a save is
 * running the control keeps its width, its name and — deliberately — its focus:
 * it is not `disabled` during the round trip (that would drop the keyboard user's
 * place), it just ignores further activation and reports `aria-busy`. If
 * `onCheckedChange` throws or rejects, the thumb never moved (the `checked` prop is
 * the only source of truth) and the failure is stated in the name.
 */
export function Switch({ checked, onCheckedChange, disabled = false, ...aria }: SwitchProps) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  const handleToggle = async () => {
    // Guards, not just the `disabled` attribute: `pending` must block repeat
    // submissions without ever taking focus away from the control.
    if (disabled || pending) return
    const next = !checked
    setPending(true)
    setFailed(false)
    try {
      await onCheckedChange(next)
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  const label = aria['aria-label']
  const name = label ? `${label}，${checked ? '已开启' : '已关闭'}${pending ? PENDING_SUFFIX : ''}${failed ? FAILURE_SUFFIX : ''}` : undefined

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={pending || undefined}
      disabled={disabled}
      onClick={handleToggle}
      {...aria}
      aria-label={name}
      className={cn(
        TRACK_CLASS,
        'motion-press',
        // Same hover/press paint as Button (on: primary, off: tonal) and the outline
        // hover every bordered control uses.
        checked
          ? 'border-primary bg-primary not-disabled:hover:border-primary-hover not-disabled:hover:bg-primary-hover not-disabled:active:bg-primary-active'
          : cn('border-border-control bg-tonal not-disabled:hover:bg-tonal-hover not-disabled:active:bg-tonal-active', outlineHover),
        pending && 'cursor-wait',
        disabled && 'is-disabled',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex items-center justify-center rounded-pill border',
          controlSquare.xs,
          'motion-hover-fade',
          checked ? 'translate-x-6 border-transparent bg-on-primary' : 'border-border-control bg-surface',
        )}
      >
        {pending ? (
          <Loader2 weight="bold"
            className={cn('h-3 w-3 motion-spin', checked ? 'text-primary' : 'text-muted-foreground')}
          />
        ) : null}
      </span>
    </button>
  )
}
