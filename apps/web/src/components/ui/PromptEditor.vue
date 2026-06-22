<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  modelValue: string
  placeholder?: string
  maxLength?: number
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const charCount = computed(() => props.modelValue.length)
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <textarea
      :value="modelValue"
      :placeholder="placeholder || '输入提示词描述你想要生成的图片...'"
      :disabled="disabled"
      :maxlength="maxLength"
      rows="6"
      :class="
        cn(
          'w-full resize-none rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 transition-colors',
          'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
          disabled && 'cursor-not-allowed opacity-50',
        )
      "
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />
    <div v-if="maxLength" class="flex justify-end text-xs text-neutral-400">
      {{ charCount }} / {{ maxLength }}
    </div>
  </div>
</template>
