<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { cn } from '@/shared/lib/utils'

import { useClickOutside } from '@/shared/composables/useClickOutside'

const props = defineProps<{
  modelValue: number
  max: number
  open: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: number]
  'update:open': [value: boolean]
}>()

const containerRef = ref<HTMLElement>()

const options = computed(() => {
  const max = Math.max(1, props.max)
  return Array.from({ length: max }, (_, i) => i + 1)
})

function toggle() {
  if (props.disabled) return
  emit('update:open', !props.open)
}

function select(value: number) {
  emit('update:modelValue', value)
  emit('update:open', false)
}

useClickOutside(containerRef, () => {
  emit('update:open', false)
})
</script>

<template>
  <div ref="containerRef" class="relative">
    <button
      type="button"
      :disabled="disabled"
      class="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border bg-surface px-3 text-sm font-medium text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      :class="open ? 'border-primary' : 'border-border hover:border-border-strong'"
      @click.stop="toggle"
    >
      <span class="truncate">数量 · {{ modelValue }}</span>
      <ChevronDown class="h-3.5 w-3.5 text-muted-foreground shrink-0" :class="open && 'rotate-180'" />
    </button>

    <div
      v-if="open"
      class="absolute left-0 top-full z-[70] mt-1.5 w-32 rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-md"
    >
      <div class="mb-2 px-1 text-xs font-medium text-muted-foreground">生成数量</div>
      <div class="grid grid-cols-2 gap-1.5">
        <button
          v-for="n in options"
          :key="n"
          type="button"
          :class="cn(
            'flex items-center justify-center rounded-[var(--radius-control)] border py-1.5 text-sm font-medium transition-colors',
            n === modelValue
              ? 'border-primary bg-primary-soft text-primary'
              : 'border-border bg-transparent text-foreground hover:bg-surface-subtle'
          )"
          @click="select(n)"
        >
          {{ n }}
        </button>
      </div>
    </div>
  </div>
</template>
