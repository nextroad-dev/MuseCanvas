<script setup lang="ts">
import { computed } from 'vue'
import { AlertCircle, FileX, Lock, SearchX, UploadCloud } from 'lucide-vue-next'
import BaseButton from './BaseButton.vue'

export type EmptyStateKind = 'first-use' | 'filtered' | 'permission' | 'error' | 'upload'

const props = withDefaults(defineProps<{
  title: string
  description: string
  kind?: EmptyStateKind
  actionLabel?: string
  compact?: boolean
}>(), {
  kind: 'first-use',
  compact: false,
})

defineEmits<{
  action: []
}>()

const icons = {
  'first-use': FileX,
  filtered: SearchX,
  permission: Lock,
  error: AlertCircle,
  upload: UploadCloud,
}

const icon = computed(() => icons[props.kind])

// Only upload affordances keep the dashed outline; other empty states are
// plain, bordered surfaces.
const containerClass = computed(() =>
  props.kind === 'upload'
    ? 'rounded-[var(--radius-card)] border border-dashed border-border-control bg-surface'
    : '',
)
</script>

<template>
  <div
    :class="[
      'flex flex-col items-center justify-center text-center',
      containerClass,
      compact ? 'py-8' : 'py-16',
    ]"
  >
    <div
      :class="[
        'mb-4 flex items-center justify-center rounded-[var(--radius-control)] bg-surface-subtle',
        compact ? 'h-10 w-10' : 'h-12 w-12',
      ]"
      aria-hidden="true"
    >
      <component :is="icon" class="h-5 w-5 text-muted-foreground"/>
    </div>
    <h3 class="text-sm font-medium text-foreground">{{ title }}</h3>
    <p class="mt-1 max-w-sm text-xs text-muted-foreground">{{ description }}</p>
    <div v-if="$slots.action || $slots['secondary-action'] || actionLabel" class="mt-4 flex gap-2">
      <slot name="action">
        <BaseButton v-if="actionLabel" size="sm" @click="$emit('action')">
          {{ actionLabel }}
        </BaseButton>
      </slot>
      <slot name="secondary-action" />
    </div>
  </div>
</template>