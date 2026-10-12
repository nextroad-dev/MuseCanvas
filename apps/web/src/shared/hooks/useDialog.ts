'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { AnimationEvent, RefObject } from 'react'
import { modalStack, type ModalDirection } from '@/shared/lib/modal-stack'
import { exitBackstopMs } from '@/shared/lib/motion'

/** What a Tab keypress can land on inside the panel, in DOM order. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/** Keyframes declared in `app/globals.css`. Matching on the animation name keeps
 *  one handler honest no matter how many animated children bubble events up. */
const ENTER_ANIMATIONS = new Set(['mc-fade-in', 'mc-reveal-up', 'mc-pop-in', 'mc-slide-in-right', 'mc-slide-in-left'])
const EXIT_ANIMATIONS = new Set(['mc-fade-out', 'mc-scale-out', 'mc-slide-out-right', 'mc-slide-out-left'])

export type DialogPhase = 'enter' | 'active' | 'close'

export type DialogDirection = ModalDirection

/**
 * Where the panel lands focus on open. `close` is the safe default (the X is
 * reachable, unambiguous and Escape-friendly); `first-input` is for a
 * content-first dialog whose real work starts in its first control, and `none`
 * is for a dialog that should not move focus at all (an image viewer the user
 * opened with a click on the media itself).
 */
export type DialogInitialFocus = 'close' | 'first-input' | 'none'

export interface UseDialogOptions {
  /** Desired visibility. Flipping it to `false` plays the exit animation and only
   *  then unmounts, so the caller never has to think about the gap. */
  open: boolean
  onClose: () => void
  /** ← / → handler. Omit it and the keys stay with the browser. */
  onNavigate?: (direction: DialogDirection) => void
  /** Backstop unmount delay in ms. Omit it to use the exit token (`--motion-exit`)
   *  plus slack, read from the document at runtime (see `shared/lib/motion`). */
  exitMs?: number
  /** Defaults to `close`. See `DialogInitialFocus`. */
  initialFocus?: DialogInitialFocus
}

export interface UseDialogResult {
  /** Gate the `createPortal` call on this; it also doubles as the SSR guard. */
  mounted: boolean
  phase: DialogPhase
  /** Stable id for the panel's `aria-labelledby`. */
  labelId: string
  dialogRef: RefObject<HTMLDivElement | null>
  /** Point this at the close button. It gets the initial focus under the default
   *  `initialFocus: 'close'`, and is the node skipped by `'first-input'`. */
  closeButtonRef: RefObject<HTMLButtonElement | null>
  portalTarget: HTMLElement | null
  /** Spread onto the outermost portal node (the scrim). It is both the focus
   *  scope and the element that sees every `animationend` bubble up. */
  rootProps: {
    ref: RefObject<HTMLDivElement | null>
    onAnimationEnd: (event: AnimationEvent<HTMLDivElement>) => void
  }
  /** Spread onto the panel element. */
  dialogProps: {
    ref: RefObject<HTMLDivElement | null>
    role: 'dialog'
    'aria-modal': true
    'aria-labelledby': string
    tabIndex: -1
  }
}

function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0
}

/**
 * The first control inside the panel a user could actually work with: visible,
 * reachable by Tab (`tabIndex >= 0` drops the sr-only file inputs), and not the
 * close button the caller asked to skip.
 */
function firstInteractable(scope: HTMLElement, skip: HTMLElement | null): HTMLElement | null {
  for (const node of Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))) {
    if (node === skip || node.tabIndex < 0 || !isVisible(node)) continue
    return node
  }
  return null
}

/**
 * Modal-dialog plumbing for anything that must animate in, hold focus and then
 * actually leave the DOM: lifecycle, portal, focus trap, scroll lock and the
 * window keydown handler (`useDialog` is the single Escape owner — a page with
 * this hook mounted must not register its own).
 *
 * The lifecycle is deliberately `enter -> active -> close -> unmounted`, and the
 * unmount is driven by BOTH `animationend` and a timer. The timer is not
 * decoration: `animationend` never fires when the animation is missing, when the
 * tab is backgrounded or when an ancestor is `display: none`, and an exit stuck
 * at `opacity: 0` is exactly the invisible-zombie failure mode the fail-visible
 * rule in `globals.css` exists to prevent.
 */
export function useDialog({
  open,
  onClose,
  onNavigate,
  exitMs,
  initialFocus = 'close',
}: UseDialogOptions): UseDialogResult {
  const labelId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [mounted, setMounted] = useState(false)
  const [phase, setPhase] = useState<DialogPhase>('enter')

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate

  // Mount from an effect, never from the initial state: `createPortal` has no
  // target during SSR, and starting closed keeps server and first client render
  // byte-identical.
  useEffect(() => {
    if (open) {
      if (!mounted) setMounted(true)
      // Re-opening mid-exit cancels the exit instead of stacking a stale close.
      if (phase === 'close') setPhase('enter')
      return
    }
    if (mounted && phase !== 'close') setPhase('close')
  }, [open, mounted, phase])

  // Guaranteed teardown of a closing dialog.
  useEffect(() => {
    if (!mounted || phase !== 'close') return
    const timer = window.setTimeout(() => setMounted(false), exitMs ?? exitBackstopMs())
    return () => window.clearTimeout(timer)
  }, [mounted, phase, exitMs])

  const onAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (ENTER_ANIMATIONS.has(event.animationName)) {
      if (phase === 'enter') setPhase('active')
      return
    }
    if (EXIT_ANIMATIONS.has(event.animationName) && phase === 'close') setMounted(false)
  }

  // Initial focus, once the panel exists. Where it lands is the caller's call
  // (`initialFocus`); the default is the close button, the safest landing spot.
  // `preventScroll` so a panel low in the portal never scrolls the page behind it.
  useEffect(() => {
    if (!mounted) return
    const frame = requestAnimationFrame(() => {
      if (initialFocus === 'none') return
      const panel = dialogRef.current
      const target =
        initialFocus === 'first-input' ? (panel ? firstInteractable(panel, closeButtonRef.current) : null) : null
      const landing = target ?? closeButtonRef.current ?? panel
      landing?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [mounted, initialFocus])

  // Stacked modal registration: reference-counted scroll locking, layered inert,
  // single top-level Escape / Tab trap, and precise focus restoration.
  // Using refs for callbacks prevents re-registration on parent re-renders.
  useEffect(() => {
    if (!mounted) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const unregister = modalStack.push({
      id: labelId,
      getRoot: () => rootRef.current,
      getDialog: () => dialogRef.current,
      onClose: () => onCloseRef.current(),
      onNavigate: onNavigate ? (dir) => onNavigateRef.current?.(dir) : undefined,
      restoreFocusElement: previousFocus,
    })
    return unregister
  }, [mounted, labelId])

  return {
    mounted,
    phase,
    labelId,
    dialogRef,
    closeButtonRef,
    portalTarget: mounted && typeof document !== 'undefined' ? document.body : null,
    rootProps: { ref: rootRef, onAnimationEnd },
    dialogProps: {
      ref: dialogRef,
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': labelId,
      tabIndex: -1,
    },
  }
}
