<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import type { ModelConfig } from '@/shared/types'

import { useClickOutside } from '@/shared/composables/useClickOutside'

const props = defineProps<{
  models: ModelConfig[]
  modelValue: string
  open: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:open': [value: boolean]
}>()

const containerRef = ref<HTMLElement>()

const selectedModel = computed(() => props.models.find(m => m.id === props.modelValue))

function toggle() {
  if (props.disabled) return
  emit('update:open', !props.open)
}

function select(id: string) {
  emit('update:modelValue', id)
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
      class="inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-control)] border bg-surface px-4 text-base font-medium text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      :class="open ? 'border-primary' : 'border-border hover:border-border-strong'"
      @click.stop="toggle"
    >
      <span class="truncate max-w-[140px]">{{ selectedModel?.displayName || '选择模型' }}</span>
      <ChevronDown class="h-4 w-4 text-muted-foreground shrink-0" :class="open && 'rotate-180'" />
    </button>

    <div
      v-if="open"
      class="absolute left-0 top-full z-[70] mt-1.5 w-72 rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-md"
    >
      <div class="px-3 pb-2 text-xs font-medium text-muted-foreground">选择模型</div>
      <div class="max-h-64 overflow-auto flex flex-col gap-1">
        <button
          v-for="model in models"
          :key="model.id"
          type="button"
          class="flex w-full items-center rounded-[var(--radius-control)] px-3 py-2 text-left transition-colors hover:bg-surface-subtle"
          :class="model.id === modelValue ? 'bg-primary-soft text-primary' : 'text-foreground'"
          @click="select(model.id)"
        >
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">{{ model.displayName }}</p>
          </div>
        </button>
      </div>
    </div>
  </div>
</template>
