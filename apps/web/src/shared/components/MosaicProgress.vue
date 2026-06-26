<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'

interface Props {
  /** Current generation phase. */
  phase?: string | null
  /** Current job status. */
  status: string
  /** Optimization mode. */
  optimizationMode?: string
  /** Inline mode: compact single-line display. */
  inline?: boolean
}

const props = defineProps<Props>()

const GRID_SIZE = 8
const TOTAL_CELLS = GRID_SIZE * GRID_SIZE

// Cell activity states
const cellStates = ref<number[]>(new Array(TOTAL_CELLS).fill(0))
const isComplete = ref(false)
const isFailed = ref(false)

let animationTimer: ReturnType<typeof setInterval> | null = null
let completionTimer: ReturnType<typeof setTimeout> | null = null

const steps = [
  { key: 'prepare', label: '准备任务' },
  { key: 'optimize', label: '优化提示词' },
  { key: 'generate', label: '生成图片' },
  { key: 'persist', label: '保存结果' },
]

const currentStep = computed(() => {
  const p = props.phase || ''
  const s = props.status
  if (['template_selecting', 'template_selected', 'template_skipped', 'queued'].includes(p) || s === 'queued') return 0
  if (['prompt_optimizing', 'prompt_ready'].includes(p)) return 1
  if (['image_generating'].includes(p)) return 2
  if (['asset_persisting', 'completed'].includes(p)) return 3
  if (['succeeded'].includes(s)) return 4
  return 0
})

const statusText = computed(() => {
  if (props.status === 'failed' || isFailed.value) return '生成失败'
  if (props.status === 'canceled') return '任务已取消'
  if (props.status === 'succeeded') return '生成完成'
  if (props.status === 'retry_wait' || props.phase === 'retry_wait') return '服务繁忙，正在自动重试'
  if (props.phase === 'queued' || props.status === 'queued') return '任务已加入队列，等待处理'
  if (props.phase === 'template_selecting') return '正在匹配提示词模板'
  if (props.phase === 'template_selected') return '已匹配提示词模板'
  if (props.phase === 'template_skipped') return '已使用默认优化流程'
  if (props.phase === 'prompt_optimizing') return '正在优化提示词表达'
  if (props.phase === 'prompt_ready') return '提示词已准备完成'
  if (props.phase === 'image_generating') return '模型正在生成图片'
  if (props.phase === 'asset_persisting') return '图片已生成，正在安全保存'
  return '正在处理中...'
})

const progressPercent = computed(() => {
  return Math.min((currentStep.value / steps.length) * 100, 100)
})

// Speed of cell flickering based on phase
const flickerInterval = computed(() => {
  const step = currentStep.value
  if (step === 0) return 200
  if (step === 1) return 150
  if (step === 2) return 80
  if (step === 3) return 50
  return 200
})

function startFlicker() {
  stopFlicker()

  animationTimer = setInterval(() => {
    const newStates = [...cellStates.value]
    // Number of cells to update per tick increases with phase
    const updateCount = Math.max(3, Math.floor(TOTAL_CELLS * (0.05 + currentStep.value * 0.08)))

    for (let i = 0; i < updateCount; i++) {
      const idx = Math.floor(Math.random() * TOTAL_CELLS)
      // Activity: 0 = inactive, 1 = brand-color active, 2 = bright active
      newStates[idx] = Math.random() < 0.3 ? 2 : 1
    }

    // Decay: some active cells go back to inactive
    for (let i = 0; i < TOTAL_CELLS; i++) {
      if (newStates[i] > 0 && Math.random() < 0.15) {
        newStates[i] = 0
      }
    }

    cellStates.value = newStates
  }, flickerInterval.value)
}

function stopFlicker() {
  if (animationTimer) {
    clearInterval(animationTimer)
    animationTimer = null
  }
}

function triggerComplete() {
  stopFlicker()
  // All cells light up
  cellStates.value = new Array(TOTAL_CELLS).fill(2)
  isComplete.value = true

  // Fade out after a moment
  completionTimer = setTimeout(() => {
    cellStates.value = new Array(TOTAL_CELLS).fill(0)
  }, 1200)
}

function triggerFail() {
  stopFlicker()
  isFailed.value = true
  cellStates.value = new Array(TOTAL_CELLS).fill(0)
}

// React to status changes
watch(
  () => props.status,
  (newStatus) => {
    if (newStatus === 'succeeded') {
      triggerComplete()
    } else if (newStatus === 'failed') {
      triggerFail()
    } else if (newStatus === 'canceled') {
      stopFlicker()
      cellStates.value = new Array(TOTAL_CELLS).fill(0)
    }
  },
)

// React to phase changes for flicker speed
watch(flickerInterval, () => {
  if (props.status !== 'succeeded' && props.status !== 'failed' && props.status !== 'canceled') {
    startFlicker()
  }
})

// Reduced motion
const reducedMotion = ref(false)

onMounted(() => {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion.value = mq.matches
  mq.addEventListener('change', (e) => {
    reducedMotion.value = e.matches
  })

  if (!reducedMotion.value) {
    startFlicker()
  }
})

onUnmounted(() => {
  stopFlicker()
  if (completionTimer) clearTimeout(completionTimer)
})

function cellColorClass(state: number): string {
  if (isComplete.value) return 'bg-primary'
  if (state === 2) return 'bg-primary'
  if (state === 1) return 'bg-primary/60'
  return 'bg-surface-subtle'
}
</script>

<template>
  <!-- Inline mode: compact -->
  <div v-if="inline" class="inline-flex items-center gap-2 text-sm text-foreground">
    <div class="grid grid-cols-4 gap-px">
      <div
        v-for="i in 16"
        :key="i"
        class="h-1.5 w-1.5 rounded-[1px] transition-colors duration-150"
        :class="cellColorClass(cellStates[i - 1] || 0)"
      />
    </div>
    <span>{{ statusText }}</span>
  </div>

  <!-- Full mode -->
  <div v-else class="flex flex-col items-center text-center py-8">
    <!-- Mosaic grid -->
    <div
      class="relative mb-8"
      :class="[
        isComplete ? 'animate-mosaic-complete' : '',
        isFailed ? 'opacity-40' : '',
      ]"
    >
      <div
        class="grid gap-[2px]"
        :style="{ gridTemplateColumns: `repeat(${GRID_SIZE}, 1fr)` }"
      >
        <div
          v-for="i in TOTAL_CELLS"
          :key="i"
          class="h-3 w-3 rounded-[2px] transition-all"
          :class="cellColorClass(cellStates[i - 1] || 0)"
          :style="{
            transitionDuration: reducedMotion ? '0ms' : `${100 + Math.random() * 100}ms`,
          }"
        />
      </div>
    </div>

    <!-- Status text -->
    <h3 class="text-base font-semibold text-foreground">
      {{ statusText }}
    </h3>

    <!-- Progress bar -->
    <div class="mt-4 w-full max-w-xs">
      <div class="h-0.5 w-full overflow-hidden rounded-full bg-border">
        <div
          class="h-full rounded-full bg-gradient-to-r from-primary to-primary-hover transition-all duration-500 ease-out"
          :style="{ width: `${progressPercent}%` }"
        />
      </div>
      <div class="mt-2 flex justify-between text-xs text-muted-foreground">
        <span
          v-for="(step, index) in steps"
          :key="step.key"
          :class="index < currentStep ? 'text-primary font-medium' : index === currentStep ? 'text-foreground font-medium' : ''"
        >
          {{ step.label }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes mosaic-complete {
  0% {
    transform: scale(1);
  }
  30% {
    transform: scale(1.05);
  }
  100% {
    transform: scale(1);
    opacity: 0;
  }
}

.animate-mosaic-complete {
  animation: mosaic-complete 1.2s ease-out forwards;
}
</style>
