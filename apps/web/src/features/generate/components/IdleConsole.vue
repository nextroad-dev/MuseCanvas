<script setup lang="ts">
import { computed, ref } from 'vue'
import { XCircle, Coins } from 'lucide-vue-next'
import { canCancelJob, phaseLabel } from '@/shared/lib/job'
import { useGenerationStore } from '@/features/generate/stores/generation'
import ModelSelectPopover from './ModelSelectPopover.vue'
import SizeSelectPopover from './SizeSelectPopover.vue'
import QualitySelectPopover from './QualitySelectPopover.vue'
import ReferenceImageUploader from './ReferenceImageUploader.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
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
  (store.isVideo || store.selectedSize !== '') &&
  store.canSubmitWithImages &&
  store.hasSufficientCredits
)
const generateLabel = computed(() => {
  if (store.loading) return '创建中...'
  if (store.isBillingEnabled && !store.hasSufficientCredits) return '余额不足'
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
        {{ store.isVideo ? '描述你想生成的视频' : '描述你想创作的画面' }}
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

        <!-- Reference image uploader (shown when model supports input images or images are staged) -->
        <ReferenceImageUploader
          v-if="store.isModelSupportingImages || store.stagedImages.length > 0"
          :disabled="isSubmitting"
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
              v-if="!store.isVideo"
              v-model="store.selectedSize"
              :open="activePopover === 'size'"
              :sizes="store.availableSizes"
              :disabled="isSubmitting"
              @update:open="setPopover('size', $event)"
            />
            <QualitySelectPopover
              v-if="!store.isVideo && (store.availableQualities.length > 0 || store.availableSizes.length > 0)"
              v-model="store.selectedQuality"
              v-model:size="store.selectedSize"
              :open="activePopover === 'quality'"
              :options="store.availableQualities"
              :sizes="store.availableSizes"
              :disabled="isSubmitting"
              @update:open="setPopover('quality', $event)"
            />
            <!-- Video mode: duration / aspect ratio / resolution / audio -->
            <template v-if="store.isVideo">
              <div class="flex items-center gap-1" role="group" aria-label="视频时长">
                <button
                  v-for="d in store.videoDurations"
                  :key="d"
                  type="button"
                  :disabled="isSubmitting"
                  class="inline-flex h-10 items-center rounded-[var(--radius-control)] border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  :class="store.videoDuration === d ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-foreground hover:border-border-strong'"
                  @click="store.videoDuration = d"
                >{{ d }}s</button>
              </div>
              <div class="flex items-center gap-1" role="group" aria-label="画面比例">
                <button
                  v-for="ratio in store.videoAspectRatios"
                  :key="ratio"
                  type="button"
                  :disabled="isSubmitting"
                  class="inline-flex h-10 items-center rounded-[var(--radius-control)] border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  :class="store.videoAspectRatio === ratio ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-foreground hover:border-border-strong'"
                  @click="store.videoAspectRatio = ratio"
                >{{ ratio }}</button>
              </div>
              <div v-if="store.videoResolutions.length > 0" class="flex items-center gap-1" role="group" aria-label="分辨率">
                <button
                  v-for="res in store.videoResolutions"
                  :key="res"
                  type="button"
                  :disabled="isSubmitting"
                  class="inline-flex h-10 items-center rounded-[var(--radius-control)] border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  :class="store.videoResolution === res ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-foreground hover:border-border-strong'"
                  @click="store.videoResolution = res"
                >{{ res }}</button>
              </div>
              <button
                type="button"
                :disabled="isSubmitting"
                role="switch"
                :aria-checked="store.videoAudio"
                title="是否生成音频"
                class="inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-control)] border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                :class="store.videoAudio ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-muted-foreground hover:border-border-strong'"
                @click="store.videoAudio = !store.videoAudio"
              >{{ store.videoAudio ? '有声' : '静音' }}</button>
            </template>
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
            <!-- Submit blocked hint if reference images have validation issues -->
            <span
              v-if="store.stagedImagesValidationError"
              class="text-xs text-danger font-medium text-right max-w-xs"
              role="alert"
            >
              {{ store.stagedImagesValidationError }}
            </span>

            <!-- Active job status pill -->
            <div
              v-if="props.generating && activeJob"
              class="flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface-subtle px-4"
            >
              <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              <span class="text-sm text-muted-foreground">{{ activeJobStatusText }}</span>
              <BaseButton
                v-if="canCancelActiveJob"
                variant="ghost"
                size="sm"
                @click="handleCancel"
              >
                <XCircle class="h-3.5 w-3.5" />
                取消
              </BaseButton>
            </div>

            <!-- Estimated credits indicator -->
            <div
              v-if="store.isBillingEnabled && store.selectedModel"
              class="flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1 text-xs font-medium"
              :class="!store.hasSufficientCredits
                ? 'border border-danger/40 bg-danger/10 text-danger'
                : 'border border-border/80 bg-surface-subtle text-muted-foreground'"
            >
              <Coins class="h-3.5 w-3.5" :class="!store.hasSufficientCredits ? 'text-danger' : 'text-warning'" />
              <span>预计 {{ store.estimatedCredits }} 积分</span>
            </div>

            <!-- Generate button with shimmer effect -->
            <BaseButton
              variant="primary"
              class="relative overflow-hidden px-6 text-base font-semibold active:scale-[0.97]"
              :disabled="!canGenerate || store.loading"
              :loading="store.loading"
              @click="handleGenerate"
            >
              <!-- Shimmer overlay (only on active state) -->
              <span
                v-if="canGenerate && !store.loading"
                class="shimmer-overlay pointer-events-none absolute inset-0"
                aria-hidden="true"
              />
              <span class="relative z-10">{{ generateLabel }}</span>
            </BaseButton>
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
