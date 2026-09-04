<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/shared/lib/utils'
import SelectPopover from '@/shared/components/ui/SelectPopover.vue'

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

const options = computed(() => {
  const max = Math.max(1, props.max)
  return Array.from({ length: max }, (_, i) => i + 1)
})

function select(value: number) {
  emit('update:modelValue', value)
  emit('update:open', false)
}
</script>

<template>
  <SelectPopover
    :open="open"
    :disabled="disabled"
    panel-class="left-0 top-full z-popover mt-1.5 w-32 p-2"
    @update:open="emit('update:open', $event)"
  >
    <template #trigger-label>{{ modelValue }}</template>
    <template #default>
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
    </template>
  </SelectPopover>
</template>
