import { ref, onUnmounted, type Ref } from 'vue'

const FOCUSABLE_SELECTORS = [
  'button:not([disabled]):not([aria-hidden="true"])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export function useFocusTrap(containerRef: Ref<HTMLElement | null>) {
  const previouslyFocused = ref<HTMLElement | null>(null)

  function getFocusableElements(): HTMLElement[] {
    const container = containerRef.value
    if (!container) return []
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTORS))
  }

  function trapFocus(event: KeyboardEvent) {
    if (event.key !== 'Tab') return
    const focusable = getFocusableElements()
    if (focusable.length === 0) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement as HTMLElement

    if (event.shiftKey) {
      if (active === first || !focusable.includes(active)) {
        event.preventDefault()
        last.focus()
      }
    } else {
      if (active === last || !focusable.includes(active)) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  function activate() {
    previouslyFocused.value = document.activeElement as HTMLElement
    const focusable = getFocusableElements()
    if (focusable.length > 0) {
      focusable[0].focus()
    }
    document.addEventListener('keydown', trapFocus)
  }

  function deactivate() {
    document.removeEventListener('keydown', trapFocus)
    if (previouslyFocused.value && typeof previouslyFocused.value.focus === 'function') {
      previouslyFocused.value.focus()
    }
  }

  onUnmounted(() => {
    document.removeEventListener('keydown', trapFocus)
  })

  return { activate, deactivate, previouslyFocused }
}
