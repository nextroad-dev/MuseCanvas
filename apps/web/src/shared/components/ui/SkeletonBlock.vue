<script setup lang="ts">
import { cn } from '@/shared/lib/utils'

type SkeletonVariant = 'text' | 'card' | 'table-row' | 'image'

withDefaults(defineProps<{
  variant?: SkeletonVariant
  lines?: number
  class?: string
}>(), {
  variant: 'text',
  lines: 1,
})
</script>

<template>
  <div
    :class="cn('animate-pulse bg-surface-subtle rounded-[var(--radius-control)]', $props.class)"
    role="status"
    aria-label="加载中"
  >
    <template v-if="variant === 'text'">
      <div v-for="i in lines" :key="i" class="mb-2 h-4 w-full rounded bg-neutral-200/60 last:mb-0" :class="i === lines ? 'w-3/4' : 'w-full'" />
    </template>
    <template v-if="variant === 'card'">
      <div class="h-40 w-full rounded-[var(--radius-card)] bg-neutral-200/60" />
    </template>
    <template v-if="variant === 'table-row'">
      <div class="flex gap-3 py-3">
        <div class="h-4 w-24 rounded bg-neutral-200/60" />
        <div class="h-4 flex-1 rounded bg-neutral-200/60" />
        <div class="h-4 w-20 rounded bg-neutral-200/60" />
      </div>
    </template>
    <template v-if="variant === 'image'">
      <div class="aspect-square w-full rounded-[var(--radius-card)] bg-neutral-200/60" />
    </template>
  </div>
</template>
