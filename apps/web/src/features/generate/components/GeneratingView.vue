<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { AlertCircle, Check, XCircle } from 'lucide-vue-next'
import { useGenerationStore } from '@/features/generate/stores/generation'
import { canCancelJob, phaseLabel } from '@/shared/lib/job'

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

const currentStep = computed(() => {
  if (isComplete.value) return 4
  if (['asset_persisting', 'completed'].includes(phase.value || '')) return 3
  if (phase.value === 'image_generating') return 2
  if (['prompt_optimizing', 'prompt_ready'].includes(phase.value || '')) return 1
  return 0
})

// Progress percentage 0–100
const progressPercent = computed(() => {
  if (isComplete.value) return 100
  if (isFailed.value || isCanceled.value) return currentStep.value * 25
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
  if (phase.value === 'image_generating') return '模型正在根据提示词绘制画面'
  if (phase.value === 'asset_persisting') return '图片正在写入图库和历史记录'
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
            <h2 class="text-lg font-semibold text-foreground transition-all duration-300" aria-live="polite">
              {{ statusText }}
            </h2>
            <div class="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              <span class="font-mono tabular-nums">{{ elapsedLabel }}</span>
              <span>·</span>
              <span>{{ statusHint }}</span>
            </div>
          </div>
        </div>
        
        <button
          v-if="canCancel"
          class="inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
          @click="emit('cancel')"
        >
          <XCircle class="h-3.5 w-3.5" />
          取消任务
        </button>
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
    </div>
  </div>
</template>

