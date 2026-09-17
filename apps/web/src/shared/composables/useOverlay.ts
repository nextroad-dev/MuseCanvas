import { onUnmounted, ref, watch, type Ref } from 'vue'
import { useFocusTrap } from './useFocusTrap'

export interface UseOverlayOptions {
  /** Called immediately after the overlay is activated. */
  onOpen?: () => void
  /** Called immediately before the overlay is deactivated. */
  onClose?: () => void
  /** Close the overlay when Escape is pressed. Default: true. */
  closeOnEscape?: boolean
  /** Lock body scroll while the overlay is open. Default: true. */
  lockScroll?: boolean
  /** Trap focus inside the container while the overlay is open. Default: true. */
  trapFocus?: boolean
}

/**
 * Shared overlay behavior used by Modal, Drawer and Lightbox.
 *
 * - Focus trap on open + restore on close
 * - Document-level Escape handler
 * - Body scroll lock
 * - Marks the application root `inert` while the trap is active so the page
 *   behind the overlay cannot be reached by keyboard or AT (nested overlays are
 *   counted, so the attribute is only removed when the last one closes).
 *   All three overlays teleport to `body`, so `#app` never contains them.
 */
let inertHolders = 0

function acquireInert() {
  inertHolders += 1
  if (inertHolders === 1) {
    document.getElementById('app')?.setAttribute('inert', '')
  }
}

function releaseInert() {
  inertHolders = Math.max(0, inertHolders - 1)
  if (inertHolders === 0) {
    document.getElementById('app')?.removeAttribute('inert')
  }
}

export function useOverlay(
  containerRef: Ref<HTMLElement | null>,
  openRef: Ref<boolean>,
  options: UseOverlayOptions = {}
) {
  const {
    onOpen,
    onClose,
    closeOnEscape = true,
    lockScroll = true,
    trapFocus = true,
  } = options

  const { activate: activateTrap, deactivate: deactivateTrap } = useFocusTrap(containerRef)

  const isActive = ref(false)
  let originalOverflow = ''

  function open() {
    if (isActive.value) return
    isActive.value = true

    if (lockScroll) {
      originalOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }

    if (trapFocus) {
      acquireInert()
      activateTrap()
    }

    onOpen?.()
  }

  function close() {
    if (!isActive.value) return
    isActive.value = false

    if (trapFocus) {
      deactivateTrap()
      releaseInert()
    }

    if (lockScroll) {
      document.body.style.overflow = originalOverflow
    }

    onClose?.()
  }

  function toggle() {
    if (isActive.value) {
      close()
    } else {
      open()
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (closeOnEscape && event.key === 'Escape') {
      close()
    }
  }

  function addListeners() {
    document.addEventListener('keydown', handleKeydown)
  }

  function removeListeners() {
    document.removeEventListener('keydown', handleKeydown)
  }

  watch(openRef, (openValue) => {
    if (openValue) {
      addListeners()
      open()
    } else {
      removeListeners()
      close()
    }
  }, { immediate: true, flush: 'post' })

  onUnmounted(() => {
    removeListeners()
    if (isActive.value) {
      close()
    }
  })

  return {
    isActive,
    open,
    close,
    toggle,
  }
}