<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { FIELD_CONTEXT_KEY } from '@/shared/lib/field-context'
import { fieldClass } from '@/shared/lib/field-styles'

const props = defineProps<{
  modelValue: string
  placeholder?: string
  maxLength?: number
  disabled?: boolean
  autoFocus?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const field = inject(FIELD_CONTEXT_KEY, null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const charCount = computed(() => props.modelValue.length)

const rootClasses = computed(() => [
  fieldClass(field?.invalid()),
  'resize-none py-3 text-base leading-[1.59]',
].join(' '))

onMounted(() => {
  if (props.autoFocus && textareaRef.value) {
    textareaRef.value.focus()
  }
})
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <textarea
      ref="textareaRef"
      :id="field?.controlId"
      :value="modelValue"
      :placeholder="placeholder || '输入提示词描述你想要生成的图片...'"
      :disabled="disabled"
      :maxlength="maxLength"
      :aria-invalid="field?.invalid() || undefined"
      :aria-describedby="field?.describedBy()"
      rows="6"
      :class="rootClasses"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />
    <div v-if="maxLength" class="flex justify-end text-xs tabular-nums text-muted-foreground">
      {{ charCount }} / {{ maxLength }}
    </div>
  </div>
</template>