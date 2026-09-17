<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/shared/lib/utils'

type BadgeTone = 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral'

export interface BadgeProps {
  tone?: BadgeTone
  variant?: 'soft' | 'outline'
}

const props = withDefaults(defineProps<BadgeProps>(), {
  tone: 'neutral',
  variant: 'soft',
})

// Static status pills: 12px text, soft semantic surfaces. Never styled as a
// button (no hover/press affordance) so they cannot be mistaken for controls.
const toneClasses: Record<BadgeTone, string> = {
  brand: 'bg-accent-soft text-accent-strong border-accent-soft',
  success: 'bg-success-soft text-success border-success-soft',
  warning: 'bg-warning-soft text-warning border-warning-soft',
  danger: 'bg-danger-soft text-danger border-danger-soft',
  info: 'bg-info-soft text-info border-info-soft',
  neutral: 'bg-neutral-soft text-neutral-status border-neutral-soft',
}

const variantClasses = computed(() => {
  if (props.variant === 'outline') {
    return cn('bg-transparent border', toneClasses[props.tone])
  }
  return toneClasses[props.tone]
})
</script>

<template>
  <span
    :class="cn(
      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
      variantClasses,
    )"
  >
    <slot />
  </span>
</template>