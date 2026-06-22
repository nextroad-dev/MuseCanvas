<script setup lang="ts">
import { FileX } from 'lucide-vue-next'

defineProps<{
  title: string
  description: string
}>()

defineEmits<{
  action: []
}>()
</script>

<template>
  <div class="flex flex-col items-center justify-center py-16 text-center">
    <div class="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-100">
      <FileX class="h-6 w-6 text-neutral-400" />
    </div>
    <h3 class="mb-1 text-sm font-medium text-neutral-900">{{ title }}</h3>
    <p class="mb-4 max-w-sm text-xs text-neutral-500">{{ description }}</p>
    <slot name="action">
      <button
        class="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
        @click="$emit('action')"
      >
        <slot name="action-label">开始创作</slot>
      </button>
    </slot>
  </div>
</template>
