<script setup lang="ts">
import { computed } from 'vue'
import { Film, ImageIcon } from 'lucide-vue-next'
import type { GenerationJob } from '@/shared/types'
import { isVideoOutput, outputPoster, outputUrl } from '@/shared/types'

const props = defineProps<{
  job: GenerationJob
}>()

const emit = defineEmits<{
  preview: [url: string, prompt: string]
}>()

const promptText = computed(() => props.job.inputPrompt || props.job.prompt || '')
const hasOutputs = computed(() => props.job.outputs.length > 0)
const isSingle = computed(() => props.job.outputs.length === 1)
const isVideoJob = computed(() =>
  props.job.mediaKind === 'video'
  || props.job.modelKind === 'video'
  || props.job.outputs.some((o) => isVideoOutput(o)),
)
</script>

<template>
  <div class="flex w-full flex-col items-center px-4 py-8">
    <!-- Outputs, constrained within a container with controlled aspect ratio -->
    <div v-if="hasOutputs" class="w-full max-w-2xl">
      <div
        v-if="isSingle"
        class="flex max-h-[50vh] items-center justify-center overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface"
      >
        <video
          v-if="isVideoOutput(job.outputs[0])"
          :src="outputUrl(job.outputs[0])"
          :poster="outputPoster(job.outputs[0])"
          controls
          preload="metadata"
          playsinline
          class="max-h-[50vh] max-w-full bg-black"
        />
        <img
          v-else
          :src="outputUrl(job.outputs[0])"
          :alt="promptText"
          class="max-h-[50vh] max-w-full cursor-zoom-in object-contain"
          loading="lazy"
          @click="emit('preview', outputUrl(job.outputs[0]), promptText)"
        />
      </div>
      <div
        v-else
        class="grid max-h-[50vh] gap-3 overflow-auto"
        :class="job.outputs.length === 2 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'"
      >
        <div
          v-for="output in job.outputs"
          :key="output.id"
          class="relative flex aspect-square items-center justify-center overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface"
        >
          <video
            v-if="isVideoOutput(output)"
            :src="outputUrl(output)"
            :poster="outputPoster(output)"
            controls
            preload="metadata"
            playsinline
            class="h-full w-full bg-black"
          />
          <img
            v-else
            :src="outputUrl(output)"
            :alt="promptText"
            class="h-full w-full cursor-zoom-in object-contain"
            loading="lazy"
            @click="emit('preview', outputUrl(output), promptText)"
          />
          <span
            v-if="isVideoOutput(output)"
            class="pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white"
          >
            <Film class="h-3 w-3" />
            视频
          </span>
        </div>
      </div>
    </div>

    <!-- No output fallback -->
    <div v-else class="flex flex-col items-center gap-3 py-12 text-muted-foreground">
      <component :is="isVideoJob ? Film : ImageIcon" class="h-12 w-12" />
      <p class="text-sm">{{ isVideoJob ? '该任务没有可显示的视频' : '该任务没有可显示的图片' }}</p>
    </div>

    <!-- Prompt -->
    <p v-if="promptText" class="mt-4 max-w-2xl text-center text-sm text-muted-foreground line-clamp-2">{{ promptText }}</p>
  </div>
</template>
