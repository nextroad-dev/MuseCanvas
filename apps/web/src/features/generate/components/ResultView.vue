<script setup lang="ts">
import { computed, ref } from 'vue'
import { Download, RotateCcw, Plus, ImageIcon, Film, XCircle, ZoomIn, Clock, Cpu, Ruler } from 'lucide-vue-next'
import type { GenerationJob, GenerationOutput } from '@/shared/types'
import { isVideoOutput, outputPoster, outputUrl } from '@/shared/types'
import Lightbox from '@/shared/components/ui/Lightbox.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'

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
const isVideoJob = computed(() =>
  props.job.mediaKind === 'video'
  || props.job.modelKind === 'video'
  || props.job.outputs.some((o) => isVideoOutput(o)),
)

const promptText = computed(() =>
  props.job.inputPrompt || props.job.prompt || '',
)

const durationLabel = computed(() => {
  if (!props.job.durationMs) return null
  const s = props.job.durationMs / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`
})

const videoMeta = computed(() => {
  const first = props.job.outputs.find((o) => isVideoOutput(o))
  if (!first || first.mediaKind !== 'video') return null
  const meta = first.metadata
  const parts: string[] = []
  if (meta.durationSeconds) parts.push(`${meta.durationSeconds}s`)
  if (meta.aspectRatio) parts.push(String(meta.aspectRatio))
  if (meta.hasAudio !== undefined) parts.push(meta.hasAudio ? '有声' : '静音')
  return parts.join(' · ') || null
})

function handlePreview(output: GenerationOutput) {
  if (isVideoOutput(output)) return
  emit('preview', outputUrl(output), promptText.value)
}

function handleDownloadAll() {
  if (hasSingleOutput.value) {
    emit('download', outputUrl(props.job.outputs[0]))
  } else {
    props.job.outputs.forEach((o: GenerationOutput, i: number) => {
      setTimeout(() => emit('download', outputUrl(o)), i * 300)
    })
  }
}

function downloadFilename(output: GenerationOutput): string {
  const url = outputUrl(output)
  return url.split('/').pop()?.split('?')[0]
    || (isVideoOutput(output) ? `musecanvas-${Date.now()}.mp4` : `musecanvas-${Date.now()}.png`)
}

const inputLightboxOpen = ref(false)
const inputLightboxIndex = ref(0)
const inputLightboxImages = computed(() =>
  (props.job.inputImages || []).map((img, idx) => ({
    url: img.imageUrl,
    prompt: `参考图 ${idx + 1}`,
    alt: `参考图 ${idx + 1}`,
  })),
)

function previewInputImage(idx: number) {
  inputLightboxIndex.value = idx
  inputLightboxOpen.value = true
}
</script>

<template>
  <div class="flex w-full flex-col items-center px-4 py-6">

    <!-- ===== Failed state ===== -->
    <div
      v-if="isFailed"
      class="flex w-full max-w-lg flex-col items-center gap-5 rounded-[var(--radius-panel)] border border-danger-border bg-danger-soft px-8 py-12 text-center"
      role="status"
    >
      <div class="flex h-14 w-14 items-center justify-center rounded-full bg-surface text-danger">
        <XCircle class="h-7 w-7" aria-hidden="true" />
      </div>
      <div class="space-y-1">
        <p class="text-base font-medium text-foreground">生成失败</p>
        <p v-if="job.errorCode" class="font-mono text-xs text-muted-foreground">{{ job.errorCode }}</p>
        <p v-else class="text-sm text-muted-foreground">任务执行过程中发生了错误</p>
      </div>
      <div class="flex flex-wrap justify-center gap-2 pt-2">
        <BaseButton variant="secondary" @click="emit('regenerate')">
          <RotateCcw class="h-4 w-4" aria-hidden="true" />
          重试
        </BaseButton>
        <BaseButton variant="primary" @click="emit('newGeneration')">
          <Plus class="h-4 w-4" aria-hidden="true" />
          新建生成
        </BaseButton>
      </div>
    </div>

    <!-- ===== Canceled state ===== -->
    <div
      v-else-if="isCanceled"
      class="flex w-full max-w-lg flex-col items-center gap-5 rounded-[var(--radius-panel)] border border-border bg-surface px-8 py-12 text-center"
      role="status"
    >
      <div class="flex h-14 w-14 items-center justify-center rounded-full bg-surface-subtle">
        <XCircle class="h-7 w-7 text-muted-foreground" aria-hidden="true" />
      </div>
      <div class="space-y-1">
        <p class="text-base font-medium text-foreground">任务已取消</p>
        <p class="text-sm text-muted-foreground">可以重新创建或修改提示词后再次生成</p>
      </div>
      <BaseButton variant="primary" @click="emit('newGeneration')">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新建生成
      </BaseButton>
    </div>

    <!-- ===== Success: outputs (image and video) ===== -->
    <template v-else-if="hasOutputs">
      <!-- Single output -->
      <div v-if="hasSingleOutput" class="w-full max-w-2xl">
        <div
          v-if="isVideoOutput(job.outputs[0])"
          class="relative overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface"
        >
          <video
            :src="outputUrl(job.outputs[0])"
            :poster="outputPoster(job.outputs[0])"
            controls
            preload="metadata"
            playsinline
            class="block max-h-[55vh] w-full bg-overlay"
          />
          <span class="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-overlay/70 px-2 py-0.5 text-xs font-medium text-foreground-inverse">
            <Film class="h-3 w-3" aria-hidden="true" />
            视频
          </span>
        </div>
        <button
          v-else
          type="button"
          class="group relative block w-full cursor-zoom-in overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface"
          :aria-label="`放大查看生成结果：${promptText}`"
          @click="handlePreview(job.outputs[0])"
        >
          <img
            :src="outputUrl(job.outputs[0])"
            :alt="promptText"
            class="block h-auto max-h-[55vh] w-full object-contain"
            loading="lazy"
          />
          <!-- Hover hint: opacity only, and always visible on narrow viewports. -->
          <span class="media-scrim pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-[var(--motion-base)] group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
          <span class="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <span class="inline-flex items-center gap-2 rounded-full bg-overlay/70 px-4 py-2 text-sm font-medium text-foreground-inverse opacity-100 transition-opacity duration-[var(--motion-base)] md:opacity-0 md:group-hover:opacity-100 md:group-focus-visible:opacity-100">
              <ZoomIn class="h-4 w-4" aria-hidden="true" />
              点击放大
            </span>
          </span>
        </button>
      </div>

      <!-- Multiple outputs grid -->
      <div
        v-else
        class="grid w-full max-w-4xl gap-3"
        :class="job.outputs.length === 2 ? 'grid-cols-2' : job.outputs.length === 3 ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-2 md:grid-cols-2 lg:grid-cols-4'"
      >
        <div
          v-for="output in job.outputs"
          :key="output.id"
          class="group relative overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface"
        >
          <template v-if="isVideoOutput(output)">
            <video
              :src="outputUrl(output)"
              :poster="outputPoster(output)"
              controls
              preload="metadata"
              playsinline
              class="block h-auto w-full bg-overlay"
            />
            <span class="pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-overlay/70 px-2 py-0.5 text-xs font-medium text-foreground-inverse">
              <Film class="h-3 w-3" aria-hidden="true" />
              视频
            </span>
          </template>
          <template v-else>
            <button
              type="button"
              class="block w-full cursor-zoom-in"
              :aria-label="`放大查看生成结果：${promptText}`"
              @click="handlePreview(output)"
            >
              <img
                :src="outputUrl(output)"
                :alt="promptText"
                class="block h-auto w-full object-contain"
                loading="lazy"
              />
            </button>
            <!-- Hover affordance: opacity only, reachable by keyboard focus. -->
            <span class="pointer-events-none absolute inset-0 flex items-center justify-center bg-overlay/25 opacity-0 transition-opacity duration-[var(--motion-base)] group-hover:opacity-100 group-focus-within:opacity-100" aria-hidden="true">
              <ZoomIn class="h-6 w-6 text-foreground-inverse" />
            </span>
          </template>
          <!-- Download: always available on touch, revealed on hover/focus. -->
          <button
            type="button"
            class="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-overlay/70 text-foreground-inverse opacity-100 transition-opacity duration-[var(--motion-base)] hover:bg-overlay md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
            :aria-label="`下载 ${downloadFilename(output)}`"
            @click.stop="emit('download', outputUrl(output))"
          >
            <Download class="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </template>

    <!-- No outputs fallback -->
    <div v-else class="flex flex-col items-center gap-3 py-12 text-muted-foreground">
      <component :is="isVideoJob ? Film : ImageIcon" class="h-10 w-10" aria-hidden="true" />
      <p class="text-sm">{{ isVideoJob ? '任务已完成，但未返回视频' : '任务已完成，但未返回图片' }}</p>
    </div>

    <!-- ===== Prompt + Meta info ===== -->
    <div v-if="!isFailed && !isCanceled" class="mt-5 w-full max-w-2xl space-y-3">
      <!-- Prompt text -->
      <p v-if="promptText" class="line-clamp-2 text-center text-sm leading-[1.59] text-muted-foreground">
        {{ promptText }}
      </p>

      <!-- Meta pills -->
      <div class="flex flex-wrap items-center justify-center gap-1.5">
        <span
          v-if="job.modelName"
          class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted-foreground"
        >
          <Cpu class="h-3 w-3" aria-hidden="true" />
          {{ job.modelName }}
        </span>
        <span
          v-if="isVideoJob"
          class="inline-flex items-center gap-1.5 rounded-full border border-accent-soft bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent-strong"
        >
          <Film class="h-3 w-3" aria-hidden="true" />
          视频
        </span>
        <span
          v-if="videoMeta"
          class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs tabular-nums text-muted-foreground"
        >
          <Ruler class="h-3 w-3" aria-hidden="true" />
          {{ videoMeta }}
        </span>
        <span
          v-else-if="job.size"
          class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs tabular-nums text-muted-foreground"
        >
          <Ruler class="h-3 w-3" aria-hidden="true" />
          {{ job.size }}
        </span>
        <span
          v-if="durationLabel"
          class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs tabular-nums text-muted-foreground"
        >
          <Clock class="h-3 w-3" aria-hidden="true" />
          {{ durationLabel }}
        </span>
      </div>

      <!-- Reference images row -->
      <div
        v-if="job.inputImages && job.inputImages.length > 0"
        class="mt-3 flex flex-col items-center gap-1.5"
      >
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ImageIcon class="h-3.5 w-3.5 text-accent-strong" aria-hidden="true" />
          <span>输入参考图 ({{ job.inputImages.length }})</span>
        </div>
        <div class="flex flex-wrap items-center justify-center gap-2">
          <button
            v-for="(img, idx) in job.inputImages"
            :key="img.id || idx"
            type="button"
            class="relative h-12 w-12 cursor-zoom-in overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface transition-colors hover:border-border-control"
            :aria-label="`查看参考图 ${idx + 1}`"
            @click="previewInputImage(idx)"
          >
            <img
              :src="img.imageUrl"
              :alt="`参考图 ${idx + 1}`"
              class="h-full w-full object-cover"
              loading="lazy"
            />
            <span
              class="pointer-events-none absolute left-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-overlay/65 text-xs font-medium tabular-nums text-foreground-inverse"
            >
              {{ idx + 1 }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- ===== Action buttons ===== -->
    <div class="mt-6 flex flex-wrap items-center justify-center gap-2">
      <BaseButton
        v-if="hasOutputs && !isFailed && !isCanceled"
        variant="secondary"
        @click="handleDownloadAll"
      >
        <Download class="h-4 w-4" aria-hidden="true" />
        {{ hasSingleOutput ? '下载' : '全部下载' }}
      </BaseButton>
      <BaseButton
        v-if="!isCanceled"
        variant="secondary"
        @click="emit('regenerate')"
      >
        <RotateCcw class="h-4 w-4" aria-hidden="true" />
        再来一次
      </BaseButton>
      <BaseButton variant="primary" @click="emit('newGeneration')">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新建生成
      </BaseButton>
    </div>

    <!-- Lightbox for reference images -->
    <Lightbox
      :images="inputLightboxImages"
      v-model:open="inputLightboxOpen"
      v-model="inputLightboxIndex"
    />
  </div>
</template>