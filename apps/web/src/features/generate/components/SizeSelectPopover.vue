<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/shared/lib/utils'
import { ratioOptions, resolveSizeForRatio, selectedRatio } from '@/features/generate/lib/size-display'
import SelectPopover from '@/shared/components/ui/SelectPopover.vue'

const props = defineProps<{
  modelValue: string
  sizes: string[]
  open: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:open': [value: boolean]
}>()

const options = computed(() => ratioOptions(props.sizes))

const selectedRatioValue = computed(() => selectedRatio(props.modelValue))
const selected = computed(() => options.value.find((o) => o.value === selectedRatioValue.value))

function select(ratio: string) {
  emit('update:modelValue', resolveSizeForRatio(props.sizes, ratio, props.modelValue))
  emit('update:open', false)
}
</script>

<template>
  <SelectPopover
    :open="open"
    :disabled="disabled"
    popup-label="选择尺寸比例"
    panel-class="w-64"
    @update:open="emit('update:open', $event)"
  >
    <template #trigger-label>{{ selected?.label || '比例' }}</template>
    <template #default>
      <div class="mb-2 px-1 text-xs font-medium text-muted-foreground">选择尺寸</div>
      <div class="grid grid-cols-3 gap-2" role="listbox" aria-label="选择尺寸比例">
        <button
          v-for="opt in options"
          :key="opt.value"
          type="button"
          role="option"
          data-menu-item
          tabindex="-1"
          :aria-selected="opt.value === selectedRatioValue"
          :aria-label="opt.label"
          :class="cn(
            'flex min-h-10 items-center justify-center rounded-[var(--radius-control)] border transition-colors',
            opt.value === selectedRatioValue
              ? 'border-accent bg-accent-soft text-accent-strong'
              : 'border-border-control bg-transparent text-foreground hover:bg-surface-subtle'
          )"
          @click="select(opt.value)"
        >
          <div :class="[
            'border-2 border-current opacity-80',
            opt.label === '1:1' ? 'w-4 h-4' :
            opt.label === '4:3' || opt.label === '3:2' ? 'w-5 h-3.5' :
            opt.label === '3:4' || opt.label === '2:3' ? 'w-3.5 h-5' :
            opt.label === '16:9' ? 'w-6 h-3.5' :
            opt.label === '9:16' ? 'w-3.5 h-6' : 'w-4 h-4'
          ]" />
        </button>
      </div>
    </template>
  </SelectPopover>
</template>
