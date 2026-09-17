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
  <!-- Current item: accent-soft surface + accent-strong text, and an explicit
       aria-current so nested routes cannot mark the wrong entry as current. -->
  <RouterLink
    :to="to"
    :aria-current="active ? 'page' : undefined"
    :class="cn(
      'rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition-colors',
      active
        ? 'bg-accent-soft text-accent-strong'
        : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground',
    )"
  >
    <slot />
  </RouterLink>
</template>