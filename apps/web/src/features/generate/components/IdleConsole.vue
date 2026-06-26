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
  <div class="flex w-full flex-col items-center px-4 py-8">
    <!-- Prompt input -->
    <div class="relative z-20 flex w-full max-w-3xl flex-col overflow-visible rounded-[var(--radius-panel)] border border-border bg-surface/95 shadow-sm backdrop-blur-sm transition-shadow focus-within:border-primary focus-within:ring-1 focus-within:ring-primary-soft">
        <textarea
          v-model="store.prompt"
          rows="5"
          :disabled="isSubmitting"
          placeholder="继续描述下一张画面..."
          class="w-full resize-none border-0 bg-transparent px-5 py-4 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
          @keydown="(e) => { if (e.key === 'Enter' && e.ctrlKey && !isSubmitting) { e.preventDefault(); handleGenerate() } }"
        />

        <!-- Bottom toolbar -->
        <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-transparent px-3 py-3">
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

          <div class="flex flex-wrap items-center justify-end gap-2">
            <div v-if="props.generating && activeJob" class="flex min-h-9 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3">
            <span class="h-1.5 w-1.5 rounded-full bg-primary" />
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

          <button
            :disabled="store.loading || !canGenerate"
            class="inline-flex h-9 items-center justify-center rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle disabled:opacity-50 disabled:cursor-not-allowed"
            :class="canGenerate && !store.loading ? 'border-primary bg-primary-soft text-primary hover:bg-primary-soft-hover' : ''"
            @click="handleGenerate"
          >
            {{ generateLabel }}
          </button>
          </div>
        </div>
      </div>
  </div>
</template>
