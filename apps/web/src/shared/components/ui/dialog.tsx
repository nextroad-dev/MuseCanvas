'use client'

import { useId } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { XIcon as X } from '@phosphor-icons/react'
import { useDialog } from '@/shared/hooks/useDialog'
import { cn } from '@/shared/lib/cn'
import { ghostIconButtonVariants } from './button-variants'
import { iconSize } from './size'

/** `--container-dialog-*` (420 / 720px). */
const SIZE_CLASS = {
  narrow: 'max-w-dialog-narrow',
  wide: 'max-w-dialog-wide',
} as const

export type DialogSize = keyof typeof SIZE_CLASS

export interface DialogProps {
  /** Desired visibility; the exit animation plays before unmount. */
  open: boolean
  onClose: () => void
  /** Visible heading — also the accessible name via `aria-labelledby`. */
  title: ReactNode
  /** One-line purpose wired through `aria-describedby`. */
  description?: ReactNode
  /** Action row (取消 / 删除…), below the body. */
  footer?: ReactNode
  size?: DialogSize
  /** Extra classes on the panel (padding overrides, scroll behaviour…). */
  panelClassName?: string
  /** Accessible name of the icon-only close control. */
  closeLabel?: string
  /**
   * 打开时焦点落点：`close`（默认）最稳；`first-input` 送到第一个可用控件；
   * `none` 不移动焦点。
   */
  initialFocus?: 'close' | 'first-input' | 'none'
  children: ReactNode
}

/**
 * 标准模态壳，跑在 `useDialog` 之上：portal、遮罩点击、焦点陷阱、初始焦点、Esc、
 * 焦点归还与进出场动效都在 hook 里，背景 inert 也一样。调用方只负责内容。
 *
 * 表面：`z-modal` + `shadow-modal` + `rounded-panel`，`bg-surface` 不带描边——
 * 对话框不允许边框，分区只用留白。主体是滚动区，长表单不会把标题/操作顶出视口。
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  size = 'narrow',
  panelClassName,
  closeLabel = '关闭对话框',
  initialFocus = 'close',
  children,
}: DialogProps) {
  const descriptionId = useId()
  const { mounted, phase, labelId, closeButtonRef, portalTarget, rootProps, dialogProps } = useDialog({
    open,
    onClose,
    initialFocus,
  })

  if (!mounted || !portalTarget) return null

  const closing = phase === 'exit'

  return createPortal(
    <div {...rootProps} className="fixed inset-0 z-modal flex items-end justify-center p-4 sm:items-center">
      {/* 遮罩 = `--color-overlay` × `--opacity-overlay`；用 color-mix 写是因为淡出
          动画操作的是 opacity，直接写 token 透明度会打架。 */}
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{ backgroundColor: 'color-mix(in srgb, var(--color-overlay) calc(var(--opacity-overlay) * 100%), transparent)' }}
        className={cn('absolute inset-0', closing ? 'motion-fade-out' : 'motion-fade-in')}
      />
      <div
        {...dialogProps}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          'relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-panel bg-surface shadow-modal',
          closing ? 'pointer-events-none motion-dialog-out' : 'motion-dialog-in',
          SIZE_CLASS[size],
          panelClassName,
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={labelId} className="text-module text-foreground">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-sm text-muted-foreground [text-wrap:pretty]">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            ref={closeButtonRef}
            onClick={onClose}
            aria-label={closeLabel}
            className={cn(ghostIconButtonVariants({ size: 'sm' }), '-mr-2')}
          >
            <X weight="bold" aria-hidden="true" className={iconSize.sm} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>

        {footer ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-6 pb-6">{footer}</div> : null}
      </div>
    </div>,
    portalTarget,
  )
}
