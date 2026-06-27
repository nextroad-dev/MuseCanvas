<script setup lang="ts">
import { computed } from 'vue'
import { Download, RotateCcw, Plus, ImageIcon, XCircle, ZoomIn, Clock, Cpu, Ruler } from 'lucide-vue-next'
import type { GenerationJob, GenerationOutput } from '@/shared/types'

const props = defineProps<{
  job: GenerationJob
}>()

const emit = defineEmits<{
  regenerate: []
  newGeneration: []
  download: [url: string]
  preview: [url: string, prompt: string]
}>()

const hasSingleOutput = computed(() => props.job.outputs.length === 1)
const hasOutputs = computed(() => props.job.outputs.length > 0)
const isFailed = computed(() => props.job.status === 'failed')
const isCanceled = computed(() => props.job.status === 'canceled')

const promptText = computed(() =>
  props.job.inputPrompt || props.job.prompt || ''
)

const durationLabel = computed(() => {
  if (!props.job.durationMs) return null
  const s = props.job.durationMs / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`
})

function handlePreview(url: string) {
  emit('preview', url, promptText.value)
}

function handleDownloadAll() {
  if (hasSingleOutput.value) {
    emit('download', props.job.outputs[0].imageUrl)
  } else {
    props.job.outputs.forEach((o: GenerationOutput, i: number) => {
      setTimeout(() => emit('download', o.imageUrl), i * 300)
    })
  }
}
</script>

<template>
  <div class="flex w-full flex-col items-center px-4 py-6">

    <!-- ===== Failed state ===== -->
    <div v-if="isFailed" class="flex w-full max-w-lg flex-col items-center gap-5 rounded-[var(--radius-panel)] border border-danger/20 bg-danger-soft/30 px-8 py-12 text-center">
      <div class="flex h-14 w-14 items-center justify-center rounded-full bg-danger-soft">
        <XCircle class="h-7 w-7 text-danger" />
      </div>
      <div class="space-y-1">
        <p class="text-lg font-semibold text-foreground">生成失败</p>
        <p v-if="job.errorCode" class="text-sm text-muted-foreground font-mono">{{ job.errorCode }}</p>
        <p v-else class="text-sm text-muted-foreground">任务执行过程中发生了错误</p>
      </div>
      <div class="flex flex-wrap justify-center gap-2 pt-2">
        <button
          class="flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-4 text-sm text-foreground transition-colors hover:bg-surface-subtle"
          @click="emit('regenerate')"
        >
          <RotateCcw class="h-4 w-4" />
          重试
        </button>
        <button
          class="flex h-9 items-center gap-2 rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
          @click="emit('newGeneration')"
        >
          <Plus class="h-4 w-4" />
          新建生成
        </button>
      </div>
    </div>

    <!-- ===== Canceled state ===== -->
    <div v-else-if="isCanceled" class="flex w-full max-w-lg flex-col items-center gap-5 rounded-[var(--radius-panel)] border border-border bg-surface/80 px-8 py-12 text-center">
      <div class="flex h-14 w-14 items-center justify-center rounded-full bg-surface-subtle">
        <XCircle class="h-7 w-7 text-muted-foreground" />
      </div>
      <div class="space-y-1">
        <p class="text-lg font-semibold text-foreground">任务已取消</p>
        <p class="text-sm text-muted-foreground">可以重新创建或修改提示词后再次生成</p>
      </div>
      <button
        class="flex h-9 items-center gap-2 rounded-[var(--radius-control)] bg-primary px-5 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
        @click="emit('newGeneration')"
      >
        <Plus class="h-4 w-4" />
        新建生成
      </button>
    </div>

    <!-- ===== Success: Images ===== -->
    <template v-else-if="hasOutputs">
      <!-- Single image -->
      <div v-if="hasSingleOutput" class="w-full max-w-2xl">
        <div
          class="group relative cursor-zoom-in overflow-hidden rounded-[var(--radius-card)] border border-border/60 bg-surface shadow-md transition-all duration-300 hover:border-border-strong hover:shadow-xl"
          @click="handlePreview(job.outputs[0].imageUrl)"
        >
          <img
            :src="job.outputs[0].imageUrl"
            :alt="promptText"
            class="block h-auto max-h-[55vh] w-full object-contain transition-transform duration-500 group-hover:scale-[1.02]"
            loading="lazy"
          />
          <!-- Hover overlay -->
          <div class="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-300 group-hover:bg-black/20">
            <div class="flex scale-75 items-center gap-2 rounded-full border border-white/30 bg-black/50 px-4 py-2 text-sm font-medium text-white opacity-0 backdrop-blur-sm transition-all duration-300 group-hover:scale-100 group-hover:opacity-100">
              <ZoomIn class="h-4 w-4" />
              点击放大
            </div>
          </div>
        </div>
      </div>

      <!-- Multiple images grid -->
      <div
        v-else
        class="grid w-full max-w-4xl gap-3"
        :class="job.outputs.length === 2 ? 'grid-cols-2' : job.outputs.length === 3 ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-2 md:grid-cols-2 lg:grid-cols-4'"
      >
        <div
          v-for="output in job.outputs"
          :key="output.id"
          class="group relative cursor-zoom-in overflow-hidden rounded-[var(--radius-card)] border border-border/60 bg-surface shadow-sm transition-all duration-300 hover:border-border-strong hover:shadow-lg"
          @click="handlePreview(output.imageUrl)"
        >
          <img
            :src="output.imageUrl"
            :alt="promptText"
            class="block h-auto w-full object-contain transition-transform duration-500 group-hover:scale-[1.04]"
            loading="lazy"
          />
          <!-- Hover overlay -->
          <div class="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-300 group-hover:bg-black/25">
            <ZoomIn class="h-6 w-6 scale-50 text-white opacity-0 transition-all duration-300 drop-shadow group-hover:scale-100 group-hover:opacity-100" />
          </div>
          <!-- Download button on hover -->
          <button
            class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white opacity-0 backdrop-blur-sm transition-all duration-200 hover:bg-black/70 group-hover:opacity-100"
            @click.stop="emit('download', output.imageUrl)"
          >
            <Download class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </template>

    <!-- No outputs fallback -->
    <div v-else class="flex flex-col items-center gap-3 py-12 text-muted-foreground">
      <ImageIcon class="h-10 w-10" />
      <p class="text-sm">任务已完成，但未返回图片</p>
    </div>

    <!-- ===== Prompt + Meta info ===== -->
    <div v-if="!isFailed && !isCanceled" class="mt-5 w-full max-w-2xl space-y-3">
      <!-- Prompt text -->
      <p v-if="promptText" class="line-clamp-2 text-center text-sm text-muted-foreground">
        {{ promptText }}
      </p>

      <!-- Meta pills -->
      <div class="flex flex-wrap items-center justify-center gap-1.5">
        <span
          v-if="job.modelName"
          class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted-foreground"
        >
          <Cpu class="h-3 w-3" />
          {{ job.modelName }}
        </span>
        <span
          v-if="job.size"
          class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted-foreground"
        >
          <Ruler class="h-3 w-3" />
          {{ job.size }}
        </span>
        <span
          v-if="durationLabel"
          class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted-foreground"
        >
          <Clock class="h-3 w-3" />
          {{ durationLabel }}
        </span>
      </div>
    </div>

    <!-- ===== Action buttons ===== -->
    <div class="mt-6 flex flex-wrap items-center justify-center gap-2">
      <button
        v-if="hasOutputs && !isFailed && !isCanceled"
        class="flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-4 text-sm text-foreground transition-all hover:border-border-strong hover:bg-surface-subtle"
        @click="handleDownloadAll"
      >
        <Download class="h-4 w-4" />
        {{ hasSingleOutput ? '下载' : '全部下载' }}
      </button>
      <button
        v-if="!isCanceled"
        class="flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-4 text-sm text-foreground transition-all hover:border-border-strong hover:bg-surface-subtle"
        @click="emit('regenerate')"
      >
        <RotateCcw class="h-4 w-4" />
        再来一次
      </button>
      <button
        class="flex h-9 items-center gap-2 rounded-[var(--radius-control)] bg-primary px-5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover hover:shadow-md active:scale-[0.97]"
        @click="emit('newGeneration')"
      >
        <Plus class="h-4 w-4" />
        新建生成
      </button>
    </div>
  </div>
</template>
