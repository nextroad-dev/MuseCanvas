<script setup lang="ts">
import { computed, ref } from 'vue'
import { XCircle } from 'lucide-vue-next'
import { useGenerationStore } from '@/features/generate/stores/generation'
import { canCancelJob, phaseLabel } from '@/shared/lib/job'
import ModelSelectPopover from './ModelSelectPopover.vue'
import SizeSelectPopover from './SizeSelectPopover.vue'
import QualitySelectPopover from './QualitySelectPopover.vue'
import CountSelectPopover from './CountSelectPopover.vue'

type ToolbarPopover = 'model' | 'size' | 'quality' | 'count'

const props = defineProps<{
  generating?: boolean
}>()

const emit = defineEmits<{
  generate: []
  cancel: []
}>()

const store = useGenerationStore()
const activePopover = ref<ToolbarPopover | null>(null)
const isFocused = ref(false)

const isSubmitting = computed(() => store.loading)
const activeJob = computed(() => store.selectedJob)
const canCancelActiveJob = computed(() => canCancelJob(activeJob.value?.status))

const canGenerate = computed(() =>
  store.prompt.trim().length > 0 &&
  store.selectedModelId !== '' &&
  store.selectedSize !== ''
)

const generateLabel = computed(() => {
  if (store.loading) return '创建中...'
  return props.generating ? '添加任务' : '生成'
})

const activeJobStatusText = computed(() => {
  if (!activeJob.value) return ''
  if (activeJob.value.status === 'queued') return phaseLabel('queued')
  if (activeJob.value.status === 'retry_wait') return phaseLabel('retry_wait')
  return phaseLabel(activeJob.value.phase)
})

function handleGenerate() {
  if (!canGenerate.value || isSubmitting.value) return
  emit('generate')
}

function handleCancel() {
  emit('cancel')
}

function setPopover(name: ToolbarPopover, open: boolean) {
  if (open) {
    activePopover.value = name
    return
  }
  if (activePopover.value === name) {
    activePopover.value = null
  }
}
</script>

<template>
  <div class="flex w-full flex-col items-center px-4 py-6">
    <!-- Heading above console -->
    <div class="mb-6 text-center">
      <h2 class="text-2xl font-semibold tracking-tight text-foreground">
        描述你想创作的画面
      </h2>
    </div>

    <!-- Console card -->
    <div
      class="relative z-20 flex w-full max-w-3xl flex-col overflow-visible"
      :class="isFocused || store.prompt.length > 0 ? 'console-focused' : ''"
    >
      <!-- Glow ring (decorative) -->
      <div
        class="pointer-events-none absolute -inset-px rounded-[calc(var(--radius-panel)+1px)] opacity-0 transition-opacity duration-500"
        :class="isFocused ? 'opacity-100' : ''"
        style="background: linear-gradient(135deg, var(--color-primary) 0%, transparent 50%, var(--color-primary-soft) 100%); -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask-composite: exclude; padding: 1px;"
        aria-hidden="true"
      />

      <!-- Main card -->
      <div
        class="relative flex flex-col overflow-visible rounded-[var(--radius-panel)] border bg-surface/95 shadow-md backdrop-blur-sm transition-all duration-300"
        :class="isFocused
          ? 'border-primary/50 shadow-[0_0_0_4px_var(--color-primary-soft),0_8px_32px_-4px_rgba(22,138,73,0.15)]'
          : 'border-border hover:border-border-strong hover:shadow-lg'"
      >
        <!-- Textarea -->
        <textarea
          v-model="store.prompt"
          rows="5"
          :disabled="isSubmitting"
          placeholder="描述画面内容、风格、光线、氛围..."
          class="w-full resize-none border-0 bg-transparent px-6 py-6 text-lg leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
          @focus="isFocused = true"
          @blur="isFocused = false"
          @keydown="(e) => { if (e.key === 'Enter' && e.ctrlKey && !isSubmitting) { e.preventDefault(); handleGenerate() } }"
        />

        <!-- Divider -->
        <div class="mx-4 h-px bg-border/60" />

        <!-- Bottom toolbar -->
        <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <!-- Parameter selectors -->
          <div class="flex flex-wrap items-center gap-2">
            <ModelSelectPopover
              v-model="store.selectedModelId"
              :open="activePopover === 'model'"
              :models="store.models"
              :disabled="isSubmitting"
              @update:open="setPopover('model', $event)"
            />
            <SizeSelectPopover
              v-model="store.selectedSize"
              :open="activePopover === 'size'"
              :sizes="store.availableSizes"
              :disabled="isSubmitting"
              @update:open="setPopover('size', $event)"
            />
            <QualitySelectPopover
              v-if="store.availableQualities.length > 0 || store.availableSizes.length > 0"
              v-model="store.selectedQuality"
              v-model:size="store.selectedSize"
              :open="activePopover === 'quality'"
              :options="store.availableQualities"
              :sizes="store.availableSizes"
              :disabled="isSubmitting"
              @update:open="setPopover('quality', $event)"
            />
            <CountSelectPopover
              v-model="store.count"
              :open="activePopover === 'count'"
              :max="store.maxCount"
              :disabled="isSubmitting"
              @update:open="setPopover('count', $event)"
            />
          </div>

          <!-- Right actions -->
          <div class="flex flex-wrap items-center justify-end gap-2">
            <!-- Active job status pill -->
            <div
              v-if="props.generating && activeJob"
              class="flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface-subtle px-4"
            >
              <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              <span class="text-sm text-muted-foreground">{{ activeJobStatusText }}</span>
              <button
                v-if="canCancelActiveJob"
                type="button"
                class="inline-flex h-7 items-center justify-center gap-1 rounded-[var(--radius-control)] px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
                @click="handleCancel"
              >
                <XCircle class="h-3.5 w-3.5" />
                取消
              </button>
            </div>

            <!-- Generate button with shimmer effect -->
            <button
              type="button"
              class="generate-btn relative flex h-10 items-center gap-2 overflow-hidden rounded-[var(--radius-control)] px-6 text-base font-semibold transition-all duration-200"
              :class="canGenerate && !store.loading
                ? 'bg-primary text-white shadow-sm hover:bg-primary-hover hover:shadow-md active:scale-[0.97]'
                : 'cursor-not-allowed bg-surface-subtle text-muted-foreground'"
              :disabled="!canGenerate || store.loading"
              @click="handleGenerate"
            >
              <!-- Shimmer overlay (only on active state) -->
              <span
                v-if="canGenerate && !store.loading"
                class="shimmer-overlay pointer-events-none absolute inset-0"
                aria-hidden="true"
              />
              <svg
                v-if="store.loading"
                class="relative z-10 h-4 w-4 shrink-0 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span class="relative z-10">{{ generateLabel }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Shimmer sweep animation on generate button */
.shimmer-overlay {
  background: linear-gradient(
    105deg,
    transparent 30%,
    rgba(255, 255, 255, 0.25) 50%,
    transparent 70%
  );
  background-size: 200% 100%;
  animation: shimmer 2.4s linear infinite;
}

@keyframes shimmer {
  0% { background-position: 200% center; }
  100% { background-position: -200% center; }
}
</style>
