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

const props = defineProps<{
  modelValue: T
  options: DropdownOption<T>[]
  disabled?: boolean
  placeholder?: string
}>()

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
  props.options.findIndex(o => o.value === props.modelValue)
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
  <div ref="containerRef" class="relative w-full">
    <button
      v-bind="attrs"
      type="button"
      :disabled="disabled"
      class="h-10 w-full appearance-none rounded-lg border border-neutral-200 bg-white px-3 pr-9 text-left text-sm text-neutral-900 transition-colors hover:border-neutral-300 hover:bg-neutral-50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400 disabled:opacity-70"
      @click.stop="toggle"
      @keydown="handleKeydown"
    >
      <span :class="modelValue ? 'text-neutral-900' : 'text-neutral-400'">{{ selectedLabel }}</span>
    </button>
    <ChevronDown
      class="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400 transition-transform duration-200"
      :class="{ 'rotate-180': open }"
    />

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
        class="absolute z-50 mt-1 max-h-96 w-full overflow-auto rounded-lg border border-neutral-200 bg-white py-1 text-sm shadow-lg"
      >
        <li
          v-for="(option, index) in options"
          :key="option.value"
          :class="[
            'cursor-pointer px-3 py-2 transition-colors',
            option.value === modelValue
              ? 'bg-primary-soft text-primary font-medium'
              : 'text-neutral-700 hover:bg-neutral-50',
            index === activeIndex && option.value !== modelValue ? 'bg-neutral-50' : '',
          ]"
          @click="select(option.value)"
        >
          {{ option.label }}
        </li>
      </ul>
    </Transition>
  </div>
</template>
