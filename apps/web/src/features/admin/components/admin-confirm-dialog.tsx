'use client'

import { Alert } from '@/shared/components/ui'

export interface AdminDeleteConfirmationProps {
  objectName: string
  impact: string
  pending: boolean
  error?: string
  cancelLabel: '取消' | '返回详情'
  onCancel: () => void
  onConfirm: () => void
}

/** Content only: detail and confirmation must share their owning Dialog's lifecycle. */
export function AdminDeleteConfirmation({ objectName, impact, error }: AdminDeleteConfirmationProps) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="break-words text-sm">删除对象：<strong>{objectName}</strong></p>
      <p className="text-sm text-muted-foreground">{impact}</p>
      {error && <Alert tone="danger" role="alert" title="删除未完成">{error}。可重试或取消。</Alert>}
    </div>
  )
}

export function AdminActionErrors({ errors }: { errors: Record<string, string> }) {
  return Object.entries(errors).map(([id, message]) => (
    <Alert key={id} tone="danger" role="alert" title="操作未完成">{message}。请修正后重试。</Alert>
  ))
}
