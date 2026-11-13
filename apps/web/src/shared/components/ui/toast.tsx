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
import { exitDurationMs } from '@/shared/lib/motion'
import { ghostIconButtonVariants } from './button-variants'
import { iconSize } from './size'

export type ToastTone = 'success' | 'error' | 'info' | 'warning'

export interface ToastOptions {
  description?: string
  /**
   * 自动关闭延迟（ms）。默认按语气：success/info 5s，error/warning 8s。传 `null`
   * 则一直保留到手动关闭。
   */
  duration?: number | null
}

/** The imperative handle: `toast.success('已保存')`. */
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

/** Visible stack cap; older toasts stay in state but leave the viewport. */
const MAX_VISIBLE = 4

/**
 * Toast 区域 + 生产者。`<ToastProvider>` 挂在 root layout；视口是常驻的
 * `aria-live="polite"` 区域（每条 `role="status"`），播报不依赖与消息同时挂载的区域。
 *
 * 退场双保险：`animationend` 一到就移除节点，另有 `--motion-exit` 计时器兜底动画
 * 没运行的情况（reduced-motion、后台标签页）。刻意不迁移旧的 FLIP 卸载体系——
 * toast 只是一个小的有界列表。
 */
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

  const dismiss = useCallback(
    (id: number) => {
      setLeaving((prev) => {
        if (prev.has(id)) return prev
        const next = new Set(prev)
        next.add(id)
        return next
      })
    },
    [],
  )

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
    setLeaving((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  // 正常情况下由 animationend 先移除；这个计时器只清理退场动画无法触发的 toast。
  useEffect(() => {
    if (leaving.size === 0) return
    const ms = exitDurationMs() + 80
    const timersToClear = [...leaving].map((id) =>
      window.setTimeout(() => remove(id), ms),
    )
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
  // 直播区必须先于第一条消息存在；portal 需要 document，故在 effect 里挂载，
  // 保证服务端 HTML 与首次客户端渲染一致。
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null

  const visible = items.slice(-MAX_VISIBLE)

  return createPortal(
    <div
      aria-live="polite"
      // toast 浮在打开的对话框之上，useDialog 不能把它设为 inert。
      data-inert-exempt
      className="pointer-events-none fixed inset-x-4 top-4 z-toast flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:top-6"
    >
      {visible.map((item) => {
        const Icon = TONE_ICON[item.tone]
        const isLeaving = leaving.has(item.id)
        return (
          <div
            key={item.id}
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
            <Icon weight="fill" aria-hidden="true" className={cn('mt-0.5 shrink-0', iconSize.sm, TONE_ICON_CLASS[item.tone])} />
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
        )
      })}
    </div>,
    document.body,
  )
}

/**
 * 事件处理器里的命令式 toast 句柄：
 * `const { toast } = useToast(); toast.success('已保存')`。
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
