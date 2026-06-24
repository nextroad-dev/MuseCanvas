<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { cn } from '@/shared/lib/utils'
import type { Quality } from '@/shared/types'

import { useClickOutside } from '@/shared/composables/useClickOutside'

const props = defineProps<{
  modelValue: Quality
  options: Quality[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: Quality]
}>()

const labels: Record<Quality, string> = {
  auto: '自动',
  low: '低',
  medium: '中',
  high: '高',
}

const open = ref(false)
const containerRef = ref<HTMLElement>()

const selectedLabel = computed(() => labels[props.modelValue] ?? '质量')

function toggle() {
  open.value = !open.value
}

function select(q: Quality) {
  emit('update:modelValue', q)
  open.value = false
}

useClickOutside(containerRef, () => {
  open.value = false
})
</script>

<template>
  <div ref="containerRef" class="relative">
    <button
      type="button"
      class="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border bg-surface px-3 text-sm font-medium text-foreground transition-colors"
      :class="open ? 'border-primary' : 'border-border hover:border-border-strong'"
      @click.stop="toggle"
    >
      <span class="truncate">质量 · {{ selectedLabel }}</span>
      <ChevronDown class="h-3.5 w-3.5 text-muted-foreground shrink-0" :class="open && 'rotate-180'" />
    </button>

    <div
      v-if="open"
      class="absolute left-0 top-full z-50 mt-1.5 w-44 rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-md"
    >
      <div class="mb-2 px-1 text-xs font-medium text-muted-foreground">选择质量</div>
      <div class="flex flex-col gap-1">
        <button
          v-for="q in options"
          :key="q"
          type="button"
          :class="cn(
            'flex items-center rounded-[var(--radius-control)] px-3 py-1.5 text-left transition-colors',
            q === modelValue
              ? 'bg-primary-soft text-primary'
              : 'text-foreground hover:bg-surface-subtle'
          )"
          @click="select(q)"
        >
          <span class="text-sm font-medium">{{ labels[q] }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
