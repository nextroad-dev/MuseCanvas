<script setup lang="ts">
import { cn } from '@/shared/lib/utils'

defineProps<{
  modelValue: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :disabled="disabled"
    :class="
      cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
        modelValue ? 'bg-primary' : 'bg-neutral-300',
        disabled && 'cursor-not-allowed opacity-50',
      )
    "
    @click="emit('update:modelValue', !modelValue)"
  >
    <span
      :class="[
        'inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
        modelValue ? 'translate-x-[18px]' : 'translate-x-0.5',
      ]"
    />
  </button>
</template>
