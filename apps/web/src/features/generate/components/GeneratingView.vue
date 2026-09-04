<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { AlertCircle, Check, XCircle, Image as ImageIcon } from 'lucide-vue-next'
import { useGenerationStore } from '@/features/generate/stores/generation'
import { canCancelJob, phaseLabel } from '@/shared/lib/job'
import Lightbox from '@/shared/components/ui/Lightbox.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'

const store = useGenerationStore()
const emit = defineEmits<{
  cancel: []
}>()

const job = computed(() => store.selectedJob)
const promptText = computed(() => {
  if (!job.value) return ''
  return job.value.inputPrompt || job.value.prompt || ''
})

const now = ref(Date.now())
const runStart = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null



const status = computed(() => job.value?.status || 'queued')
const phase = computed(() => job.value?.phase || null)
const isFailed = computed(() => ['failed', 'generation_failed', 'optimization_failed', 'template_failed'].includes(status.value) || !!phase.value?.endsWith('_failed'))
const isCanceled = computed(() => status.value === 'canceled')
const isComplete = computed(() => status.value === 'succeeded')
const isQueued = computed(() => status.value === 'queued' || phase.value === 'queued')
const isRetryWait = computed(() => status.value === 'retry_wait' || phase.value === 'retry_wait')
const canCancel = computed(() => canCancelJob(job.value?.status))
const isTerminal = computed(() => isFailed.value || isCanceled.value || isComplete.value)

const lightboxOpen = ref(false)
const lightboxIndex = ref(0)
const lightboxImages = computed(() =>
  (job.value?.inputImages || []).map((img, idx) => ({
    url: img.imageUrl,
    prompt: `参考图 ${idx + 1}`,
    alt: `参考图 ${idx + 1}`,
  }))
)

function previewInputImage(idx: number) {
  lightboxIndex.value = idx
  lightboxOpen.value = true
}

const isVideoJob = computed(() =>
  job.value?.mediaKind === 'video'
  || job.value?.modelKind === 'video'
  || (job.value?.outputs || []).some((o) => o.mediaKind === 'video'),
)

const currentStep = computed(() => {
  if (isComplete.value) return 4
  if (['asset_persisting', 'artifact_importing', 'completed'].includes(phase.value || '')) return 3
  if (['image_generating', 'provider_waiting', 'provider_submitting'].includes(phase.value || '')) return 2
  if (['prompt_optimizing', 'prompt_ready', 'preprocessing'].includes(phase.value || '')) return 1
  return 0
})

// Progress percentage 0–100: prefer server-reported progress when available.
const progressPercent = computed(() => {
  if (isComplete.value) return 100
  if (isFailed.value || isCanceled.value) return currentStep.value * 25
  const serverProgress = job.value?.progress
  if (typeof serverProgress === 'number' && Number.isFinite(serverProgress)) {
    return Math.min(99, Math.max(0, Math.round(serverProgress)))
  }
  return currentStep.value * 25 + (isTerminal.value ? 0 : 8)
})



const statusText = computed(() => {
  if (isFailed.value) return '生成失败'
  if (isCanceled.value) return '任务已取消'
  if (isComplete.value) return '生成完成'
  if (isRetryWait.value) return phaseLabel('retry_wait')
  if (isQueued.value) return phaseLabel('queued')
  return phaseLabel(phase.value)
})

const statusHint = computed(() => {
  if (isFailed.value) return '可以修改提示词后重新创建任务'
  if (isCanceled.value) return '任务已停止'
  if (isComplete.value) return '结果已准备好，正在加载...'
  if (phase.value === 'prompt_optimizing') return '正在把描述整理成更适合模型理解的表达'
  if (phase.value === 'provider_submitting') return isVideoJob.value ? '正在向视频供应商提交任务' : '正在向供应商提交任务'
  if (phase.value === 'provider_waiting') return isVideoJob.value ? '视频正在生成中，通常需要几分钟' : '模型正在生成，请耐心等待'
  if (phase.value === 'artifact_importing') return isVideoJob.value ? '视频已生成，正在安全导入' : '媒体已生成，正在安全导入'
  if (phase.value === 'image_generating') return isVideoJob.value ? '模型正在根据提示词生成视频' : '模型正在根据提示词绘制画面'
  if (phase.value === 'asset_persisting') return isVideoJob.value ? '视频正在写入图库和历史记录' : '图片正在写入图库和历史记录'
  return '输入台保持可用，可以继续添加任务'
})

const elapsedLabel = computed(() => {
  const endAt = job.value?.completedAt ? new Date(job.value.completedAt).getTime() : now.value
  const seconds = Math.max(0, Math.floor((endAt - runStart.value) / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
})




function stopTimer() {
  if (timer) { clearInterval(timer); timer = null }
}

watch(isTerminal, (terminal) => {
  if (terminal) { now.value = Date.now(); stopTimer() }
})

onMounted(() => {
  if (isTerminal.value) return
  timer = setInterval(() => { now.value = Date.now() }, 1000)
})

onUnmounted(() => stopTimer())
</script>

<template>
  <div v-if="job" class="w-full max-w-3xl">
    <div class="overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface/95 p-6 shadow-md backdrop-blur-sm md:p-8">
      
      <!-- Header: Title & Timer & Cancel -->
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-4">
          <div
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition-all duration-300"
            :class="{
              'bg-danger-soft text-danger': isFailed,
              'bg-neutral-soft text-neutral-status': isCanceled,
              'bg-success-soft text-success': isComplete,
              'bg-primary-soft text-primary': !isFailed && !isCanceled && !isComplete,
            }"
          >
            <AlertCircle v-if="isFailed" class="h-6 w-6" />
            <XCircle v-else-if="isCanceled" class="h-6 w-6" />
            <Check v-else-if="isComplete" class="h-6 w-6" />
            <svg v-else class="h-6 w-6 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
              <path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
          <div>
            <h2 class="flex items-center gap-2 text-lg font-semibold text-foreground transition-all duration-300" aria-live="polite">
              {{ statusText }}
              <span v-if="isVideoJob" class="rounded bg-primary-soft px-1.5 py-0.5 text-[11px] font-semibold text-primary">视频 · {{ progressPercent }}%</span>
            </h2>
            <p class="mt-1 text-xs text-muted-foreground">{{ statusHint }} · {{ elapsedLabel }}</p>
        </div>
          </div>
        <BaseButton
          v-if="canCancel"
          variant="secondary"
          size="sm"
          @click="emit('cancel')"
        >
          <XCircle class="h-3.5 w-3.5" />
          取消任务
        </BaseButton>
      </div>

      <!-- Linear Progress Bar -->
      <div class="mt-6 h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle border border-border/40">
        <div 
          class="h-full transition-all duration-700 ease-out"
          :class="{
            'bg-danger': isFailed,
            'bg-neutral-status': isCanceled,
            'bg-success': isComplete,
            'bg-primary': !isFailed && !isCanceled && !isComplete,
            'w-full': isTerminal
          }"
          :style="isTerminal ? {} : { width: `${progressPercent}%` }"
        />
      </div>

      <!-- Prompt Preview -->
      <div
        v-if="promptText"
        class="mt-5 rounded-[var(--radius-card)] border border-border/60 bg-surface-subtle px-4 py-3"
      >
        <p class="line-clamp-2 text-sm leading-relaxed text-foreground/80">
          "{{ promptText }}"
        </p>
      </div>

      <!-- Reference Images Preview -->
      <div
        v-if="job.inputImages && job.inputImages.length > 0"
        class="mt-4 rounded-[var(--radius-card)] border border-border/60 bg-surface-subtle px-4 py-3"
      >
        <div class="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground">
          <div class="flex items-center gap-1.5">
            <ImageIcon class="h-3.5 w-3.5 text-primary" />
            <span>参考图 ({{ job.inputImages.length }})</span>
          </div>
          <span class="text-[11px] text-muted-foreground/80">点击预览大图</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            v-for="(img, idx) in job.inputImages"
            :key="img.id || idx"
            type="button"
            class="group relative h-14 w-14 overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface shadow-xs transition-all hover:border-primary hover:shadow-sm"
            :aria-label="`查看参考图 ${idx + 1}`"
            @click="previewInputImage(idx)"
          >
            <img
              :src="img.imageUrl"
              :alt="`参考图 ${idx + 1}`"
              class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
              loading="lazy"
            />
            <span
              class="pointer-events-none absolute left-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/60 text-[9px] font-medium text-white"
            >
              {{ idx + 1 }}
            </span>
          </button>
        </div>
      </div>
    </div>
    <Lightbox
      :images="lightboxImages"
      v-model:open="lightboxOpen"
      v-model="lightboxIndex"
    />
  </div>
</template>

