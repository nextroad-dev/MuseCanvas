<script setup lang="ts">
import { computed } from 'vue'
import { Loader2, Check, AlertCircle } from 'lucide-vue-next'
import { cn } from '@/shared/lib/utils'

interface Props {
  status: string
  phase?: string | null
  optimizationMode?: string
  createdAt?: string
  compact?: boolean
  inline?: boolean
}

const props = defineProps<Props>()

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

const isFailed = computed(() => ['failed', 'generation_failed', 'optimization_failed', 'template_failed'].includes(props.status))
const isCanceled = computed(() => props.status === 'canceled')

const statusText = computed(() => {
  if (isFailed.value) return '生成失败'
  if (isCanceled.value) return '任务已取消'
  if (props.status === 'succeeded') return '生成完成'
  if (props.phase === 'queued' || props.status === 'queued') return '任务已加入队列，等待开始处理'
  if (props.phase === 'prompt_optimizing') return '正在优化提示词表达'
  if (props.phase === 'image_generating') return '模型正在生成图片'
  if (props.phase === 'asset_persisting') return '图片已生成，正在安全保存'
  return '正在处理中...'
})
</script>

<template>
  <div v-if="inline" class="inline-flex items-center gap-2 text-sm text-foreground">
    <Loader2 v-if="!isFailed && !isCanceled && status !== 'succeeded'" class="h-4 w-4 animate-spin text-primary" />
    <AlertCircle v-else-if="isFailed || isCanceled" class="h-4 w-4 text-danger" />
    <Check v-else class="h-4 w-4 text-success" />
    <span>{{ statusText }}</span>
  </div>

  <div v-else :class="cn('flex flex-col items-center text-center', compact ? 'py-4' : 'py-8')">
    <!-- Status graphic -->
    <div v-if="!isFailed && !isCanceled" class="relative mb-6 flex h-24 w-24 items-center justify-center">
      <div class="absolute inset-0 rounded-full border-2 border-primary/20" />
      <div class="absolute inset-2 rounded-full border-2 border-primary/30" />
      <Loader2 v-if="status !== 'succeeded'" class="h-8 w-8 animate-spin text-primary" />
      <Check v-else class="h-8 w-8 text-success" />
    </div>

    <div v-else class="mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-danger-soft">
      <AlertCircle class="h-8 w-8 text-danger" />
    </div>

    <!-- Status text -->
    <h3 :class="['font-semibold text-foreground', compact ? 'text-sm' : 'text-base']">
      {{ statusText }}
    </h3>

    <!-- Stepper -->
    <div v-if="!compact" class="mt-6 flex w-full max-w-md items-center gap-2">
      <template v-for="(step, index) in steps" :key="step.key">
        <div class="flex flex-1 flex-col items-center gap-1.5">
          <div
            :class="cn(
              'flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-colors',
              index < currentStep
                ? 'bg-success text-white'
                : index === currentStep && !isFailed && !isCanceled
                  ? 'bg-primary text-white'
                  : isFailed
                    ? 'bg-danger text-white'
                    : 'bg-surface-subtle text-muted-foreground',
            )"
          >
            <Check v-if="index < currentStep" class="h-4 w-4" />
            <span v-else>{{ index + 1 }}</span>
          </div>
          <span class="text-xs text-muted-foreground">{{ step.label }}</span>
        </div>
        <div v-if="index < steps.length - 1" class="h-0.5 flex-1 bg-border" />
      </template>
    </div>
  </div>
</template>
