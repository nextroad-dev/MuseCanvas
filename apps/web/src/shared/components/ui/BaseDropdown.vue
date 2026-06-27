<script setup lang="ts" generic="T extends string">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { useAttrs } from 'vue'

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
const containerRef = ref<HTMLDivElement | null>(null)
const activeIndex = ref(-1)
const attrs = useAttrs()

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

function toggle() {
  if (props.disabled) return
  open.value = !open.value
  if (open.value) {
    activeIndex.value = Math.max(selectedIndex.value, 0)
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (props.disabled) return

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (!open.value) {
      open.value = true
      activeIndex.value = Math.max(selectedIndex.value, 0)
    } else if (activeIndex.value >= 0) {
      select(props.options[activeIndex.value].value)
    }
    return
  }

  if (event.key === 'Escape') {
    open.value = false
    return
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (!open.value) {
      open.value = true
      activeIndex.value = Math.max(selectedIndex.value, 0)
    } else {
      activeIndex.value = Math.min(activeIndex.value + 1, props.options.length - 1)
    }
    return
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!open.value) {
      open.value = true
      activeIndex.value = Math.max(selectedIndex.value, 0)
    } else {
      activeIndex.value = Math.max(activeIndex.value - 1, 0)
    }
    return
  }
}

function handleClickOutside(event: MouseEvent) {
  if (containerRef.value && !containerRef.value.contains(event.target as Node)) {
    open.value = false
  }
}

watch(() => open.value, (isOpen) => {
  if (isOpen) {
    activeIndex.value = Math.max(selectedIndex.value, 0)
  }
})

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div ref="containerRef" class="relative" :class="variant === 'default' ? 'w-full' : ''">
    <!-- Default variant: full-width form dropdown -->
    <template v-if="variant === 'default'">
      <button
        v-bind="attrs"
        type="button"
        :disabled="disabled"
        class="h-10 w-full appearance-none rounded-[var(--radius-control)] border border-border bg-surface px-3 pr-9 text-left text-sm text-foreground transition-colors hover:border-border-strong hover:bg-surface-subtle focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
        @click.stop="toggle"
        @keydown="handleKeydown"
      >
        <span :class="modelValue ? 'text-foreground' : 'text-muted-foreground'">{{ selectedLabel }}</span>
      </button>
      <ChevronDown
        class="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-transform duration-200"
        :class="{ 'rotate-180': open }"
      />
    </template>

    <!-- Toolbar variant: compact, borderless -->
    <template v-else>
      <button
        v-bind="attrs"
        type="button"
        :disabled="disabled"
        class="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-transparent px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-50"
        @click.stop="toggle"
        @keydown="handleKeydown"
      >
        <span>{{ selectedLabel }}</span>
        <ChevronDown
          class="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200"
          :class="{ 'rotate-180': open }"
        />
      </button>
    </template>

    <Transition
      enter-active-class="transition ease-out duration-100"
      enter-from-class="transform opacity-0 scale-95 -translate-y-1"
      enter-to-class="transform opacity-100 scale-100 translate-y-0"
      leave-active-class="transition ease-in duration-75"
      leave-from-class="transform opacity-100 scale-100 translate-y-0"
      leave-to-class="transform opacity-0 scale-95 -translate-y-1"
    >
      <ul
        v-show="open"
        role="listbox"
        class="absolute right-0 z-50 mt-1 min-w-[120px] overflow-auto rounded-[var(--radius-card)] border border-border bg-surface p-1 text-sm shadow-md"
        :class="variant === 'default' ? 'left-0 max-h-96 w-full' : 'max-h-64'"
      >
        <li
          v-for="(option, index) in options"
          :key="option.value"
          role="option"
          :aria-selected="option.value === modelValue"
          :class="[
            'flex w-full cursor-pointer items-center rounded-[var(--radius-control)] px-2 py-1.5 text-left transition-colors',
            option.value === modelValue
              ? 'bg-primary-soft font-medium text-primary'
              : 'text-foreground hover:bg-surface-subtle',
            index === activeIndex && option.value !== modelValue ? 'bg-surface-subtle' : '',
          ]"
          @click="select(option.value)"
        >
          {{ option.label }}
        </li>
      </ul>
    </Transition>
  </div>
</template>
