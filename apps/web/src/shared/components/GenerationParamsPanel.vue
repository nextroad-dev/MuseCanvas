<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import PromptEditor from '@/shared/components/ui/PromptEditor.vue'
import ModelSelector from '@/shared/components/ui/ModelSelector.vue'
import { Sparkles } from 'lucide-vue-next'
import { useGenerationStore } from '@/features/generate/stores/generation'
import { cn } from '@/shared/lib/utils'
import type { Quality } from '@/shared/types'

const store = useGenerationStore()

const qualityOptions: { value: Quality; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]
const aspectRatios = [
  { label: '1:1', width: 1024, height: 1024 },
  { label: '4:3', width: 1280, height: 960 },
  { label: '3:4', width: 960, height: 1280 },
  { label: '16:9', width: 1280, height: 720 },
  { label: '9:16', width: 720, height: 1280 },
  { label: '3:2', width: 1536, height: 1024 },
  { label: '2:3', width: 1024, height: 1536 },
]
const countOptions = [1, 2, 3, 4]
const width = ref(1024)
const height = ref(1024)
const selectedRatio = computed(() => aspectRatios.find((ratio) => ratio.width === width.value && ratio.height === height.value)?.label || '')
const sizeValid = computed(() => Number.isInteger(width.value) && Number.isInteger(height.value) && width.value >= 256 && width.value <= 4096 && height.value >= 256 && height.value <= 4096)

watch([width, height], () => {
  if (sizeValid.value) store.selectedSize = `${width.value}x${height.value}`
}, { immediate: true })

function applyRatio(ratio: { width: number; height: number }) {
  width.value = ratio.width
  height.value = ratio.height
}

const emit = defineEmits<{
  generate: []
}>()
</script>

<template>
  <div class="space-y-5">
    <!-- Prompt -->
    <div>
      <label class="mb-2 block text-sm font-medium text-neutral-700">提示词</label>
      <PromptEditor
        v-model="store.prompt"
        :max-length="2000"
        auto-focus
        placeholder="描述你想要生成的图片..."
      />
    </div>

    <!-- Model -->
    <ModelSelector
      v-model="store.selectedModelId"
      :models="store.models"
    />

    <!-- Quality -->
    <div>
      <label class="mb-2 block text-sm font-medium text-neutral-700">质量</label>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="option in qualityOptions"
          :key="option.value"
          :class="
            cn(
              'h-9 rounded-lg border px-3 text-sm font-medium transition-colors',
              store.selectedQuality === option.value
                ? 'border-primary bg-primary text-white'
                : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50',
            )
          "
          @click="store.selectedQuality = option.value"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <!-- Aspect ratio -->
    <div>
      <label class="mb-2 block text-sm font-medium text-neutral-700">宽高比</label>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="ratio in aspectRatios"
          :key="ratio.label"
          :class="
            cn(
              'h-9 rounded-lg border px-3 text-sm font-medium transition-colors',
              selectedRatio === ratio.label
                ? 'border-primary bg-primary text-white'
                : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50',
            )
          "
          @click="applyRatio(ratio)"
        >
          {{ ratio.label }}
        </button>
      </div>
    </div>

    <!-- Size -->
    <div>
      <label class="mb-2 block text-sm font-medium text-neutral-700">尺寸</label>
      <div class="grid grid-cols-2 gap-3">
        <label class="text-xs font-medium text-neutral-500">
          宽
          <input
            v-model.number="width"
            type="number"
            min="256"
            max="4096"
            step="1"
            class="mt-1 h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </label>
        <label class="text-xs font-medium text-neutral-500">
          高
          <input
            v-model.number="height"
            type="number"
            min="256"
            max="4096"
            step="1"
            class="mt-1 h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </label>
      </div>
      <p v-if="!sizeValid" class="mt-1 text-xs text-danger">宽高需为 256 到 4096 之间的整数。</p>
    </div>

    <!-- Count -->
    <div>
      <label class="mb-2 block text-sm font-medium text-neutral-700">生成张数</label>
      <div class="grid grid-cols-4 gap-2">
        <button
          v-for="value in countOptions"
          :key="value"
          :class="
            cn(
              'h-9 rounded-lg border text-sm font-medium transition-colors',
              store.count === value
                ? 'border-primary bg-primary text-white'
                : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50',
            )
          "
          @click="store.count = value"
        >
          {{ value }} 张
        </button>
      </div>
    </div>

    <!-- Generate button -->
    <button
      :disabled="store.loading || !store.prompt.trim() || !store.selectedModelId || !store.selectedSize || !sizeValid"
      class="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary text-base font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      @click="emit('generate')"
    >
      <Sparkles class="h-4 w-4" />
      {{ store.loading ? '生成中...' : '生成' }}
    </button>
  </div>
</template>

<style scoped>
input[type='number']::-webkit-outer-spin-button,
input[type='number']::-webkit-inner-spin-button {
  margin: 0;
  appearance: none;
}

input[type='number'] {
  appearance: textfield;
}
</style>
