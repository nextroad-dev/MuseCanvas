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

// Skeletons are decorative: they mirror the geometry of the incoming content,
// are never announced, and their parent region carries `aria-busy`.
</script>

<template>
  <div
    :class="cn('animate-pulse rounded-[var(--radius-control)] bg-surface-subtle', $props.class)"
    aria-hidden="true"
  >
    <template v-if="variant === 'text'">
      <div v-for="i in lines" :key="i" class="mb-2 h-4 w-full rounded-[var(--radius-control)] bg-surface-subtle last:mb-0" :class="i === lines ? 'w-3/4' : 'w-full'"/>
    </template>
    <template v-if="variant === 'card'">
      <div class="h-24 w-full rounded-[var(--radius-card)] bg-surface-subtle"/>
    </template>
    <template v-if="variant === 'table-row'">
      <div class="flex gap-3 py-2">
        <div class="h-4 w-24 rounded-[var(--radius-control)] bg-surface-subtle"/>
        <div class="h-4 flex-1 rounded-[var(--radius-control)] bg-surface-subtle"/>
        <div class="h-4 w-20 rounded-[var(--radius-control)] bg-surface-subtle"/>
      </div>
    </template>
    <template v-if="variant === 'image'">
      <div class="aspect-square w-full rounded-[var(--radius-card)] bg-surface-subtle"/>
    </template>
  </div>
</template>