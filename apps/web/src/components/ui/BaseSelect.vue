<script setup lang="ts" generic="T extends string">
import { useAttrs } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

defineOptions({ inheritAttrs: false })
defineProps<{ modelValue: T; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()
const attrs = useAttrs()
</script>

<template>
  <div class="relative w-full">
    <select
      v-bind="attrs"
      :value="modelValue"
      :disabled="disabled"
      class="h-9 w-full appearance-none rounded-lg border border-neutral-200 bg-white px-3 pr-9 text-sm text-neutral-900 shadow-sm transition-colors hover:border-neutral-300 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400 disabled:opacity-70"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value as T)"
    >
      <slot />
    </select>
    <ChevronDown class="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
  </div>
</template>
