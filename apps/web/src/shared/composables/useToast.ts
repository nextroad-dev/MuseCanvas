import { ref } from 'vue'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  id: string
  type: ToastType
  message: string
}

export const toasts = ref<Toast[]>([])

let idCounter = 0

/**
 * Auto-dismiss windows. Blocking problems stay until they are dismissed by the
 * user; successes and neutral confirmations fade on their own.
 */
const AUTO_DISMISS: Record<ToastType, number> = {
  success: 4000,
  info: 5000,
  warning: 8000,
  error: 0,
}

export function toast(message: string, type: ToastType = 'info', duration?: number) {
  const id = `${Date.now()}-${++idCounter}`
  const t: Toast = { id, type, message }
  toasts.value.push(t)

  const timeout = duration ?? AUTO_DISMISS[type]
  if (timeout > 0) {
    setTimeout(() => removeToast(id), timeout)
  }
}

export function removeToast(id: string) {
  const idx = toasts.value.findIndex((t) => t.id === id)
  if (idx > -1) {
    toasts.value.splice(idx, 1)
  }
}

/** Errors and warnings need reading (or an action), so they are dismissible. */
export function isPersistentToast(type: ToastType): boolean {
  return AUTO_DISMISS[type] === 0
}

export function useToast() {
  return { toasts, toast, removeToast }
}