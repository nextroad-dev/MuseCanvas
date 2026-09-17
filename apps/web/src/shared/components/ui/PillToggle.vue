<script setup lang="ts">
import { cn } from '@/shared/lib/utils'

defineProps<{
  modelValue: boolean
  disabled?: boolean
  /** Accessible name; pass the visible label text so the switch is announced. */
  label?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>

<template>
  <!-- Tonal track with a distinct thumb: on/off is readable from the thumb
       position and the border, not from a subtle color difference alone. -->
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    :class="
      cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors',
        modelValue
          ? 'border-accent bg-accent'
          : 'border-border-control bg-surface-subtle-strong hover:bg-surface-subtle',
        disabled && 'cursor-not-allowed opacity-50',
      )
    "
    @click="emit('update:modelValue', !modelValue)"
  >
    <span
      :class="[
        'inline-block h-[18px] w-[18px] rounded-full bg-surface shadow-sm transition-transform',
        modelValue ? 'translate-x-[21px]' : 'translate-x-[3px]',
      ]"
      aria-hidden="true"
    />
  </button>
</template>