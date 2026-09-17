import { onMounted, onUnmounted, type Ref } from 'vue'

export interface UseClickOutsideOptions {
  /**
   * Close on Escape. Default `true`; set to `false` when a menu keyboard
   * composable owns Escape (it also returns focus to the trigger).
   */
  escape?: boolean
}

export function useClickOutside(
  targetRef: Ref<HTMLElement | null | undefined>,
  handler: () => void,
  options: UseClickOutsideOptions = {},
) {
  const { escape = true } = options

  function onClick(event: MouseEvent) {
    const target = event.target as Node
    if (targetRef.value && !targetRef.value.contains(target)) {
      handler()
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      handler()
    }
  }

  onMounted(() => {
    document.addEventListener('click', onClick)
    if (escape) document.addEventListener('keydown', onKeydown)
  })

  onUnmounted(() => {
    document.removeEventListener('click', onClick)
    if (escape) document.removeEventListener('keydown', onKeydown)
  })
}