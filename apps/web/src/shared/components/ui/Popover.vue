<script setup lang="ts">
import { computed, ref } from 'vue'
import { useClickOutside } from '@/shared/composables/useClickOutside'
import { useMenuKeyboard } from '@/shared/composables/useMenuKeyboard'
import { cn } from '@/shared/lib/utils'

export interface PopoverProps {
  modelValue: boolean
  /** Extra panel classes (width, alignment). */
  panelClass?: string
  /** Accessible name of the popup, e.g. "选择模型". */
  label?: string
  /** ARIA role of the popup container. Default: `listbox`. */
  role?: 'listbox' | 'menu' | 'dialog'
  disabled?: boolean
}

const props = withDefaults(defineProps<PopoverProps>(), {
  role: 'listbox',
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const openRef = computed(() => props.modelValue)
const rootRef = ref<HTMLDivElement | null>(null)

const {
  triggerRef,
  menuRef,
  openWithFocus,
  closeAndRestore,
  handleTriggerKeydown,
  handleMenuKeydown,
} = useMenuKeyboard({
  open: openRef,
  openMenu: () => emit('update:modelValue', true),
  closeMenu: () => emit('update:modelValue', false),
  disabled: () => props.disabled,
})

function close() {
  emit('update:modelValue', false)
}

function toggle() {
  if (props.disabled) return
  if (props.modelValue) {
    close()
    return
  }
  openWithFocus('selected')
}

// Escape is handled by the menu keyboard (which also restores focus).
useClickOutside(rootRef, close, { escape: false })
</script>

<template>
  <div ref="rootRef" class="relative inline-block">
    <span
      ref="triggerRef"
      class="contents"
      @keydown="handleTriggerKeydown"
    >
      <slot name="trigger" :open="modelValue" :toggle="toggle" :close="close" />
    </span>

    <Transition
      enter-active-class="transition duration-[var(--motion-base)] ease-standard"
      enter-from-class="opacity-0 -translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-[var(--motion-fast)] ease-standard"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-1"
    >
      <div
        v-if="modelValue"
        ref="menuRef"
        :role="role"
        :aria-label="label"
        :class="cn(
          'absolute z-dropdown mt-1 rounded-[var(--radius-popover)] border border-border bg-surface p-2 shadow-md',
          panelClass,
        )"
        @keydown="handleMenuKeydown"
      >
        <slot :close="close" :restore-focus="closeAndRestore" />
      </div>
    </Transition>
  </div>
</template>