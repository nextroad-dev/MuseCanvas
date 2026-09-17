<script setup lang="ts">
import { AlertCircle, Image as ImageIcon, Loader2, XCircle, Trash2 } from 'lucide-vue-next'
import type { GenerationJob } from '@/shared/types'
import { cn } from '@/shared/lib/utils'

interface Props {
  jobs: GenerationJob[]
  selectedId?: string | null
}

defineProps<Props>()
const emit = defineEmits<{
  select: [job: GenerationJob]
  delete: [job: GenerationJob]
}>()

function isActive(job: GenerationJob) {
  return ['queued', 'running', 'retry_wait'].includes(job.status)
}

function titleText(job: GenerationJob) {
  return job.title || job.inputPrompt || job.prompt || '未命名任务'
}

function outputUrl(job: GenerationJob) {
  const first = job.outputs[0]
  if (!first) return ''
  return first.url || first.imageUrl
}

function hasVideo(job: GenerationJob) {
  return job.outputs[0]?.mediaKind === 'video' || job.mediaKind === 'video'
}
</script>

<template>
  <!-- Empty state -->
  <div v-if="jobs.length === 0" class="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
    <div class="flex h-12 w-12 items-center justify-center rounded-full bg-surface-subtle">
      <ImageIcon class="h-6 w-6 text-muted-foreground" aria-hidden="true" />
    </div>
    <p class="text-sm font-medium text-foreground">还没有生成记录</p>
    <p class="text-xs text-muted-foreground">开始创作后，作品会出现在这里</p>
  </div>

  <!-- List -->
  <div v-else class="flex flex-col gap-2 p-2">
    <div
      v-for="job in jobs"
      :key="job.id"
      class="group relative flex w-full items-center gap-3 rounded-[var(--radius-card)] border border-transparent p-2 transition-colors"
      :class="cn(
        selectedId === job.id
          ? 'border-accent bg-accent-soft'
          : 'hover:bg-surface-subtle',
      )"
    >
      <!-- Selection target covering the row -->
      <button
        type="button"
        class="absolute inset-0 z-0 h-full w-full rounded-[var(--radius-card)]"
        :aria-current="selectedId === job.id ? 'true' : undefined"
        :aria-label="`查看历史任务：${titleText(job)}`"
        @click="emit('select', job)"
      ></button>

      <!-- Thumbnail -->
      <div class="pointer-events-none relative z-10 h-14 w-14 shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-surface-subtle">
        <video
          v-if="hasVideo(job) && outputUrl(job)"
          :src="outputUrl(job)"
          preload="metadata"
          muted
          playsinline
          class="block h-full w-full object-cover"
        />
        <img
          v-else-if="outputUrl(job)"
          :src="outputUrl(job)"
          :alt="titleText(job)"
          class="block h-full w-full object-cover"
          loading="lazy"
        />
        <div v-else class="flex h-full w-full items-center justify-center">
          <ImageIcon class="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>

        <!-- Media kind badge -->
        <div v-if="hasVideo(job)" class="absolute bottom-1 right-1">
          <span class="flex items-center rounded-[var(--radius-control)] bg-overlay/70 px-1 py-px text-xs font-medium text-foreground-inverse">视频</span>
        </div>

        <!-- Status badges overlay on thumbnail -->
        <div v-if="isActive(job)" class="absolute left-1 top-1">
          <span class="flex h-5 w-5 items-center justify-center rounded-full bg-accent">
            <Loader2 class="h-3 w-3 animate-spin text-foreground-inverse" aria-hidden="true" />
          </span>
        </div>
        <div v-else-if="job.status === 'failed'" class="absolute left-1 top-1">
          <span class="flex h-5 w-5 items-center justify-center rounded-full bg-danger">
            <AlertCircle class="h-3 w-3 text-foreground-inverse" aria-hidden="true" />
          </span>
        </div>
        <div v-else-if="job.status === 'canceled'" class="absolute left-1 top-1">
          <span class="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-status">
            <XCircle class="h-3 w-3 text-foreground-inverse" aria-hidden="true" />
          </span>
        </div>
      </div>

      <div class="pointer-events-none z-10 flex min-w-0 flex-1 flex-col">
        <p class="truncate text-sm font-medium text-foreground">
          {{ titleText(job) }}
        </p>
        <p class="truncate text-xs text-muted-foreground">
          {{ job.modelName || '未知模型' }}{{ hasVideo(job) ? ' · 视频' : '' }}
        </p>
      </div>

      <!-- Delete: keyboard reachable and always available on narrow viewports. -->
      <button
        type="button"
        class="z-10 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground opacity-100 transition-colors hover:bg-danger-soft hover:text-danger md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
        :aria-label="`删除任务：${titleText(job)}`"
        @click.stop="emit('delete', job)"
      >
        <Trash2 class="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>