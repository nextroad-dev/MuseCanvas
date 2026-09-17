<script setup lang="ts">
import { computed, onMounted, provide, ref, useId, watch } from 'vue'
import { FIELD_CONTEXT_KEY, type FieldContext } from '@/shared/lib/field-context'
import { cn } from '@/shared/lib/utils'

export interface FieldProps {
  label?: string
  hint?: string
  error?: string
  required?: boolean
}

const props = defineProps<FieldProps>()

const uid = useId()
const controlId = `field-${uid}`
const hintId = `${controlId}-hint`
const errorId = `${controlId}-error`

const controlsRef = ref<HTMLElement | null>(null)

const describedBy = computed(() => {
  if (props.error) return errorId
  if (props.hint) return hintId
  return undefined
})

const isInvalid = computed(() => !!props.error)

provide(FIELD_CONTEXT_KEY, {
  controlId,
  describedBy: () => describedBy.value,
  invalid: () => isInvalid.value,
} satisfies FieldContext)

/**
* Fallback wiring for controls that do not consume the field context (native
* `<input>` / `<select>` and third-party controls): attach the label id and the
* hint/error description directly on the first control of the field.
*/
function linkControl() {
  const root = controlsRef.value
  if (!root) return
  const control = root.querySelector<HTMLElement>('input, textarea, select, [role="combobox"]')
  if (!control) return

  if (!control.hasAttribute('id')) control.id = controlId

  if (describedBy.value) control.setAttribute('aria-describedby', describedBy.value)
  else control.removeAttribute('aria-describedby')

  if (isInvalid.value) control.setAttribute('aria-invalid', 'true')
  else control.removeAttribute('aria-invalid')
}

onMounted(linkControl)
watch([describedBy, isInvalid], linkControl, { flush: 'post' })
</script>

<template>
  <div class="space-y-1.5">
    <label v-if="label" :for="controlId" class="block text-sm font-medium text-foreground">
      {{ label }}
      <template v-if="required">
        <span class="text-danger" aria-hidden="true">*</span>
        <span class="sr-only">必填</span>
      </template>
    </label>
    <div ref="controlsRef">
      <slot />
    </div>
    <p v-if="hint && !error" :id="hintId" class="text-xs text-muted-foreground">{{ hint }}</p>
    <p v-if="error" :id="errorId" :class="cn('text-xs text-danger')">{{ error }}</p>
  </div>
</template>