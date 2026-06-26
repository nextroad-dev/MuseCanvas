<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { AlertCircle, Check, Clock3, Loader2, Save, Sparkles, Wand2, XCircle } from 'lucide-vue-next'
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
// Mount-time run start: the component remounts on each manual retry, which
// restarts the timer. createdAt is preserved across retries by the backend,
// so it cannot be used as the start reference.
const runStart = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

const steps = [
  { key: 'prepare', label: '准备' },
  { key: 'optimize', label: '优化' },
  { key: 'generate', label: '生成' },
  { key: 'persist', label: '保存' },
]

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
  if (isCanceled.value) return '任务已停止，输入台可以继续创建新任务'
  if (isComplete.value) return '结果已准备好，仍可继续提交下一张'
  if (phase.value === 'prompt_optimizing') return '正在把描述整理成更适合模型理解的表达'
  if (phase.value === 'image_generating') return '模型正在根据提示词绘制画面'
  if (phase.value === 'asset_persisting') return '图片正在写入图库和历史记录'
  return '输入台保持可用，可以继续添加下一条生成任务'
})

const elapsedLabel = computed(() => {
  const endAt = job.value?.completedAt ? new Date(job.value.completedAt).getTime() : now.value
  const seconds = Math.max(0, Math.floor((endAt - runStart.value) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`
})

function stepState(index: number) {
  if (job.value?.optimizationMode === 'disabled' && index === 1) return 'skipped'
  if (isFailed.value || isCanceled.value) return index <= currentStep.value ? 'stopped' : 'idle'
  if (index < currentStep.value || isComplete.value) return 'done'
  if (index === currentStep.value) return 'current'
  return 'idle'
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

// Freeze the counter the moment the job reaches a terminal state so it stops
// on failure/cancel/success instead of ticking onward during the leave transition.
watch(isTerminal, (terminal) => {
  if (terminal) {
    now.value = Date.now()
    stopTimer()
  }
})

onMounted(() => {
  if (isTerminal.value) return
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  stopTimer()
})
</script>

<template>
  <div v-if="job" class="w-full max-w-3xl rounded-[var(--radius-panel)] border border-border bg-surface/95 p-5 shadow-sm backdrop-blur-sm">
    <div class="grid gap-5 md:grid-cols-[96px_1fr_auto] md:items-center">
      <div class="flex justify-center md:justify-start">
        <div class="relative flex h-20 w-20 items-center justify-center">
          <div class="absolute inset-0 rounded-full border border-primary/15" />
          <div
            v-if="!isFailed && !isCanceled && !isComplete"
            class="absolute inset-1 rounded-full border border-primary/20 motion-safe:animate-pulse motion-reduce:animate-none"
          />
          <div
            v-if="phase === 'prompt_optimizing'"
            class="absolute inset-2 rounded-full border-2 border-transparent border-r-primary/25 border-t-primary/70 motion-safe:animate-spin motion-safe:[animation-duration:2.4s] motion-reduce:animate-none"
          />
          <div
            v-if="phase === 'image_generating'"
            class="absolute inset-0 rounded-full bg-primary/10 motion-safe:animate-ping motion-reduce:animate-none"
          />
          <div
            v-if="isRetryWait"
            class="absolute inset-2 rounded-full border-2 border-warning/45"
          />
          <div
            class="relative flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface shadow-sm"
            :class="isFailed ? 'bg-danger-soft text-danger' : isCanceled ? 'bg-neutral-soft text-neutral-status' : isComplete ? 'bg-success-soft text-success' : 'bg-primary-soft text-primary'"
          >
            <AlertCircle v-if="isFailed" class="h-5 w-5" />
            <XCircle v-else-if="isCanceled" class="h-5 w-5" />
            <Check v-else-if="isComplete" class="h-5 w-5" />
            <Clock3 v-else-if="isQueued || isRetryWait" class="h-5 w-5" />
            <Wand2 v-else-if="phase === 'prompt_optimizing'" class="h-5 w-5" />
            <Sparkles v-else-if="phase === 'image_generating'" class="h-5 w-5" />
            <Save v-else-if="phase === 'asset_persisting'" class="h-5 w-5" />
            <Loader2 v-else class="h-5 w-5 motion-safe:animate-spin motion-reduce:animate-none" />
          </div>
          <div v-if="isQueued" class="absolute -bottom-1 flex gap-1">
            <span class="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-pulse motion-reduce:animate-none" />
            <span class="h-1.5 w-1.5 rounded-full bg-primary/70 motion-safe:animate-pulse motion-reduce:animate-none" />
            <span class="h-1.5 w-1.5 rounded-full bg-primary/40 motion-safe:animate-pulse motion-reduce:animate-none" />
          </div>
        </div>
      </div>

      <div class="min-w-0 text-center md:text-left">
        <div class="flex flex-wrap items-center justify-center gap-2 md:justify-start">
          <h2 class="text-base font-semibold text-foreground" aria-live="polite">{{ statusText }}</h2>
          <span class="rounded-full bg-surface-subtle px-2.5 py-1 text-xs text-muted-foreground tabular-nums">
            已等待 {{ elapsedLabel }}
          </span>
        </div>
        <p class="mt-1 text-sm text-muted-foreground">{{ statusHint }}</p>
        <p v-if="promptText" class="mt-3 line-clamp-2 text-sm leading-relaxed text-foreground">
          "{{ promptText }}"
        </p>
      </div>

      <button
        v-if="canCancel"
        class="inline-flex h-9 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle"
        @click="emit('cancel')"
      >
        <XCircle class="h-4 w-4" />
        取消
      </button>
    </div>

    <div class="mt-5 grid grid-cols-4 gap-2">
      <div
        v-for="(step, index) in steps"
        :key="step.key"
        class="flex min-w-0 items-center gap-2 rounded-[var(--radius-control)] border px-2.5 py-2 text-xs"
        :class="{
          'border-success/25 bg-success-soft text-success': stepState(index) === 'done',
          'border-primary/25 bg-primary-soft text-primary': stepState(index) === 'current',
          'border-border bg-surface-subtle text-muted-foreground': stepState(index) === 'idle',
          'border-border bg-neutral-soft text-neutral-status': stepState(index) === 'skipped',
          'border-danger/25 bg-danger-soft text-danger': stepState(index) === 'stopped',
        }"
      >
        <Check v-if="stepState(index) === 'done'" class="h-3.5 w-3.5 shrink-0" />
        <span v-else class="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
        <span class="truncate">{{ stepState(index) === 'skipped' ? '未启用' : step.label }}</span>
      </div>
    </div>
  </div>
</template>
