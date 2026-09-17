<script setup lang="ts">
import { onBeforeUnmount, ref, useId } from 'vue'
import { cn } from '@/shared/lib/utils'

const props = withDefaults(defineProps<{
  /** Short, non-interactive explanation. Interactive content must be a Popover. */
  text: string
  placement?: 'top' | 'bottom'
}>(), {
  placement: 'top',
})

const open = ref(false)
const triggerRef = ref<HTMLElement | null>(null)
const tooltipId = `tooltip-${useId()}`
let hideTimer: ReturnType<typeof setTimeout> | null = null

function describedTargets(): HTMLElement[] {
  const root = triggerRef.value
  if (!root) return []
  return [
    root,
    ...Array.from(root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')),
  ]
}

/** Wires `aria-describedby` on the trigger while the tooltip is visible. */
function link() {
  for (const el of describedTargets()) el.setAttribute('aria-describedby', tooltipId)
}

function unlink() {
  for (const el of describedTargets()) {
    if (el.getAttribute('aria-describedby') === tooltipId) el.removeAttribute('aria-describedby')
  }
}

function show() {
  if (hideTimer) clearTimeout(hideTimer)
  open.value = true
  link()
}

function hide(delay = 60) {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    open.value = false
    unlink()
  }, delay)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    open.value = false
    unlink()
  }
}

onBeforeUnmount(() => {
  if (hideTimer) clearTimeout(hideTimer)
  unlink()
})
</script>

<template>
  <span
    ref="triggerRef"
    class="relative inline-flex"
    @mouseenter="show"
    @mouseleave="hide()"
    @focusin="show"
    @focusout="hide()"
    @keydown="onKeydown"
  >
    <slot />
    <Transition
      enter-active-class="transition duration-[var(--motion-base)] ease-standard"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-[var(--motion-fast)] ease-standard"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <span
        v-if="open"
        :id="tooltipId"
        role="tooltip"
        :class="cn(
          'absolute left-1/2 z-popover max-w-xs -translate-x-1/2 rounded-[var(--radius-popover)] bg-foreground px-2 py-1 text-xs leading-[1.5] text-foreground-inverse shadow-md',
          props.placement === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )"
        @mouseenter="show"
        @mouseleave="hide()"
      >
        {{ props.text }}
      </span>
    </Transition>
  </span>
</template>