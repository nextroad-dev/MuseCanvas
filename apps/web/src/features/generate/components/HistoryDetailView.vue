<script setup lang="ts">
import { computed } from 'vue'
import { ImageIcon } from 'lucide-vue-next'
import type { GenerationJob } from '@/shared/types'

const props = defineProps<{
  job: GenerationJob
}>()

const emit = defineEmits<{
  preview: [url: string, prompt: string]
}>()

const promptText = computed(() => props.job.inputPrompt || props.job.prompt || '')
const hasOutputs = computed(() => props.job.outputs.length > 0)
const isSingle = computed(() => props.job.outputs.length === 1)
</script>

<template>
  <div class="flex w-full flex-col items-center px-4 py-8">
    <!-- Image, constrained within a container with controlled aspect ratio -->
    <div v-if="hasOutputs" class="w-full max-w-2xl">
      <div
        v-if="isSingle"
        class="flex max-h-[50vh] items-center justify-center overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface"
      >
        <img
          :src="job.outputs[0].imageUrl"
          :alt="promptText"
          class="max-h-[50vh] max-w-full cursor-zoom-in object-contain"
          loading="lazy"
          @click="emit('preview', job.outputs[0].imageUrl, promptText)"
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
          class="flex aspect-square items-center justify-center overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface"
        >
          <img
            :src="output.imageUrl"
            :alt="promptText"
            class="h-full w-full cursor-zoom-in object-contain"
            loading="lazy"
            @click="emit('preview', output.imageUrl, promptText)"
          />
        </div>
      </div>
    </div>

    <!-- No image fallback -->
    <div v-else class="flex flex-col items-center gap-3 py-12 text-muted-foreground">
      <ImageIcon class="h-12 w-12" />
      <p class="text-sm">该任务没有可显示的图片</p>
    </div>

    <!-- Prompt -->
    <p v-if="promptText" class="mt-4 max-w-2xl text-center text-sm text-muted-foreground line-clamp-2">{{ promptText }}</p>
  </div>
</template>
