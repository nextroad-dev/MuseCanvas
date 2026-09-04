<script setup lang="ts">
import { computed } from 'vue'

export interface TextInputProps {
  modelValue?: string
  type?: 'text' | 'password' | 'email' | 'search' | 'url' | 'tel' | 'datetime-local'
  placeholder?: string
  disabled?: boolean
  readonly?: boolean
  autocomplete?: string
  inputmode?: 'text' | 'search' | 'none' | 'url' | 'email' | 'tel' | 'numeric' | 'decimal'
  invalid?: boolean
}

const props = withDefaults(defineProps<TextInputProps>(), {
  type: 'text',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const rootClasses = computed(() => {
  return [
    'h-9 w-full rounded-[var(--radius-control)] border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground transition-colors',
    'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
    'disabled:cursor-not-allowed disabled:opacity-50',
    props.invalid ? 'border-danger' : 'border-border',
  ]
})

function handleInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <input
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    :autocomplete="autocomplete"
    :inputmode="inputmode"
    :class="rootClasses"
    @input="handleInput"
  />
</template>
