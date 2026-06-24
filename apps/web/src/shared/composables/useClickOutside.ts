import { onMounted, onUnmounted, type Ref } from 'vue'

export function useClickOutside(
  targetRef: Ref<HTMLElement | null | undefined>,
  handler: () => void
) {
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
    document.addEventListener('keydown', onKeydown)
  })

  onUnmounted(() => {
    document.removeEventListener('click', onClick)
    document.removeEventListener('keydown', onKeydown)
  })
}
