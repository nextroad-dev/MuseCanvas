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

const toneClasses: Record<BadgeTone, string> = {
  brand: 'bg-primary-soft text-primary border-primary-soft-hover',
  success: 'bg-success-soft text-success border-success-soft',
  warning: 'bg-warning-soft text-warning border-warning-soft',
  danger: 'bg-danger-soft text-danger border-danger-soft',
  info: 'bg-info-soft text-info border-info-soft',
  neutral: 'bg-neutral-soft text-neutral-status border-border',
}

const variantClasses = computed(() => {
  if (props.variant === 'outline') {
    return 'bg-transparent border'
  }
  return toneClasses[props.tone]
})
</script>

<template>
  <span
    :class="cn(
      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
      variantClasses,
    )"
  >
    <slot />
  </span>
</template>
