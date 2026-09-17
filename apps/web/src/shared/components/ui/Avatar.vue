<script setup lang="ts">
export interface AvatarProps {
  name?: string
  src?: string
  size?: 'sm' | 'md' | 'lg'
}

const props = withDefaults(defineProps<AvatarProps>(), {
  size: 'md',
})

const initial = props.name?.charAt(0).toUpperCase() ?? '?'

const sizeClasses = {
  sm: 'h-6 w-6 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
}
</script>

<template>
  <span
    :class="[
      'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-subtle font-medium text-foreground',
      sizeClasses[size],
    ]"
  >
    <template v-if="src">
      <img :src="src" :alt="name || 'Avatar'" class="h-full w-full object-cover"/>
    </template>
    <template v-else>
      {{ initial }}
    </template>
  </span>
</template>