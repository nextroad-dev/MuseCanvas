<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useClickOutside } from '@/shared/composables/useClickOutside'

export interface PopoverProps {
  modelValue: boolean
}

const props = defineProps<PopoverProps>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const popoverRef = ref<HTMLDivElement | null>(null)

function close() {
  emit('update:modelValue', false)
}

function toggle() {
  emit('update:modelValue', !props.modelValue)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    close()
  }
}

useClickOutside(popoverRef, close)

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div ref="popoverRef" class="relative inline-block">
    <slot name="trigger" :open="modelValue" :toggle="toggle" :close="close" />
    <Transition
      enter-active-class="transition ease-out duration-[var(--motion-fast)]"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition ease-in duration-[var(--motion-fast)]"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="modelValue"
        class="absolute z-dropdown w-64 rounded-[var(--radius-card)] border border-border bg-surface p-3 shadow-md"
      >
        <slot :close="close" />
      </div>
    </Transition>
  </div>
</template>
