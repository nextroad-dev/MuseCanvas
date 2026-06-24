<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { cn } from '@/shared/lib/utils'

import { useClickOutside } from '@/shared/composables/useClickOutside'

const props = defineProps<{
  modelValue: string
  sizes: string[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const open = ref(false)
const containerRef = ref<HTMLElement>()

const ratioDescs: Record<string, string> = {
  '1:1': '正方形',
  '4:3': '常规横图',
  '3:4': '常规竖图',
  '16:9': '横屏封面 / PPT',
  '9:16': '手机壁纸 / 竖屏海报',
  '3:2': '摄影横图',
  '2:3': '摄影竖图',
}

const tierDescs: Record<string, string> = {
  '1K': '高清',
  '2K': '2K 高清',
  '3K': '3K 超清',
  '4K': '4K 超清',
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

function sizeOption(size: string): { value: string; label: string; desc: string } {
  const m = size.match(/^(\d+)x(\d+)$/)
  if (m) {
    const w = parseInt(m[1])
    const h = parseInt(m[2])
    const g = gcd(w, h)
    const ratio = `${w / g}:${h / g}`
    return { value: size, label: `${w}×${h}`, desc: ratioDescs[ratio] ? `${ratio} · ${ratioDescs[ratio]}` : ratio }
  }
  return { value: size, label: size, desc: tierDescs[size] || '分辨率' }
}

const options = computed(() => props.sizes.map(sizeOption))

const selected = computed(() => options.value.find((o) => o.value === props.modelValue))

function toggle() {
  open.value = !open.value
}

function select(value: string) {
  emit('update:modelValue', value)
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
      <span class="truncate">{{ selected?.label || '选择尺寸' }}</span>
      <ChevronDown class="h-3.5 w-3.5 text-muted-foreground shrink-0" :class="open && 'rotate-180'" />
    </button>

    <div
      v-if="open"
      class="absolute left-0 top-full z-50 mt-1.5 w-64 rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-md"
    >
      <div class="mb-2 px-1 text-xs font-medium text-muted-foreground">选择尺寸</div>
      <div class="grid grid-cols-3 gap-2">
        <button
          v-for="opt in options"
          :key="opt.value"
          type="button"
          :class="cn(
            'flex flex-col items-center justify-center rounded-[var(--radius-control)] border px-2 py-2 text-center transition-colors',
            opt.value === modelValue
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
