'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon as Check, WarningCircleIcon as CircleAlert, InfoIcon as Info, WarningIcon as TriangleAlert, XIcon as X } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { exitDurationMs } from '@/shared/lib/motion'
import { useFlipList } from '@/shared/hooks/useFlipList'
import type { ReactNode } from 'react'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import { ghostIconButtonVariants } from './button-variants'
import { controlMinHeight, iconSize } from './size'

export type ToastVariant = 'success' | 'warning' | 'error' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastInput {
  title: string
  description?: string
  variant?: ToastVariant
  /** Shown right-aligned. A toast with an action never auto-dismisses. */
  action?: ToastAction
  /** Auto-dismiss delay in ms. Defaults: success/info 5s, warning 8s, error and
   *  actionable toasts sticky. Pass `null` to keep any toast on screen. */
  duration?: number | null
}

interface ToastItem extends ToastInput {
  id: number
  variant: ToastVariant
}

interface ToastApi {
  push: (toast: ToastInput) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/** Visible stack cap (spec: 多条堆叠时最多显示 3 条，超出折叠为计数). Overflow is
 *  kept in state and folded into a counter, never dropped — a dismissed-by-overflow
 *  error would vanish unanswered. */
const MAX_VISIBLE = 3
/** Safety valve on the buffer itself, so a burst of sticky toasts cannot grow it. */
const MAX_KEPT = 20

/** Reading times, in ms. Success may close itself; a warning needs longer to
 *  read, and an error or an actionable toast stays until it is answered. */
const AUTO_DISMISS_MS: Record<ToastVariant, number | null> = {
  success: 5000,
  info: 5000,
  warning: 8000,
  error: null,
}

/** Text-tone icon: every semantic foreground clears 4.5:1 on `bg-surface`. */
const TONE_ICON: Record<ToastVariant, string> = {
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger',
  info: 'text-info',
}

const TONE_GLYPH: Record<ToastVariant, PhosphorIcon> = {
  success: Check,
  warning: TriangleAlert,
  error: CircleAlert,
  info: Info,
}

/** Urgency is announced as `alert`; everything else uses the polite region, and
 *  the shape of the glyph plus the wording carries the tone, never colour alone. */
const TONE_ROLE: Record<ToastVariant, 'status' | 'alert'> = {
  success: 'status',
  info: 'status',
  warning: 'alert',
  error: 'alert',
}

/**
 * Toast region + producer. The viewport is a permanent `aria-live="polite"`
 * landmark (individual errors and warnings upgrade to `role="alert"`), so
 * announcements never depend on visually scanning the corner — an urgent
 * message arriving in a region that mounts with it is not reliably read.
 *
 * New toasts push in below the stack, `z-toast` (50) keeps them above a modal,
 * and a toast with an action never auto-dismisses.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [leavingIds, setLeavingIds] = useState<Set<number>>(new Set())
  const nextId = useRef(0)
  const timers = useRef<Set<number>>(new Set())

  const schedule = useCallback((task: () => void, ms: number) => {
    const handle = window.setTimeout(() => {
      timers.current.delete(handle)
      task()
    }, ms)
    timers.current.add(handle)
    return handle
  }, [])

  // Nothing may fire into an unmounted provider.
  useEffect(
    () => () => {
      for (const handle of timers.current) window.clearTimeout(handle)
      timers.current.clear()
    },
    [],
  )

  const dismiss = useCallback(
    (id: number) => {
      setLeavingIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
      // The node leaves the DOM once the slide-out (`--motion-exit`) has run.
      schedule(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id))
        setLeavingIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, exitDurationMs())
    },
    [schedule],
  )

  const push = useCallback(
    (input: ToastInput) => {
      const id = ++nextId.current
      const variant = input.variant ?? 'info'
      // Actionable toasts and errors require user interaction and never auto-dismiss;
      // otherwise explicit duration wins, and default toasts self-dismiss on reading time.
      let autoClose: number | null
      if (input.action || input.duration === null) autoClose = null
      else if (typeof input.duration === 'number') autoClose = input.duration
      else if (variant === 'error') autoClose = null
      else autoClose = AUTO_DISMISS_MS[variant]
      setToasts((prev) => {
        const next = [...prev, { ...input, id, variant }]
        return next.length > MAX_KEPT ? next.slice(next.length - MAX_KEPT) : next
      })
      if (autoClose != null) schedule(() => dismiss(id), autoClose)
    },
    [dismiss, schedule],
  )

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} leavingIds={leavingIds} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

function ToastViewport({
  toasts,
  leavingIds,
  onDismiss,
}: {
  toasts: ToastItem[]
  leavingIds: Set<number>
  onDismiss: (id: number) => void
}) {
  // The live region must exist in the DOM before the first toast arrives, and it
  // can only be portalled once there is a document: mount on an effect so the
  // server HTML and the first client paint stay identical.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const viewportRef = useRef<HTMLDivElement>(null)
  const overflow = Math.max(0, toasts.length - MAX_VISIBLE)
  const visible = overflow > 0 ? toasts.slice(-MAX_VISIBLE) : toasts
  // Order-only trigger: auto-dismiss timers re-render, but the ids join only
  // changes on push / dismiss, so ticks never re-measure.
  useFlipList(viewportRef, visible.map((toast) => toast.id).join(','))
  if (!mounted) return null

  return createPortal(
    <div
      ref={viewportRef}
      aria-live="polite"
      // Toasts float above an open dialog, so `useDialog` must not make them inert.
      data-inert-exempt
      className="pointer-events-none fixed inset-x-4 top-4 z-toast flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:top-6"
    >
      {overflow > 0 ? (
        <p aria-hidden="true" className="rounded-pill bg-surface px-3 py-1 text-xs font-medium text-muted-foreground shadow-toast">
          已折叠 {overflow} 条通知
        </p>
      ) : null}
      {visible.map((toast) => {
        const leaving = leavingIds.has(toast.id)
        // `?? Info`: a caller that passes a tone from an older string set gets the
        // neutral glyph instead of a crash on an undefined component.
        const Glyph = TONE_GLYPH[toast.variant] ?? Info
        return (
          // FLIP owns the outer wrapper (`data-flip-key`); the slide keyframes
          // stay on the inner node so WAAPI transforms are never overridden.
          <div key={toast.id} data-flip-key={toast.id} className="w-full max-w-sm">
            <div
              role={TONE_ROLE[toast.variant]}
              className={cn(
                'pointer-events-auto relative w-full overflow-hidden rounded-card bg-surface border border-border p-4 shadow-toast motion-toast-in',
                leaving && 'motion-toast-out',
              )}
            >
            <div className="flex items-start gap-3">
              <Glyph weight="fill" className={cn(`mt-0.5 ${iconSize.sm} shrink-0`, TONE_ICON[toast.variant])} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{toast.title}</p>
                {toast.description ? (
                  <p className="mt-1 text-sm text-muted-foreground">{toast.description}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {toast.action ? (
                  <button
                    type="button"
                    onClick={() => {
                      toast.action?.onClick()
                      onDismiss(toast.id)
                    }}
                    className={cn(
                      'inline-flex items-center rounded-control px-2 text-sm font-medium text-primary',
                      controlMinHeight.sm,
                      'not-disabled:hover:bg-tonal-hover not-disabled:active:bg-tonal-active motion-press',
                    )}
                  >
                    {toast.action.label}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onDismiss(toast.id)}
                  aria-label="关闭通知"
                  className={ghostIconButtonVariants({ size: 'sm' })}
                >
                  <X weight="bold" className={iconSize.sm} aria-hidden="true" />
                </button>
              </div>
            </div>
            </div>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}

/** Imperative toast handle for event handlers (copy, save, async completion). */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
