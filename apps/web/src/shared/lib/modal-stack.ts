/**
 * Global modal stack manager for apps/web.
 *
 * Guarantees:
 * 1. Single active Escape / focus trap owner: only the topmost open modal handles Escape and Tab keys.
 * 2. Nested dialog safety: opening dialog B over dialog A does not close both on Escape or trap focus in A.
 * 3. Reference-counted scroll locking: body overflow and scrollbar compensation are locked on the first modal
 *    and only unlocked when the last modal unmounts.
 * 4. Layered inert management: elements behind the topmost modal are marked inert, and previous inert states
 *    are accurately restored when modals pop.
 * 5. Focus restoration: focus restores to the trigger that opened each specific modal.
 */

export type ModalDirection = 'previous' | 'next'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

const MEDIA_OR_EDITABLE = 'input, textarea, select, [contenteditable], video, audio'
const INERT_EXEMPT_ATTRIBUTE = 'data-inert-exempt'

export interface ModalRegistration {
  id: string
  getRoot: () => HTMLElement | null
  getDialog: () => HTMLElement | null
  onClose: () => void
  onNavigate?: ((direction: ModalDirection) => void) | undefined
  restoreFocusElement?: HTMLElement | null
}

interface StackEntry extends ModalRegistration {
  inertState: Map<HTMLElement, boolean>
}

class ModalStack {
  private stack: StackEntry[] = []
  private bodyPreviousOverflow = ''
  private bodyPreviousPaddingRight = ''
  private listenerAttached = false

  public push(modal: ModalRegistration): () => void {
    if (typeof window === 'undefined') return () => {}

    const { body } = document
    if (this.stack.length === 0) {
      this.bodyPreviousOverflow = body.style.overflow
      this.bodyPreviousPaddingRight = body.style.paddingRight
      const gutter = window.innerWidth - document.documentElement.clientWidth
      body.style.overflow = 'hidden'
      if (gutter > 0) body.style.paddingRight = `${gutter}px`
      this.attachListener()
    }

    const inertState = new Map<HTMLElement, boolean>()
    const root = modal.getRoot()
    if (root) {
      for (const child of Array.from(body.children)) {
        if (typeof HTMLElement !== 'undefined' && !(child instanceof HTMLElement)) continue
        if (child === root) continue
        if (child.hasAttribute(INERT_EXEMPT_ATTRIBUTE)) continue
        inertState.set(child as HTMLElement, (child as HTMLElement).inert)
        ;(child as HTMLElement).inert = true
      }
    }

    const entry: StackEntry = { ...modal, inertState }
    this.stack.push(entry)

    return () => this.pop(modal.id)
  }

  public pop(id: string): void {
    if (typeof window === 'undefined') return
    const index = this.stack.findIndex(entry => entry.id === id)
    if (index === -1) return

    const [removed] = this.stack.splice(index, 1)
    if (removed) {
      for (const [element, wasInert] of removed.inertState) {
        element.inert = wasInert
      }
      if (removed.restoreFocusElement && document.contains(removed.restoreFocusElement)) {
        removed.restoreFocusElement.focus()
      }
    }

    // Re-evaluate inert for the new top modal, if any remains
    const top = this.top()
    if (top) {
      const topRoot = top.getRoot()
      if (topRoot) {
        topRoot.inert = false
      }
    }

    if (this.stack.length === 0) {
      const { body } = document
      body.style.overflow = this.bodyPreviousOverflow
      body.style.paddingRight = this.bodyPreviousPaddingRight
      this.detachListener()
    }
  }

  public top(): StackEntry | null {
    return this.stack.at(-1) ?? null
  }

  public isTop(id: string): boolean {
    return this.stack.at(-1)?.id === id
  }

  private attachListener(): void {
    if (this.listenerAttached || typeof window === 'undefined') return
    window.addEventListener('keydown', this.handleKeyDown)
    this.listenerAttached = true
  }

  private detachListener(): void {
    if (!this.listenerAttached || typeof window === 'undefined') return
    window.removeEventListener('keydown', this.handleKeyDown)
    this.listenerAttached = false
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    const top = this.top()
    if (!top) return

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      top.onClose()
      return
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (!top.onNavigate) return
      const target = event.target
      if (target instanceof Element && target.matches(MEDIA_OR_EDITABLE)) return
      event.preventDefault()
      event.stopPropagation()
      top.onNavigate(event.key === 'ArrowLeft' ? 'previous' : 'next')
      return
    }

    if (event.key === 'Tab') {
      const scope = top.getRoot() ?? top.getDialog()
      if (!scope) return

      const focusables = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        el => el.getClientRects().length > 0
      )

      if (focusables.length === 0) {
        event.preventDefault()
        event.stopPropagation()
        top.getDialog()?.focus()
        return
      }

      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const active = document.activeElement

      if (!scope.contains(active)) {
        event.preventDefault()
        event.stopPropagation()
        ;(event.shiftKey ? last : first).focus()
        return
      }

      if (event.shiftKey && active === first) {
        event.preventDefault()
        event.stopPropagation()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        event.stopPropagation()
        first.focus()
      }
    }
  }
}

export const modalStack = new ModalStack()
