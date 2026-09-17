<script setup lang="ts" generic="T extends string">
import { computed, ref, useId } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { useAttrs } from 'vue'
import Popover from './Popover.vue'
import { cn } from '@/shared/lib/utils'

export interface DropdownOption<TValue extends string = string> {
  value: TValue
  label: string
  disabled?: boolean
}

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  modelValue: T
  options: DropdownOption<T>[]
  disabled?: boolean
  placeholder?: string
  /** Accessible name of the option list, e.g. "状态". */
  label?: string
  /**
   * 'default'  - 标准尺寸，带完整边框（用于表单区域）
   * 'toolbar'  - 紧凑模式，无边框，用于工具栏中的控件
   */
  variant?: 'default' | 'toolbar'
}>(), {
  variant: 'default',
})

const emit = defineEmits<{
  'update:modelValue': [value: T]
}>()

const open = ref(false)
const activeIndex = ref(-1)
const attrs = useAttrs()
const listId = `dropdown-${useId()}`

const selectedLabel = computed(() => {
  const option = props.options.find(o => o.value === props.modelValue)
  return option?.label ?? props.placeholder ?? '请选择'
})

const selectedIndex = computed(() =>
  props.options.findIndex(o => o.value === props.modelValue),
)

function select(value: T) {
  emit('update:modelValue', value)
  open.value = false
}

function setOpen(value: boolean) {
  open.value = value
  if (value) activeIndex.value = Math.max(selectedIndex.value, 0)
}

const panelClass = computed(() =>
  props.variant === 'default'
    ? 'left-0 right-0 max-h-96 overflow-auto'
    : 'right-0 min-w-[140px] max-h-64 overflow-auto',
)
</script>

<template>
  <Popover
    :model-value="open"
    :disabled="disabled"
    :label="label || placeholder || '选项列表'"
    :panel-class="panelClass"
    @update:model-value="setOpen"
  >
    <template #trigger="{ open: isOpen, toggle }">
      <!-- Default variant: full-width form dropdown -->
      <button
        v-if="variant === 'default'"
        v-bind="attrs"
        type="button"
        :disabled="disabled"
        :id="listId"
        aria-haspopup="listbox"
        :aria-expanded="isOpen"
        class="relative flex min-h-10 w-full items-center rounded-[var(--radius-control)] border border-border-control bg-surface px-3 pr-9 text-left text-sm text-foreground transition-colors hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-50"
        :class="isOpen && 'bg-surface-subtle'"
        @click.stop="toggle"
      >
        <span class="truncate" :class="modelValue ? 'text-foreground' : 'text-muted-foreground'">
          {{ selectedLabel }}
        </span>
        <ChevronDown
          class="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-transform"
          :class="{ 'rotate-180': isOpen }"
          aria-hidden="true"
        />
      </button>

      <!-- Toolbar variant: compact, borderless -->
      <button
        v-else
        v-bind="attrs"
        type="button"
        :disabled="disabled"
        :id="listId"
        aria-haspopup="listbox"
        :aria-expanded="isOpen"
        class="inline-flex min-h-8 items-center gap-1 rounded-[var(--radius-control)] border border-transparent px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-50"
        :class="isOpen && 'bg-surface-subtle'"
        @click.stop="toggle"
      >
        <span>{{ selectedLabel }}</span>
        <ChevronDown
          class="h-3.5 w-3.5 text-muted-foreground transition-transform"
          :class="{ 'rotate-180': isOpen }"
          aria-hidden="true"
        />
      </button>
    </template>

    <ul role="presentation" class="flex flex-col gap-1">
      <li
        v-for="(option, index) in options"
        :key="option.value"
        role="option"
        data-menu-item
        :tabindex="-1"
        :aria-selected="option.value === modelValue"
        :aria-disabled="option.disabled ? 'true' : undefined"
        :class="cn(
          'flex w-full cursor-pointer items-center rounded-[var(--radius-control)] px-2 py-1.5 text-left text-sm transition-colors',
          option.value === modelValue
            ? 'bg-accent-soft font-medium text-accent-strong'
            : 'text-foreground hover:bg-surface-subtle',
          index === activeIndex && option.value !== modelValue ? 'bg-surface-subtle' : '',
          option.disabled && 'cursor-not-allowed opacity-50',
        )"
        @click="!option.disabled && select(option.value)"
      >
        {{ option.label }}
      </li>
    </ul>
  </Popover>
</template>