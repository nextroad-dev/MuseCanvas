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
</script>

<template>
  <!-- Empty state -->
  <div v-if="jobs.length === 0" class="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
    <div class="flex h-14 w-14 items-center justify-center rounded-full bg-surface-subtle">
      <ImageIcon class="h-6 w-6 text-muted-foreground/50" />
    </div>
    <p class="text-sm font-medium text-foreground">还没有生成记录</p>
    <p class="text-xs text-muted-foreground">开始创作后，作品会出现在这里</p>
  </div>

  <!-- Horizontal List -->
  <div v-else class="flex flex-col gap-2 p-2">
    <div
      v-for="job in jobs"
      :key="job.id"
      class="group relative flex w-full items-center gap-3 rounded-xl p-2 transition-all duration-200"
      :class="cn(
        selectedId === job.id
          ? 'bg-surface-subtle ring-1 ring-primary'
          : 'hover:bg-surface-subtle'
      )"
    >
      <!-- Clickable area for selection -->
      <button
        type="button"
        class="absolute inset-0 z-0 h-full w-full rounded-xl focus:outline-none"
        :aria-current="selectedId === job.id ? 'true' : undefined"
        @click="emit('select', job)"
      ></button>

      <!-- Thumbnail -->
      <div class="relative z-10 h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-subtle pointer-events-none">
        <img
          v-if="job.outputs[0]?.imageUrl"
          :src="job.outputs[0].imageUrl"
          :alt="titleText(job)"
          class="block h-full w-full object-cover"
          loading="lazy"
        />
        <div v-else class="flex h-full w-full items-center justify-center">
          <ImageIcon class="h-5 w-5 text-muted-foreground/30" />
        </div>

        <!-- Status badges overlay on thumbnail -->
        <div v-if="isActive(job)" class="absolute left-1 top-1">
          <span class="flex h-4 w-4 items-center justify-center rounded-full bg-primary shadow-sm">
            <Loader2 class="h-2.5 w-2.5 animate-spin text-white" />
          </span>
        </div>
        <div v-else-if="job.status === 'failed'" class="absolute left-1 top-1">
          <span class="flex h-4 w-4 items-center justify-center rounded-full bg-danger shadow-sm">
            <AlertCircle class="h-2.5 w-2.5 text-white" />
          </span>
        </div>
        <div v-else-if="job.status === 'canceled'" class="absolute left-1 top-1">
          <span class="flex h-4 w-4 items-center justify-center rounded-full bg-neutral-status/80 shadow-sm">
            <XCircle class="h-2.5 w-2.5 text-white" />
          </span>
        </div>
      </div>

      <!-- Title / Info -->
      <div class="z-10 flex min-w-0 flex-1 flex-col pointer-events-none">
        <p class="truncate text-sm font-medium text-foreground">
          {{ titleText(job) }}
        </p>
        <p class="truncate text-xs text-muted-foreground">
          {{ job.modelName || '未知模型' }}
        </p>
      </div>

      <!-- Delete Button -->
      <button
        type="button"
        class="z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
        title="删除"
        @click.stop="emit('delete', job)"
      >
        <Trash2 class="h-4 w-4" />
      </button>
    </div>
  </div>
</template>

