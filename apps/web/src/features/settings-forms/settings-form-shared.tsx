'use client'

import { Badge } from '@/shared/components/ui'
import type { BadgeTone } from '@/shared/components/ui'
import type { SmtpConnectionStatus, StorageConnectionStatus } from '@musecanvas/contracts'

const connectionStatusTone: Record<SmtpConnectionStatus | StorageConnectionStatus, BadgeTone> = {
  not_configured: 'neutral',
  configured: 'warning',
  verified: 'success',
  error: 'danger',
}

const connectionStatusLabel: Record<SmtpConnectionStatus | StorageConnectionStatus, string> = {
  not_configured: '未配置',
  configured: '已保存待验证',
  verified: '已验证',
  error: '连接异常',
}

export function ConnectionBadge({ status }: { status: SmtpConnectionStatus | StorageConnectionStatus }) {
  return <Badge tone={connectionStatusTone[status]}>{connectionStatusLabel[status]}</Badge>
}

/**
 * Moves focus to the first field the caller has marked invalid. Call it after the
 * error state has been committed (the caller defers it to the next frame).
 */
export function focusFirstInvalidField(formId: string): void {
  if (typeof document === 'undefined') return
  document.getElementById(formId)?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
}
