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
  md: 'h-8 w-8 text-sm',
  lg: 'h-10 w-10 text-base',
}
</script>

<template>
  <span
    :class="[
      'inline-flex items-center justify-center rounded-full bg-primary-soft font-semibold text-primary',
      sizeClasses[size],
    ]"
  >
    <template v-if="src">
      <img :src="src" :alt="name || 'Avatar'" class="h-full w-full rounded-full object-cover" />
    </template>
    <template v-else>
      {{ initial }}
    </template>
  </span>
</template>
