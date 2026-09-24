'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { AnimationEvent, RefObject } from 'react'

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
const ENTER_ANIMATIONS = new Set(['mc-fade-in', 'mc-reveal-up', 'mc-pop-in'])
const EXIT_ANIMATIONS = new Set(['mc-fade-out', 'mc-scale-out'])

/** `--motion-overlay` (scrim) and `--motion-fast` (panel) plus two frames of
 *  slack. CSS durations cannot be awaited from JS, so the pair has to be kept in
 *  sync by hand; the value is a backstop only, never the primary unmount signal. */
const DEFAULT_EXIT_MS = 320

/** Arrow keys belong to the media when it has focus — a focused `<video controls>`
 *  seeks on ←/→, and an editable field moves the caret. Never steal those. */
const MEDIA_OR_EDITABLE = 'input, textarea, select, [contenteditable], video, audio'

export type DialogPhase = 'enter' | 'active' | 'close'

export type DialogDirection = 'previous' | 'next'

export interface UseDialogOptions {
  /** Desired visibility. Flipping it to `false` plays the exit animation and only
   *  then unmounts, so the caller never has to think about the gap. */
  open: boolean
  onClose: () => void
  /** ← / → handler. Omit it and the keys stay with the browser. */
  onNavigate?: (direction: DialogDirection) => void
  /** Backstop unmount delay; keep it above the longest exit animation. */
  exitMs?: number
}

export interface UseDialogResult {
  /** Gate the `createPortal` call on this; it also doubles as the SSR guard. */
  mounted: boolean
  phase: DialogPhase
  /** Stable id for the panel's `aria-labelledby`. */
  labelId: string
  dialogRef: RefObject<HTMLDivElement | null>
  /** Point this at the close button; it receives the initial focus. */
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

function keepsItsOwnArrowKeys(target: EventTarget | null): boolean {
  return target instanceof Element && target.matches(MEDIA_OR_EDITABLE)
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
export function useDialog({ open, onClose, onNavigate, exitMs = DEFAULT_EXIT_MS }: UseDialogOptions): UseDialogResult {
  const labelId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [mounted, setMounted] = useState(false)
  const [phase, setPhase] = useState<DialogPhase>('enter')

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
    const timer = window.setTimeout(() => setMounted(false), exitMs)
    return () => window.clearTimeout(timer)
  }, [mounted, phase, exitMs])

  const onAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (ENTER_ANIMATIONS.has(event.animationName)) {
      if (phase === 'enter') setPhase('active')
      return
    }
    if (EXIT_ANIMATIONS.has(event.animationName) && phase === 'close') setMounted(false)
  }

  // Initial focus, once the panel exists. The close button is the safest landing
  // spot: it is reachable, unambiguous and Escape-friendly.
  useEffect(() => {
    if (!mounted) return
    const frame = requestAnimationFrame(() => {
      const target = closeButtonRef.current ?? dialogRef.current
      target?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [mounted])

  // Scroll lock plus focus restore, tied to the same mount as the portal.
  useEffect(() => {
    if (!mounted) return
    const { body } = document
    const previousOverflow = body.style.overflow
    const previousPaddingRight = body.style.paddingRight
    // Compensate the disappearing scrollbar so the page behind does not jump.
    const gutter = window.innerWidth - document.documentElement.clientWidth
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    body.style.overflow = 'hidden'
    if (gutter > 0) body.style.paddingRight = `${gutter}px`
    return () => {
      body.style.overflow = previousOverflow
      body.style.paddingRight = previousPaddingRight
      // The panel is already out of the DOM here, so the restore sticks.
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus()
    }
  }, [mounted])

  // One keydown listener for the whole dialog: Escape, ← / →, and the Tab ring.
  useEffect(() => {
    if (!mounted) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (!onNavigate || keepsItsOwnArrowKeys(event.target)) return
        event.preventDefault()
        onNavigate(event.key === 'ArrowLeft' ? 'previous' : 'next')
        return
      }
      if (event.key !== 'Tab') return
      // The trap covers the whole portal subtree: a scrim's close / step buttons
      // sit outside the panel but must still be inside the ring.
      const scope = rootRef.current ?? dialogRef.current
      if (!scope) return
      const focusables = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible)
      if (focusables.length === 0) {
        event.preventDefault()
        dialogRef.current?.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (!scope.contains(active)) {
        // Focus escaped (a re-render, or the panel was never focused): pull it back
        // in the direction the user was travelling.
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mounted, onClose, onNavigate])

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
