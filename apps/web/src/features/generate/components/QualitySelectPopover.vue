<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/shared/lib/utils'
import type { Quality } from '@/shared/types'
import { resolutionOptionsForRatio, resolveSizeForResolution, selectedRatio, selectedResolution } from '@/features/generate/lib/size-display'
import SelectPopover from '@/shared/components/ui/SelectPopover.vue'

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

const selectedLabel = computed(() => labels[props.modelValue] ?? '质量')
const currentRatio = computed(() => selectedRatio(props.size))
const currentResolution = computed(() => selectedResolution(props.size))
const resolutionOptions = computed(() => resolutionOptionsForRatio(props.sizes, currentRatio.value))
const hasQualityOptions = computed(() => props.options.length > 0)
const hasResolutionOptions = computed(() => resolutionOptions.value.length > 0)

function select(q: Quality) {
  emit('update:modelValue', q)
  emit('update:open', false)
}

function selectResolution(resolution: string) {
  emit('update:size', resolveSizeForResolution(props.sizes, currentRatio.value, resolution, props.size))
  emit('update:open', false)
}
</script>

<template>
  <SelectPopover
    :open="open"
    :disabled="disabled"
    popup-label="选择质量与分辨率"
    panel-class="w-52"
    @update:open="emit('update:open', $event)"
  >
    <template #trigger-label>{{ [hasQualityOptions ? selectedLabel : '', currentResolution].filter(Boolean).join(' ') || '质量' }}</template>
    <template #default>
      <div v-if="hasResolutionOptions">
        <div class="mb-2 px-1 text-xs font-medium text-muted-foreground">分辨率</div>
        <div class="grid grid-cols-2 gap-1.5" role="listbox" aria-label="选择分辨率">
          <button
            v-for="resolution in resolutionOptions"
            :key="resolution.value"
            type="button"
            role="option"
            data-menu-item
            tabindex="-1"
            :aria-selected="resolution.value === currentResolution"
            :class="cn(
              'flex min-h-10 items-center justify-center rounded-[var(--radius-control)] border text-sm font-medium transition-colors tabular-nums',
              resolution.value === currentResolution
                ? 'border-accent bg-accent-soft text-accent-strong'
                : 'border-border-control bg-transparent text-foreground hover:bg-surface-subtle'
            )"
            @click="selectResolution(resolution.value)"
          >
            {{ resolution.label }}
          </button>
        </div>
      </div>

      <div v-if="hasQualityOptions" :class="hasResolutionOptions ? 'mt-3 border-t border-border pt-2' : ''">
        <div class="mb-2 px-1 text-xs font-medium text-muted-foreground">选择质量</div>
        <div class="flex flex-col gap-1" role="listbox" aria-label="选择质量">
          <button
            v-for="q in options"
            :key="q"
            type="button"
            role="option"
            data-menu-item
            tabindex="-1"
            :aria-selected="q === modelValue"
            :class="cn(
              'flex min-h-10 items-center rounded-[var(--radius-control)] px-3 text-left transition-colors',
              q === modelValue
                ? 'bg-accent-soft text-accent-strong'
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
    </template>
  </SelectPopover>
</template>
