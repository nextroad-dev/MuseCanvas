<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import type { ModelConfig } from '@/shared/types'

import { useClickOutside } from '@/shared/composables/useClickOutside'

const props = defineProps<{
  models: ModelConfig[]
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const open = ref(false)
const containerRef = ref<HTMLElement>()

const selectedModel = computed(() => props.models.find(m => m.id === props.modelValue))

function toggle() {
  open.value = !open.value
}

function select(id: string) {
  emit('update:modelValue', id)
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
      <span class="truncate max-w-[120px]">{{ selectedModel?.displayName || '选择模型' }}</span>
      <ChevronDown class="h-3.5 w-3.5 text-muted-foreground shrink-0" :class="open && 'rotate-180'" />
    </button>

    <div
      v-if="open"
      class="absolute left-0 top-full z-50 mt-1.5 w-72 rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-md"
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
