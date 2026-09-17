<script setup lang="ts">
import { ChevronDown } from 'lucide-vue-next'
import { cn } from '@/shared/lib/utils'
import Popover from './Popover.vue'

export interface SelectPopoverProps {
  open: boolean
  disabled?: boolean
  /** Trigger text when no `trigger-label` slot is provided. */
  label?: string
  /** Accessible name of the option list. */
  popupLabel?: string
  panelClass?: string
}

const props = defineProps<SelectPopoverProps>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

function close() {
  emit('update:open', false)
}
</script>

<template>
  <Popover
    :model-value="open"
    :disabled="disabled"
    :label="props.popupLabel || props.label"
    :panel-class="cn('left-0 top-full z-popover mt-1.5', props.panelClass)"
    @update:model-value="emit('update:open', $event)"
  >
    <template #trigger="{ open: isOpen, toggle }">
      <button
        type="button"
        :disabled="disabled"
        aria-haspopup="listbox"
        :aria-expanded="isOpen"
        class="inline-flex min-h-10 items-center gap-1.5 rounded-[var(--radius-control)] border border-border-control bg-surface px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-50"
        :class="isOpen && 'bg-surface-subtle'"
        @click.stop="toggle"
      >
        <span class="max-w-[140px] truncate">
          <slot name="trigger-label">{{ props.label }}</slot>
        </span>
        <ChevronDown
          class="h-4 w-4 shrink-0 text-muted-foreground transition-transform"
          :class="isOpen && 'rotate-180'"
          aria-hidden="true"
        />
      </button>
    </template>
    <div @click.stop>
      <slot :close="close" />
    </div>
  </Popover>
</template>