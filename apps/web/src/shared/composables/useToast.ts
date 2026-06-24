import { ref } from 'vue'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  id: string
  type: ToastType
  message: string
}

export const toasts = ref<Toast[]>([])

let idCounter = 0

export function toast(message: string, type: ToastType = 'info', duration = 5000) {
  const id = `${Date.now()}-${++idCounter}`
  const t: Toast = { id, type, message }
  toasts.value.push(t)

  if (duration > 0) {
    setTimeout(() => removeToast(id), duration)
  }
}

export function removeToast(id: string) {
  const idx = toasts.value.findIndex((t) => t.id === id)
  if (idx > -1) {
    toasts.value.splice(idx, 1)
  }
}

export function useToast() {
  return { toasts, toast, removeToast }
}
