<script setup lang="ts">
import { computed } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { cn } from '@/shared/lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

const props = withDefaults(defineProps<{
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
  ariaLabel?: string
}>(), {
  variant: 'primary',
  size: 'md',
  type: 'button',
})

const emit = defineEmits<{
  click: [event: MouseEvent]
}>()

const baseClasses = 'inline-flex items-center justify-center gap-1.5 font-medium transition-colors focus-visible:outline-none'

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active disabled:opacity-50',
  secondary: 'border border-border bg-surface text-foreground hover:bg-surface-subtle active:bg-neutral-100 disabled:opacity-50',
  ghost: 'text-foreground hover:bg-surface-subtle active:bg-neutral-100 disabled:opacity-50',
  danger: 'bg-danger text-white hover:bg-red-700 active:bg-red-800 disabled:opacity-50',
  'danger-ghost': 'text-danger hover:bg-danger-soft active:bg-red-100 disabled:opacity-50',
}

const sizeClasses = computed(() => {
  switch (props.size) {
    case 'sm': return 'h-8 px-3 text-xs rounded-[var(--radius-control)]'
    case 'lg': return 'h-12 px-6 text-sm rounded-[var(--radius-control)]'
    case 'icon': return 'h-10 w-10 rounded-[var(--radius-control)]'
    default: return 'h-10 px-4 text-sm rounded-[var(--radius-control)]'
  }
})

const isDisabled = computed(() => props.disabled || props.loading)
</script>

<template>
  <button
    :type="type"
    :class="cn(baseClasses, variantClasses[variant], sizeClasses)"
    :disabled="isDisabled"
    :aria-busy="loading"
    :aria-label="ariaLabel"
    @click="emit('click', $event)"
  >
    <Loader2 v-if="loading" class="h-4 w-4 animate-spin" aria-hidden="true" />
    <slot name="icon" />
    <slot />
  </button>
</template>
