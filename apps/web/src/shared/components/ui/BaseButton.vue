<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
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
  to?: string
  href?: string
}>(), {
  variant: 'primary',
  size: 'md',
  type: 'button',
})

const emit = defineEmits<{
  click: [event: MouseEvent]
}>()

const tag = computed(() => {
  if (props.to) return RouterLink
  if (props.href) return 'a'
  return 'button'
})

const isButton = computed(() => tag.value === 'button')

const baseClasses = 'inline-flex items-center justify-center gap-1.5 font-medium transition-colors disabled:cursor-not-allowed'

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-foreground-inverse hover:bg-primary-hover active:bg-primary-active disabled:opacity-50',
  secondary: 'bg-surface-subtle text-foreground hover:bg-surface-subtle-strong active:bg-surface-subtle-strong disabled:opacity-50',
  ghost: 'bg-transparent text-foreground hover:bg-surface-subtle active:bg-surface-subtle-strong disabled:opacity-50',
  danger: 'bg-danger text-foreground-inverse hover:bg-danger-hover active:bg-danger-active disabled:opacity-50',
  'danger-ghost': 'bg-transparent text-danger hover:bg-danger-soft active:bg-danger-soft disabled:opacity-50',
}

const sizeClasses = computed(() => {
  switch (props.size) {
    case 'sm': return 'min-h-8 px-3 text-xs rounded-[var(--radius-control)]'
    case 'lg': return 'min-h-12 px-6 text-sm rounded-[var(--radius-control)]'
    case 'icon': return 'h-10 w-10 rounded-[var(--radius-control)]'
    default: return 'min-h-10 px-4 text-sm rounded-[var(--radius-control)]'
  }
})

const isDisabled = computed(() => props.disabled || props.loading)
</script>

<template>
  <component
    :is="tag"
    :type="isButton ? type : undefined"
    :to="to || undefined"
    :href="href || undefined"
    :class="cn(baseClasses, variantClasses[variant], sizeClasses)"
    :disabled="isButton ? isDisabled : undefined"
    :aria-busy="loading || undefined"
    :aria-disabled="!isButton && isDisabled ? 'true' : undefined"
    :aria-label="ariaLabel"
    @click="emit('click', $event)"
  >
    <Loader2 v-if="loading" class="h-4 w-4 animate-spin" aria-hidden="true"/>
    <slot name="icon" />
    <slot />
  </component>
</template>