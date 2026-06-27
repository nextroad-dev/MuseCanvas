<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { cn } from '@/shared/lib/utils'
import type { Quality } from '@/shared/types'
import { resolutionOptionsForRatio, resolveSizeForResolution, selectedRatio, selectedResolution } from '@/features/generate/lib/size-display'

import { useClickOutside } from '@/shared/composables/useClickOutside'

const props = defineProps<{
  modelValue: Quality
  options: Quality[]
  size: string
  sizes: string[]
  open: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: Quality]
  'update:size': [value: string]
  'update:open': [value: boolean]
}>()

const labels: Record<Quality, string> = {
  auto: '自动',
  low: '低',
  medium: '中',
  high: '高',
}

const containerRef = ref<HTMLElement>()

const selectedLabel = computed(() => labels[props.modelValue] ?? '质量')
const currentRatio = computed(() => selectedRatio(props.size))
const currentResolution = computed(() => selectedResolution(props.size))
const resolutionOptions = computed(() => resolutionOptionsForRatio(props.sizes, currentRatio.value))
const hasQualityOptions = computed(() => props.options.length > 0)
const hasResolutionOptions = computed(() => resolutionOptions.value.length > 0)

function toggle() {
  if (props.disabled) return
  emit('update:open', !props.open)
}

function select(q: Quality) {
  emit('update:modelValue', q)
  emit('update:open', false)
}

function selectResolution(resolution: string) {
  emit('update:size', resolveSizeForResolution(props.sizes, currentRatio.value, resolution, props.size))
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
      <span class="truncate">
        {{ [hasQualityOptions ? selectedLabel : '', currentResolution].filter(Boolean).join(' ') || '质量' }}
      </span>
      <ChevronDown class="h-4 w-4 text-muted-foreground shrink-0" :class="open && 'rotate-180'" />
    </button>

    <div
      v-if="open"
      class="absolute left-0 top-full z-[70] mt-1.5 w-52 rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-md"
    >
      <div v-if="hasResolutionOptions">
        <div class="mb-2 px-1 text-xs font-medium text-muted-foreground">分辨率</div>
        <div class="grid grid-cols-2 gap-1.5">
          <button
            v-for="resolution in resolutionOptions"
            :key="resolution.value"
            type="button"
            :class="cn(
              'flex items-center justify-center rounded-[var(--radius-control)] border py-1.5 text-sm font-medium transition-colors',
              resolution.value === currentResolution
                ? 'border-primary bg-primary-soft text-primary'
                : 'border-border bg-transparent text-foreground hover:bg-surface-subtle'
            )"
            @click="selectResolution(resolution.value)"
          >
            {{ resolution.label }}
          </button>
        </div>
      </div>

      <div v-if="hasQualityOptions" :class="hasResolutionOptions ? 'mt-3 border-t border-border pt-2' : ''">
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

      <div v-if="!hasResolutionOptions && !hasQualityOptions" class="px-2 py-1 text-xs text-muted-foreground">
        当前模型无可选质量参数
      </div>
    </div>
  </div>
</template>
