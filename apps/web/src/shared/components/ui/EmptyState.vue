<script setup lang="ts">
import { FileX } from 'lucide-vue-next'
import BaseButton from './BaseButton.vue'

withDefaults(defineProps<{
  title: string
  description: string
  actionLabel?: string
  compact?: boolean
}>(), {
  actionLabel: '开始创作',
  compact: false,
})

defineEmits<{
  action: []
}>()
</script>

<template>
  <div
    :class="[
      'flex flex-col items-center justify-center text-center',
      compact ? 'py-8' : 'py-16',
    ]"
  >
    <div
      :class="[
        'mb-4 flex items-center justify-center rounded-[var(--radius-card)] bg-surface-subtle',
        compact ? 'h-10 w-10' : 'h-12 w-12',
      ]"
    >
      <FileX class="h-6 w-6 text-muted-foreground" />
    </div>
    <h3 :class="['font-medium text-foreground', compact ? 'text-sm' : 'text-sm']">{{ title }}</h3>
    <p class="mt-1 max-w-sm text-xs text-muted-foreground">{{ description }}</p>
    <div v-if="$slots.action || $slots['secondary-action']" class="mt-4 flex gap-2">
      <slot name="action">
        <BaseButton v-if="actionLabel" size="sm" @click="$emit('action')">
          {{ actionLabel }}
        </BaseButton>
      </slot>
      <slot name="secondary-action" />
    </div>
  </div>
</template>
