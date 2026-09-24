'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

export type ToastVariant = 'success' | 'error' | 'info'

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
  /** Auto-dismiss delay in ms. Defaults: success/info 5s, error sticky. */
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

/** Max simultaneously visible toasts; the rest queue in and take a free slot. */
const MAX_VISIBLE = 3

const VARIANT_STYLES: Record<ToastVariant, string> = {
  success: 'border-l-success',
  error: 'border-l-danger',
  info: 'border-l-info',
}

/**
 * Toast region + producer. Success and info toasts auto-dismiss, errors and
 * actionable toasts stay until dismissed manually. The viewport is a single
 * `aria-live="polite"` landmark (individual errors upgrade to `role="alert"`),
 * so announcements never depend on visually scanning the corner.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [leavingIds, setLeavingIds] = useState<Set<number>>(new Set())
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => {
    setLeavingIds((prev) => new Set(prev).add(id))
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
      setLeavingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, 120)
  }, [])

  const push = useCallback(
    (input: ToastInput) => {
      const id = ++nextId.current
      const variant = input.variant ?? 'info'
      // Explicit duration wins; otherwise errors and actionable toasts stay
      // until dismissed, success/info self-dismiss after 5s.
      let autoClose: number | null
      if (typeof input.duration === 'number') autoClose = input.duration
      else if (input.duration === null || variant === 'error' || input.action) autoClose = null
      else autoClose = 5000
      setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { ...input, id, variant }])
      if (autoClose != null) window.setTimeout(() => dismiss(id), autoClose)
    },
    [dismiss],
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
  if (toasts.length === 0) return null
  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 top-4 z-toast flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:top-6"
    >
      {toasts.map((toast) => {
        const leaving = leavingIds.has(toast.id)
        return (
          <div
            key={toast.id}
            role={toast.variant === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto w-full max-w-sm rounded-card border border-border border-l-4 bg-surface p-4 shadow-lg motion-toast-in motion-hover-fade ${
              VARIANT_STYLES[toast.variant]
            } ${leaving ? 'motion-fade-out' : ''}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium leading-[1.5] text-foreground">{toast.title}</p>
                {toast.description ? (
                  <p className="mt-1 text-sm leading-[1.5] text-muted-foreground">{toast.description}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {toast.action ? (
                  <button
                    type="button"
                    onClick={toast.action.onClick}
                    className="min-h-8 rounded-control px-2 text-sm font-medium text-accent hover:bg-accent-soft motion-press"
                  >
                    {toast.action.label}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onDismiss(toast.id)}
                  aria-label="关闭通知"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted-foreground hover:bg-surface-subtle hover:text-foreground motion-press"
                >
                  <svg width="14" height="14" viewBox="0 0 256 256" fill="none" aria-hidden="true">
                    <path d="M64 64l128 128M192 64L64 192" stroke="currentColor" strokeWidth="20" strokeLinecap="round" />
                  </svg>
                </button>
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
