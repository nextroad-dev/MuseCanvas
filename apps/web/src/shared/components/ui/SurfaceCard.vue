<script setup lang="ts">
import { cn } from '@/shared/lib/utils'

type Tone = 'default' | 'subtle' | 'brand' | 'danger'
type Padding = 'none' | 'sm' | 'md' | 'lg'

withDefaults(defineProps<{
  tone?: Tone
  padding?: Padding
}>(), {
  tone: 'default',
  padding: 'md',
})

const toneClasses: Record<Tone, string> = {
  default: 'bg-surface border-border',
  subtle: 'bg-surface-subtle border-border',
  brand: 'bg-primary-soft border-primary-soft-hover',
  danger: 'bg-danger-soft border-red-200',
}

const paddingClasses: Record<Padding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6',
}
</script>

<template>
  <div :class="cn('rounded-[var(--radius-card)] border shadow-sm', toneClasses[tone], paddingClasses[padding])">
    <div v-if="$slots.header" class="mb-4">
      <slot name="header" />
    </div>
    <slot />
    <div v-if="$slots.footer" class="mt-4">
      <slot name="footer" />
    </div>
  </div>
</template>
