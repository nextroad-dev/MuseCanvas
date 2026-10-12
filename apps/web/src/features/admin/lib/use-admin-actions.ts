'use client'

import { useRef, useState } from 'react'
import { useToast } from '@/shared/components/ui'
import { createAdminActionLock, isAdminToggleBlocked } from './admin-action-state'
import type { AdminActionKind } from './admin-action-state'

/** Failure stays with its named object until a successful retry; success is a toast. */
export function useAdminActions() {
  const lock = useRef(createAdminActionLock()).current
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const toast = useToast()

  async function run<T>(id: string, label: string, action: () => Promise<T>, success: string, kind: AdminActionKind = 'other') {
    if (!lock.claim(id, kind)) return undefined
    setPendingIds((previous) => new Set(previous).add(id))
    try {
      const result = await action()
      setErrors((previous) => {
        const next = { ...previous }
        delete next[id]
        return next
      })
      toast.push({ variant: 'success', title: success, description: label })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作失败，请重试'
      setErrors((previous) => ({ ...previous, [id]: `${label}：${message}` }))
      throw error
    } finally {
      lock.release(id)
      setPendingIds((previous) => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
    }
  }

  return {
    run,
    errors,
    isPending: (id: string) => pendingIds.has(id) || lock.has(id),
    isToggleBlocked: (id: string, serverTestPending = false) => isAdminToggleBlocked(lock.kind(id), serverTestPending),
  }
}
