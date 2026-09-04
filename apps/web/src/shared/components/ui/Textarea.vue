<script setup lang="ts">
import { computed } from 'vue'

export interface TextareaProps {
  modelValue?: string
  placeholder?: string
  rows?: number
  disabled?: boolean
  readonly?: boolean
  autocomplete?: string
  invalid?: boolean
}

const props = withDefaults(defineProps<TextareaProps>(), {
  rows: 4,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const rootClasses = computed(() => {
  return [
    'w-full resize-none rounded-[var(--radius-control)] border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors',
    'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
    'disabled:cursor-not-allowed disabled:opacity-50',
    props.invalid ? 'border-danger' : 'border-border',
  ]
})

function handleInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <textarea
    :value="modelValue"
    :placeholder="placeholder"
    :rows="rows"
    :disabled="disabled"
    :readonly="readonly"
    :autocomplete="autocomplete"
    :class="rootClasses"
    @input="handleInput"
  />
</template>
