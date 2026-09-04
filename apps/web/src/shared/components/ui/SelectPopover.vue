<script setup lang="ts">
import { ChevronDown } from 'lucide-vue-next'
import { cn } from '@/shared/lib/utils'
import Popover from './Popover.vue'

export interface SelectPopoverProps {
  open: boolean
  disabled?: boolean
  label?: string
  panelClass?: string
}

defineProps<SelectPopoverProps>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

function close() {
  emit('update:open', false)
}
</script>

<template>
  <Popover :model-value="open" @update:model-value="emit('update:open', $event)">
    <template #trigger="{ open: isOpen, toggle }">
      <button
        type="button"
        :disabled="disabled"
        class="inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-control)] border bg-surface px-4 text-base font-medium text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        :class="isOpen ? 'border-primary' : 'border-border hover:border-border-strong'"
        @click.stop="toggle"
      >
        <span class="truncate max-w-[140px]">
          <slot name="trigger-label">{{ label }}</slot>
        </span>
        <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" :class="isOpen && 'rotate-180'" aria-hidden="true" />
      </button>
    </template>
    <div
      :class="cn(
        'rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-md',
        panelClass,
      )"
      @click.stop
    >
      <slot :close="close" />
    </div>
  </Popover>
</template>
