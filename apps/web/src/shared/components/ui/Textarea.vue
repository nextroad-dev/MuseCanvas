<script setup lang="ts">
import { computed, inject } from 'vue'
import { FIELD_CONTEXT_KEY } from '@/shared/lib/field-context'
import { fieldClass } from '@/shared/lib/field-styles'

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

const field = inject(FIELD_CONTEXT_KEY, null)

const rootClasses = computed(() => [
  fieldClass(props.invalid || field?.invalid()),
  'py-2 leading-[1.59] resize-y',
].join(' '))
const isInvalid = computed(() => props.invalid || field?.invalid() || false)

function handleInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <textarea
    :id="field?.controlId"
    :value="modelValue"
    :placeholder="placeholder"
    :rows="rows"
    :disabled="disabled"
    :readonly="readonly"
    :autocomplete="autocomplete"
    :aria-invalid="isInvalid || undefined"
    :aria-describedby="field?.describedBy()"
    :class="rootClasses"
    @input="handleInput"
  />
</template>