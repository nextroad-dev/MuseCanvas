'use client'

import { createPortal } from 'react-dom'
import { useId } from 'react'
import { XIcon as X } from '@phosphor-icons/react'
import { useDialog } from '@/shared/hooks/useDialog'
import type { DialogInitialFocus } from '@/shared/hooks/useDialog'
import { cn } from '@/shared/lib/cn'
import type { ReactNode } from 'react'
import { ghostIconButtonVariants } from './button-variants'
import { iconSize } from './size'

/** `--container-dialog-*` (420 / 720px). `default` keeps the historic `max-w-sm`
 *  so every panel already in the app renders at the width it did before. */
const SIZE_CLASS = {
  default: 'max-w-sm',
  narrow: 'max-w-dialog-narrow',
  wide: 'max-w-dialog-wide',
} as const

export type DialogSize = keyof typeof SIZE_CLASS

interface DialogProps {
  /** Desired visibility; the exit animation plays before unmount. */
  open: boolean
  onClose: () => void
  /** Visible heading — also the accessible name via aria-labelledby. */
  title: ReactNode
  children: ReactNode
  /**
   * One-line purpose shown under the title and wired to the panel through
   * `aria-describedby`, so screen readers announce it on open. Pass it instead of
   * writing the first `<p>` of the body: that paragraph is a description, not
   * content.
   */
  description?: ReactNode
  /** Optional action row (取消 / 删除…). Sits below the body with whitespace only —
   *  a dialog is a card-class surface, so no divider line. */
  footer?: ReactNode
  /** Panel width preset. `panelClassName` still wins, so existing call sites keep
   *  their exact width. */
  size?: DialogSize
  /** Extra classes on the panel (padding overrides, scroll behaviour…). */
  panelClassName?: string
  /** Accessible name of the close control. It is icon-only, so it is never empty. */
  closeLabel?: string
  /**
   * Where focus lands. `'close'` (default) is the safe spot; `'first-input'`
   * sends it to the panel's first usable control for a content-first dialog (a
   * picker whose work starts in its search field), falling back to close when the
   * body has nothing focusable yet.
   */
  initialFocus?: DialogInitialFocus
}

/** The scrim: `--color-overlay` at `--opacity-overlay` (40% light, 55% dark), so
 *  dark mode is not stuck at the light value. Written as a color-mix instead of
 *  `opacity` because the fade animation animates `opacity` and would otherwise
 *  fight the token. */
const SCRIM_BACKGROUND = 'color-mix(in srgb, var(--color-overlay) calc(var(--opacity-overlay) * 100%), transparent)'

/**
 * Standard modal shell on top of `useDialog`: portal, scrim click, focus trap,
 * initial focus where the caller asked for it (`initialFocus`, defaulting to the
 * safe close control), Escape, focus restore to the trigger and the enter/exit
 * motion pair. The background goes inert while open. Callers own only the content.
 * Every modal in the app should route through here so the accessibility behaviour
 * stays single-sourced.
 *
 * Surface: `z-modal` (40) + `shadow-modal` + `rounded-panel`, on `bg-surface` with
 * **no rule** — a dialog is not allowed a border, and its sections are separated
 * by whitespace only. The body is the scrolling region, so a long form cannot
 * push the heading or the actions out of the viewport.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'default',
  panelClassName,
  closeLabel = '关闭对话框',
  initialFocus = 'close',
}: DialogProps) {
  const descriptionId = useId()
  const { mounted, phase, labelId, closeButtonRef, portalTarget, rootProps, dialogProps } = useDialog({
    open,
    onClose,
    initialFocus,
  })

  if (!mounted || !portalTarget) return null

  const closing = phase === 'close'

  return createPortal(
    <div {...rootProps} className="fixed inset-0 z-modal flex items-center justify-center p-4">
      {/* Its own layer: the scrim fades while the panel scales, and it is the only
          surface a click outside the panel can land on. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{ backgroundColor: SCRIM_BACKGROUND }}
        className={cn('absolute inset-0', closing ? 'motion-fade-out' : 'motion-fade-in')}
      />
      <div
        {...dialogProps}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          'relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-panel bg-surface shadow-modal',
          closing ? 'motion-dialog-out pointer-events-none' : 'motion-dialog-in',
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
            className={ghostIconButtonVariants({ size: 'sm', className: '-mr-2' })}
          >
            <X weight="bold" className={iconSize.sm} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-6 pb-6">{footer}</div>
        ) : null}
      </div>
    </div>,
    portalTarget,
  )
}
