'use client'

import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useDialog } from '@/shared/hooks/useDialog'
import type { ReactNode } from 'react'

interface DialogProps {
  /** Desired visibility; the exit animation plays before unmount. */
  open: boolean
  onClose: () => void
  /** Visible heading — also the accessible name via aria-labelledby. */
  title: ReactNode
  children: ReactNode
  /** Panel width utility, e.g. `max-w-lg`. Defaults to the narrow form size. */
  panelClassName?: string
  /** Extra classes on the panel (padding overrides, scroll behaviour…). */
}

/**
 * Standard modal shell on top of `useDialog`: portal, scrim click, focus trap,
 * initial focus on the close button, Escape, focus restore and the
 * enter/exit motion pair. Callers own only the content. Every modal in the
 * app should route through here so the accessibility behaviour stays
 * single-sourced.
 */
export function Dialog({ open, onClose, title, children, panelClassName = 'max-w-sm' }: DialogProps) {
  const { mounted, phase, labelId, closeButtonRef, portalTarget, rootProps, dialogProps } = useDialog({ open, onClose })

  if (!mounted || !portalTarget) return null

  const closing = phase === 'close'

  return createPortal(
    <div
      {...rootProps}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className={`fixed inset-0 z-[var(--z-index-overlay)] flex items-center justify-center bg-overlay/40 p-4 ${
        closing ? 'motion-fade-out pointer-events-none' : 'motion-fade-in'
      }`}
    >
      <div
        {...dialogProps}
        className={`relative max-h-[90vh] w-full overflow-y-auto rounded-panel border border-border bg-surface p-6 shadow-lg ${
          closing ? 'motion-dialog-out' : 'motion-dialog-in'
        } ${panelClassName}`}
      >
        <div className="flex items-center justify-between">
          <h2 id={labelId} className="text-base font-medium leading-[1.5] text-foreground">
            {title}
          </h2>
          <button
            type="button"
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="关闭对话框"
            className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground motion-press"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    portalTarget,
  )
}
