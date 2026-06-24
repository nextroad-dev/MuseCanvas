<script setup lang="ts" generic="T extends string">
import { cn } from '@/shared/lib/utils'

export interface PillOption<TValue extends string = string> {
  value: TValue
  label: string
}

defineProps<{
  modelValue: T
  options: PillOption<T>[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: T]
}>()
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      :disabled="disabled"
      :class="
        cn(
          'rounded-full border px-4 py-1.5 text-sm font-medium transition-colors',
          modelValue === option.value
            ? 'border-primary bg-primary text-white'
            : 'border-border bg-surface text-muted-foreground hover:border-border-strong hover:bg-surface-subtle',
          disabled && 'cursor-not-allowed opacity-50',
        )
      "
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
