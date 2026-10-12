'use client'

import { useEffect, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Alert, Button, Card, Dialog, EmptyState, SkeletonText } from '@/shared/components/ui'
import { AdminDeleteConfirmation } from './admin-confirm-dialog'
import type { AdminDeleteConfirmationProps } from './admin-confirm-dialog'
import { cn } from '@/shared/lib/cn'
import { focusAdminRecordDialogMode, restoreAdminRecordListFocus } from '../lib/admin-record-dialog-focus'
import { adminTouchTargetsSquare } from '../lib/admin-layout'

export function AdminRecordFields({ fields }: { fields: Array<{ label: string; value: ReactNode }> }) {
  return (
    <div className="@container/details min-w-0">
    <dl className="grid min-w-0 grid-cols-1 gap-4 text-sm @min-[520px]/details:grid-cols-2">
      {fields.map(({ label, value }) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
    </div>
  )
}

interface AdminRecordDetailDialogProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  actions?: ReactNode
  danger?: ReactNode
  confirmation?: AdminDeleteConfirmationProps
  listFocusRef?: RefObject<HTMLElement | null>
}

/** Runs inside the mounted portal, so cleanup follows the real Dialog exit, not a guessed delay. */
function AdminRecordDialogContent({ open, title, children, actions, danger, confirmation, listFocusRef, cancelRef }: AdminRecordDetailDialogProps & {
  cancelRef: RefObject<HTMLButtonElement | null>
}) {
  const detailPanelRef = useRef<HTMLDivElement | null>(null)
  const detailFocusRef = useRef<HTMLElement | null>(null)
  const previousConfirming = useRef(!!confirmation)
  const latestListRef = useRef(listFocusRef)
  latestListRef.current = listFocusRef

  useEffect(() => {
    const active = document.activeElement
    const trigger = active instanceof HTMLElement && active !== document.body ? active : null
    return () => {
      // Wait only for the shared Dialog's synchronous effect cleanup (inert/overflow restore).
      queueMicrotask(() => restoreAdminRecordListFocus(trigger, latestListRef.current?.current ?? null, document.activeElement === trigger))
    }
  }, [])

  const confirming = !!confirmation
  useEffect(() => {
    if (open && confirming !== previousConfirming.current) {
      focusAdminRecordDialogMode(confirming, cancelRef.current, detailFocusRef.current, detailPanelRef.current)
    }
    previousConfirming.current = confirming
  }, [open, confirming, cancelRef])

  return <>
    <div ref={detailPanelRef} role="group" aria-label={title} tabIndex={-1} hidden={confirming}
      className={confirming ? 'hidden' : 'flex min-w-0 flex-col gap-6'}
      onFocusCapture={(event) => { detailFocusRef.current = event.target }}>
      {children}
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
      {danger && <div className="flex flex-wrap items-center gap-3 rounded-control bg-danger-soft p-3">{danger}</div>}
    </div>
    {confirmation && <AdminDeleteConfirmation {...confirmation} />}
  </>
}

/** One persistent Dialog owns both modes, including standalone desktop confirmation. */
export function AdminRecordDetailDialog(props: AdminRecordDetailDialogProps) {
  const { open, title, onClose, confirmation } = props
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  function close() {
    if (confirmation) {
      if (!confirmation.pending) confirmation.onCancel()
    } else onClose()
  }
  return (
    <Dialog open={open} onClose={close} title={confirmation ? '确认删除' : title}
      size={confirmation?.cancelLabel === '取消' ? 'narrow' : 'wide'}
      panelClassName={cn('max-h-[90dvh]', adminTouchTargetsSquare)}
      footer={confirmation ? <>
        <Button ref={cancelRef} variant="ghost" disabled={confirmation.pending} onClick={confirmation.onCancel}>{confirmation.cancelLabel}</Button>
        <Button variant="danger" loading={confirmation.pending} disabled={confirmation.pending} onClick={confirmation.onConfirm}>确认删除</Button>
      </> : <Button variant="ghost" onClick={onClose}>关闭详情</Button>}>
      <AdminRecordDialogContent {...props} cancelRef={cancelRef} />
    </Dialog>
  )
}

/** Card/table presentation follows the admin content track, including its sidebar budget. */
export function AdminMobileRecords<T extends { id: string }>({
  records, title, status, summary, onDetails, loading, error, onRetry, empty,
  emptyVariant = 'first-use', emptyTitle = '暂无记录', emptyAction,
}: {
  records: T[]; title: (record: T) => ReactNode; status: (record: T) => ReactNode
  summary: (record: T) => ReactNode; onDetails: (record: T) => void
  loading: boolean; error?: string | null; onRetry?: () => void; empty: ReactNode
  emptyVariant?: 'first-use' | 'no-results'; emptyTitle?: string; emptyAction?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 @min-[800px]/admin:hidden">
      {loading ? <div className="flex flex-col gap-3" role="status" aria-busy="true"><span className="sr-only">正在加载列表</span>{[0, 1, 2].map((index) => <Card key={index} density="compact" aria-hidden="true"><SkeletonText width="12rem" className="text-module" /><SkeletonText width="16rem" /><div className="h-12 rounded-control bg-tonal motion-shimmer" /></Card>)}</div>
        : error ? <Alert tone="danger" role="alert" action={onRetry && <Button variant="secondary" onClick={onRetry}>刷新重试</Button>}>{error}</Alert>
        : records.length === 0 ? <Card><EmptyState density="compact" variant={emptyVariant} title={emptyTitle} description={empty} action={emptyAction} /></Card>
        : records.map((record) => (
          <Card key={record.id} density="compact" className="min-w-0 gap-3">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <h3 id={`admin-record-${record.id}`} className="min-w-0 break-words text-module [overflow-wrap:anywhere]">{title(record)}</h3>
              {status(record)}
            </div>
            <div className="min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{summary(record)}</div>
            <Button variant="secondary" size="lg" onClick={() => onDetails(record)} aria-describedby={`admin-record-${record.id}`}>查看详情</Button>
          </Card>
        ))}
    </div>
  )
}
