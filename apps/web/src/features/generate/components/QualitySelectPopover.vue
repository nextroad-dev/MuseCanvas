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
    panel-class="left-0 top-full z-popover mt-1.5 w-52 p-2"
    @update:open="emit('update:open', $event)"
  >
    <template #trigger-label>{{ [hasQualityOptions ? selectedLabel : '', currentResolution].filter(Boolean).join(' ') || '质量' }}</template>
    <template #default>
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
    </template>
  </SelectPopover>
</template>
