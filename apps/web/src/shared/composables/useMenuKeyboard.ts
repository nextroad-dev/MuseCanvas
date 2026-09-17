import { nextTick, ref, watch, type Ref } from 'vue'

/**
 * Keyboard behavior for menu-like popovers (dropdowns, select popovers, user
 * menus, action menus).
 *
 * Contract used by every menu in the app:
 * - ArrowDown / ArrowUp / Enter / Space on the trigger opens the menu.
 * - ArrowUp / ArrowDown move between items, Home / End jump to the edges.
 * - Enter / Space activate the active item, Escape closes and returns focus to
 *   the trigger, Tab closes and lets focus move on.
 * - After opening, focus lands on the active item so it is visually clear and
 *   announced by assistive technology.
 *
 * Consumers mark their options with `data-menu-item` and (optionally) expose
 * the selected option through `selectedIndex`.
 */
export interface UseMenuKeyboardOptions {
  /** Reactive open state owned by the caller. */
  open: Ref<boolean>
  /** Sets the caller's open state to `true`. */
  openMenu: () => void
  /** Sets the caller's open state to `false`. */
  closeMenu: () => void
  /** Index of the currently selected item, or `-1` when nothing is selected. */
  selectedIndex?: () => number
  /** When it returns `true`, keyboard handling is skipped. */
  disabled?: () => boolean
}

export type MenuInitialFocus = 'first' | 'last' | 'selected'

export function useMenuKeyboard(options: UseMenuKeyboardOptions) {
  const triggerRef = ref<HTMLElement | null>(null)
  const menuRef = ref<HTMLElement | null>(null)
  const activeIndex = ref(-1)

  let initialFocus: MenuInitialFocus = 'selected'
  let restoreFocusOnClose = false

  const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

  function focusTrigger() {
    const root = triggerRef.value
    if (!root) return
    const target = root.matches(FOCUSABLE) ? root : root.querySelector<HTMLElement>(FOCUSABLE)
    target?.focus()
  }

  function items(): HTMLElement[] {
    const root = menuRef.value
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>('[data-menu-item]')).filter(
      (el) => el.getAttribute('aria-disabled') !== 'true' && !el.hasAttribute('disabled'),
    )
  }

  function setActive(index: number, moveFocus = true) {
    const list = items()
    if (list.length === 0) {
      activeIndex.value = -1
      return
    }
    const clamped = Math.max(0, Math.min(index, list.length - 1))
    activeIndex.value = clamped
    if (moveFocus) list[clamped]?.focus()
  }

  function initialIndex(): number {
    if (initialFocus === 'first') return 0
    if (initialFocus === 'last') return items().length - 1
    const selected = options.selectedIndex?.() ?? -1
    return selected >= 0 ? selected : 0
  }

  function openWithFocus(kind: MenuInitialFocus = 'selected') {
    if (options.disabled?.()) return
    initialFocus = kind
    options.openMenu()
  }

  function closeAndRestore() {
    restoreFocusOnClose = true
    options.closeMenu()
  }

  /**
   * Trigger keydown handler. Attach to the trigger element (or a wrapper that
   * contains it) so ArrowUp/ArrowDown and Enter/Space open the menu.
   */
  function handleTriggerKeydown(event: KeyboardEvent) {
    if (options.open.value || options.disabled?.()) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openWithFocus(event.key === 'ArrowUp' ? 'last' : 'first')
    }
  }

  /** Menu keydown handler. Attach to the element that contains the items. */
  function handleMenuKeydown(event: KeyboardEvent) {
    if (options.disabled?.()) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive(activeIndex.value < 0 ? 0 : activeIndex.value + 1)
        return
      case 'ArrowUp':
        event.preventDefault()
        setActive(activeIndex.value <= 0 ? 0 : activeIndex.value - 1)
        return
      case 'Home':
        event.preventDefault()
        setActive(0)
        return
      case 'End':
        event.preventDefault()
        setActive(items().length - 1)
        return
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        if (options.open.value) closeAndRestore()
        return
      case 'Tab':
        options.closeMenu()
        return
      default:
        return
    }
  }

  // Move focus into the menu once it is rendered; give it back on close.
  watch(
    options.open,
    (isOpen) => {
      if (isOpen) {
        void nextTick(() => setActive(initialIndex()))
        return
      }
      if (restoreFocusOnClose) {
        restoreFocusOnClose = false
        focusTrigger()
      }
    },
    { flush: 'post' },
  )

  return {
    triggerRef,
    menuRef,
    activeIndex,
    items,
    setActive,
    openWithFocus,
    closeAndRestore,
    handleTriggerKeydown,
    handleMenuKeydown,
  }
}