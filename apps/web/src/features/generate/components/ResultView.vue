<script setup lang="ts">
import { computed } from 'vue'
import { Download, RotateCcw, Plus, ImageIcon, XCircle } from 'lucide-vue-next'
import type { GenerationJob } from '@/shared/types'

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

function handlePreview(url: string) {
  emit('preview', url, promptText.value)
}
</script>

<template>
  <div class="flex w-full flex-col items-center px-4 py-8">
    <!-- Failed state -->
    <div v-if="isFailed" class="flex flex-col items-center gap-4 py-12 text-center">
      <XCircle class="h-12 w-12 text-danger" />
      <div class="space-y-1">
        <p class="text-lg font-medium text-foreground">生成失败</p>
        <p v-if="job.errorCode" class="text-sm text-muted-foreground">
          {{ job.errorCode }}
        </p>
        <p v-else class="text-sm text-muted-foreground">任务执行过程中发生了错误</p>
      </div>
    </div>

    <!-- Canceled state -->
    <div v-else-if="isCanceled" class="flex flex-col items-center gap-4 py-12 text-center">
      <XCircle class="h-12 w-12 text-muted-foreground" />
      <div class="space-y-1">
        <p class="text-lg font-medium text-foreground">任务已取消</p>
        <p class="text-sm text-muted-foreground">你可以在历史任务中查看详情</p>
      </div>
    </div>

    <!-- Single image -->
    <div v-else-if="hasSingleOutput" class="w-full max-w-2xl">
      <div
        class="flex cursor-pointer items-center justify-center overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface transition-all hover:border-border-strong"
        @click="handlePreview(props.job.outputs[0].imageUrl)"
      >
        <img
          :src="props.job.outputs[0].imageUrl"
          :alt="promptText"
          class="h-auto max-h-[50vh] w-full object-contain"
          loading="lazy"
        />
      </div>
    </div>

    <!-- Multiple images -->
    <div v-else-if="hasOutputs" class="grid w-full max-w-4xl gap-4" :class="props.job.outputs.length === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'">
      <div
        v-for="output in props.job.outputs"
        :key="output.id"
        class="flex aspect-square cursor-pointer items-center justify-center overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface transition-all hover:border-border-strong"
        @click="handlePreview(output.imageUrl)"
      >
        <img
          :src="output.imageUrl"
          :alt="promptText"
          class="h-full w-full object-contain"
          loading="lazy"
        />
      </div>
    </div>

    <!-- No outputs fallback -->
    <div v-else class="flex flex-col items-center gap-3 py-12 text-muted-foreground">
      <ImageIcon class="h-12 w-12" />
      <p>任务已完成，但未返回图片</p>
    </div>

    <!-- Prompt display -->
    <div v-if="promptText" class="mt-6 max-w-2xl text-center">
      <p class="text-sm text-muted-foreground line-clamp-2">{{ promptText }}</p>
    </div>

    <!-- Actions -->
    <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
      <button
        v-if="hasOutputs && !isFailed && !isCanceled"
        class="flex h-10 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-4 text-sm text-foreground transition-colors hover:border-border-strong hover:bg-surface-subtle"
        @click="emit('download', props.job.outputs[0].imageUrl)"
      >
        <Download class="h-4 w-4" />
        下载
      </button>
      <button
        class="flex h-10 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-4 text-sm text-foreground transition-colors hover:border-border-strong hover:bg-surface-subtle"
        @click="emit('regenerate')"
      >
        <RotateCcw class="h-4 w-4" />
        再来一次
      </button>
      <button
        class="flex h-10 items-center gap-2 rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
        @click="emit('newGeneration')"
      >
        <Plus class="h-4 w-4" />
        新建生成
      </button>
    </div>
  </div>
</template>
