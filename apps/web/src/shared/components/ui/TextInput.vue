<script setup lang="ts">
import { computed, inject } from 'vue'
import { FIELD_CONTEXT_KEY } from '@/shared/lib/field-context'
import { fieldClass } from '@/shared/lib/field-styles'

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

const field = inject(FIELD_CONTEXT_KEY, null)

const rootClasses = computed(() => fieldClass(props.invalid || field?.invalid()))
const isInvalid = computed(() => props.invalid || field?.invalid() || false)

function handleInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <input
    :id="field?.controlId"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    :autocomplete="autocomplete"
    :inputmode="inputmode"
    :aria-invalid="isInvalid || undefined"
    :aria-describedby="field?.describedBy()"
    :class="rootClasses"
    @input="handleInput"
  />
</template>