<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { cn } from '@/shared/lib/utils'
import { ratioOptions, resolveSizeForRatio, selectedRatio } from '@/features/generate/lib/size-display'

import { useClickOutside } from '@/shared/composables/useClickOutside'

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

const containerRef = ref<HTMLElement>()

const options = computed(() => ratioOptions(props.sizes))

const selectedRatioValue = computed(() => selectedRatio(props.modelValue))
const selected = computed(() => options.value.find((o) => o.value === selectedRatioValue.value))

function toggle() {
  if (props.disabled) return
  emit('update:open', !props.open)
}

function select(ratio: string) {
  emit('update:modelValue', resolveSizeForRatio(props.sizes, ratio, props.modelValue))
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
      <span class="truncate">尺寸 · {{ selected?.label || '比例' }}</span>
      <ChevronDown class="h-3.5 w-3.5 text-muted-foreground shrink-0" :class="open && 'rotate-180'" />
    </button>

    <div
      v-if="open"
      class="absolute left-0 top-full z-[70] mt-1.5 w-64 rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-md"
    >
      <div class="mb-2 px-1 text-xs font-medium text-muted-foreground">选择尺寸</div>
      <div class="grid grid-cols-3 gap-2">
        <button
          v-for="opt in options"
          :key="opt.value"
          type="button"
          :class="cn(
            'flex flex-col items-center justify-center rounded-[var(--radius-control)] border px-2 py-2 text-center transition-colors',
            opt.value === selectedRatioValue
              ? 'border-primary bg-primary-soft text-primary'
              : 'border-border bg-transparent text-foreground hover:bg-surface-subtle'
          )"
          @click="select(opt.value)"
        >
          <span class="text-sm font-medium">{{ opt.label }}</span>
          <span class="mt-0.5 text-[10px] text-muted-foreground">{{ opt.desc }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
