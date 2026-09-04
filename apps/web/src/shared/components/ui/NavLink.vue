<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { cn } from '@/shared/lib/utils'

export interface NavLinkProps {
  to: string
  active?: boolean
}

defineProps<NavLinkProps>()
</script>

<template>
  <RouterLink
    :to="to"
    :class="cn(
      'rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition-colors',
      active
        ? 'bg-primary-soft text-primary'
        : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground',
    )"
  >
    <slot />
  </RouterLink>
</template>
