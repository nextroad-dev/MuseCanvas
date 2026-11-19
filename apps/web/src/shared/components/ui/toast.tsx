'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  CheckCircleIcon as CircleCheck,
  InfoIcon as Info,
  WarningCircleIcon as CircleAlert,
  WarningIcon as TriangleAlert,
  XIcon as X,
} from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { useFlipList } from '@/shared/hooks/useFlipList'
import { exitDurationMs } from '@/shared/lib/motion'
import { ghostIconButtonVariants } from './button-variants'
import { iconSize } from './size'

export type ToastTone = 'success' | 'error' | 'info' | 'warning'

export interface ToastOptions {
  description?: string
  duration?: number | null
}

export interface ToastApi {
  success: (title: string, description?: string) => void
  error: (title: string, description?: string) => void
  info: (title: string, description?: string) => void
  warning: (title: string, description?: string) => void
  dismiss: (id: number) => void
}

interface ToastItem {
  id: number
  tone: ToastTone
  title: string
  description?: string
}

interface ToastContextValue {
  toast: ToastApi
}

const ToastContext = createContext<ToastContextValue | null>(null)

const DEFAULT_DURATION: Record<ToastTone, number | null> = {
  success: 5000,
  info: 5000,
  warning: 8000,
  error: 8000,
}

const TONE_ICON = {
  success: CircleCheck,
  error: CircleAlert,
  info: Info,
  warning: TriangleAlert,
} as const

const TONE_ICON_CLASS: Record<ToastTone, string> = {
  success: 'text-success',
  error: 'text-danger',
  info: 'text-info',
  warning: 'text-warning',
}

const MAX_VISIBLE = 4

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const [leaving, setLeaving] = useState<Set<number>>(new Set())
  const nextId = useRef(0)
  const timers = useRef<Set<number>>(new Set())

  const schedule = useCallback((task: () => void, ms: number) => {
    const handle = window.setTimeout(() => {
      timers.current.delete(handle)
      task()
    }, ms)
    timers.current.add(handle)
  }, [])

  useEffect(
    () => () => {
      for (const handle of timers.current) window.clearTimeout(handle)
      timers.current.clear()
    },
    [],
  )

  const dismiss = useCallback((id: number) => {
    setLeaving((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
    setLeaving((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  useEffect(() => {
    if (leaving.size === 0) return
    const ms = exitDurationMs() + 80
    const timersToClear = [...leaving].map((id) => window.setTimeout(() => remove(id), ms))
    return () => {
      for (const handle of timersToClear) window.clearTimeout(handle)
    }
  }, [leaving, remove])

  const push = useCallback(
    (tone: ToastTone, title: string, description?: string, duration?: number | null) => {
      const id = (nextId.current += 1)
      setItems((prev) => [...prev, { id, tone, title, description }])
      const autoClose = duration === null ? null : (duration ?? DEFAULT_DURATION[tone])
      if (autoClose !== null) schedule(() => dismiss(id), autoClose)
    },
    [dismiss, schedule],
  )

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, description) => push('success', title, description),
      error: (title, description) => push('error', title, description),
      info: (title, description) => push('info', title, description),
      warning: (title, description) => push('warning', title, description),
      dismiss,
    }),
    [push, dismiss],
  )

  return (
    <ToastContext.Provider value={{ toast: api }}>
      {children}
      <ToastViewport items={items} leaving={leaving} onDismiss={dismiss} onRemoved={remove} />
    </ToastContext.Provider>
  )
}

function ToastViewport({
  items,
  leaving,
  onDismiss,
  onRemoved,
}: {
  items: ToastItem[]
  leaving: Set<number>
  onDismiss: (id: number) => void
  onRemoved: (id: number) => void
}) {
  const [mounted, setMounted] = useState(false)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => setMounted(true), [])

  const visible = items.slice(-MAX_VISIBLE)
  const orderKey = mounted ? visible.map((t) => t.id).join(',') : ''
  useFlipList(viewportRef, orderKey)

  if (!mounted) return null

  return createPortal(
    <div
      ref={viewportRef}
      aria-live="polite"
      data-inert-exempt
      className="pointer-events-none fixed inset-x-4 top-4 z-toast flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:top-6"
    >
      {visible.map((item) => {
        const Icon = TONE_ICON[item.tone]
        const isLeaving = leaving.has(item.id)
        return (
          <div key={item.id} data-flip-key={String(item.id)} className="pointer-events-none flex w-full justify-end">
            <div
              role="status"
              className={cn(
                'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-card border border-border bg-surface p-4 shadow-toast',
                isLeaving ? 'motion-toast-out' : 'motion-toast-in',
              )}
              onAnimationEnd={(event) => {
                if (event.target !== event.currentTarget) return
                if (isLeaving) onRemoved(item.id)
              }}
            >
              <Icon
                weight="fill"
                aria-hidden="true"
                className={cn('mt-0.5 shrink-0', iconSize.sm, TONE_ICON_CLASS[item.tone])}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{item.title}</p>
                {item.description ? <p className="mt-1 text-sm text-muted-foreground">{item.description}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => onDismiss(item.id)}
                aria-label="关闭通知"
                className={ghostIconButtonVariants({ size: 'sm' })}
              >
                <X weight="bold" aria-hidden="true" className={iconSize.sm} />
              </button>
            </div>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
