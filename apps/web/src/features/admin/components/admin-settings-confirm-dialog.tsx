'use client'

import type { ReactNode } from 'react'
import { Dialog } from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'

export interface AdminSettingsConfirmDialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  confirmLabel: ReactNode
  onConfirm: () => void
  busy?: boolean
  children: ReactNode
}

/** 危险操作二次确认：统一走标准 Dialog，确认按钮用 danger 语气。 */
export function AdminSettingsConfirmDialog({
  open,
  onClose,
  title,
  confirmLabel,
  onConfirm,
  busy = false,
  children,
}: AdminSettingsConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description="请确认这是你要执行的操作。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-foreground">{children}</div>
    </Dialog>
  )
}
