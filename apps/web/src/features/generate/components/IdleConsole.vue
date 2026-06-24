<script setup lang="ts">
import { computed } from 'vue'
import { Sparkles } from 'lucide-vue-next'
import { useGenerationStore } from '@/features/generate/stores/generation'
import ModelSelectPopover from './ModelSelectPopover.vue'
import SizeSelectPopover from './SizeSelectPopover.vue'
import QualitySelectPopover from './QualitySelectPopover.vue'
import CountSelectPopover from './CountSelectPopover.vue'

const store = useGenerationStore()
const emit = defineEmits<{
  generate: []
}>()

const canGenerate = computed(() =>
  store.prompt.trim().length > 0 &&
  store.selectedModelId !== '' &&
  store.selectedSize !== ''
)

function handleGenerate() {
  if (!canGenerate.value) return
  emit('generate')
}
</script>

<template>
  <div class="flex w-full flex-col items-center px-4 py-8">
    <!-- Prompt input -->
    <div class="flex w-full max-w-2xl flex-col rounded-[var(--radius-panel)] border border-border bg-surface shadow-sm transition-shadow focus-within:border-primary focus-within:ring-1 focus-within:ring-primary-soft">
      <textarea
        v-model="store.prompt"
        rows="5"
        placeholder="描述你想要生成的画面..."
        class="w-full resize-none border-0 bg-transparent px-5 py-4 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0"
        @keydown="(e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); handleGenerate() } }"
      />

      <!-- Bottom toolbar -->
      <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-transparent px-3 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <ModelSelectPopover
            v-model="store.selectedModelId"
            :models="store.models"
          />
          <SizeSelectPopover
            v-model="store.selectedSize"
            :sizes="store.availableSizes"
          />
          <QualitySelectPopover
            v-if="store.availableQualities.length > 0"
            v-model="store.selectedQuality"
            :options="store.availableQualities"
          />
          <CountSelectPopover
            v-model="store.count"
            :max="store.maxCount"
          />
        </div>
        <button
          :disabled="store.loading || !canGenerate"
          class="inline-flex h-9 items-center justify-center rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle disabled:opacity-50 disabled:cursor-not-allowed"
          :class="canGenerate && !store.loading ? 'border-primary bg-primary-soft text-primary hover:bg-primary-soft-hover' : ''"
          @click="handleGenerate"
        >
          <Sparkles class="h-4 w-4 mr-1.5" />
          {{ store.loading ? '生成中...' : '生成' }}
        </button>
      </div>
    </div>
  </div>
</template>
