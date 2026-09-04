<script setup lang="ts">
import { computed, ref } from 'vue'
import { X, RotateCcw, Copy, Plus, Trash2, ChevronDown, Download } from 'lucide-vue-next'
import StatusBadge from '@/shared/components/ui/StatusBadge.vue'
import type { GenerationJob, GenerationOutput } from '@/shared/types'
import Lightbox from '@/shared/components/ui/Lightbox.vue'
const props = defineProps<{
  job: GenerationJob
  hideHeader?: boolean
}>()

const emit = defineEmits<{
  close: []
  'reuse-prompt': [kind: 'original' | 'optimized']
  'new-generation': []
  retry: []
  delete: []
  download: [url: string]
}>()

const showReuseMenu = ref(false)
const lightboxOpen = ref(false)
const lightboxIndex = ref(0)
const lightboxImages = computed(() =>
  (props.job.inputImages || []).map((img, idx) => ({
    url: img.imageUrl,
    prompt: `参考图 ${idx + 1}`,
    alt: `参考图 ${idx + 1}`,
  }))
)

function previewInputImage(idx: number) {
  lightboxIndex.value = idx
  lightboxOpen.value = true
}


const originalPrompt = computed(() => props.job.inputPrompt || props.job.prompt || '')
const optimizedPrompt = computed(() => props.job.finalPrompt || '')
const canUseOptimizedPrompt = computed(() => !!props.job.canReadFinalPrompt && !!optimizedPrompt.value)
const optimizedPromptNotice = computed(() => {
  if (props.job.optimizationMode !== 'enabled' || optimizedPrompt.value) return ''
  if (!props.job.canReadFinalPrompt) return '管理员已关闭优化后提示词查看。'
  if (props.job.optimizationStatus === 'failed' || props.job.phase === 'optimization_failed' || props.job.phase === 'template_failed') {
    return '提示词优化失败，未生成优化后的提示词。'
  }
  if (props.job.status === 'queued' || props.job.status === 'running' || props.job.status === 'retry_wait') {
    return '提示词优化尚未完成，完成后会显示优化后的提示词。'
  }
  return '该任务没有可显示的优化后提示词。'
})

function handleReuse(kind: 'original' | 'optimized') {
  showReuseMenu.value = false
  emit('reuse-prompt', kind)
}

const titleText = computed(() => props.job.title || props.job.inputPrompt || props.job.prompt || '未命名任务')
const createdLabel = computed(() => new Date(props.job.createdAt).toLocaleString('zh-CN'))

const isFailed = computed(() => props.job.status === 'failed')
const isComplete = computed(() => props.job.status === 'succeeded' && (props.job.outputs?.length ?? 0) > 0)

const durationLabel = computed(() => {
  const start = props.job.startedAt ? new Date(props.job.startedAt).getTime() : null
  const end = props.job.completedAt ? new Date(props.job.completedAt).getTime() : null
  if (start == null) return '—'
  if (end == null) return '进行中'
  const ms = end - start
  if (ms < 1000) return `${ms} 毫秒`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m} 分 ${s} 秒`
})

const fields = computed(() => [
  { label: '任务 ID', value: props.job.id, mono: true },
  { label: '使用模型', value: props.job.modelName || '—', mono: false },
  ...(props.job.quotedCredits != null ? [{ label: '消耗积分', value: `${props.job.quotedCredits} 积分`, mono: false }] : []),
  { label: '耗时', value: durationLabel.value, mono: false },
  { label: '选择模板', value: props.job.templateName || '无', mono: false },
])

function handleDownloadAll() {
  const outputs = props.job.outputs || []
  if (outputs.length <= 1) {
    const first = outputs[0]
    if (first) emit('download', first.url || first.imageUrl)
  } else {
    outputs.forEach((o: GenerationOutput, i: number) => {
      setTimeout(() => emit('download', o.url || o.imageUrl), i * 300)
    })
  }
}
const isVideoJob = computed(() =>
  props.job.mediaKind === 'video'
  || props.job.modelKind === 'video'
  || (props.job.outputs || []).some((o) => o.mediaKind === 'video'),
)
const firstOutputUrl = computed(() => {
  const first = props.job.outputs?.[0]
  return first ? first.url || first.imageUrl : ''
})
const firstOutputPoster = computed(() => {
  const first = props.job.outputs?.[0]
  return first && first.mediaKind === 'video' ? first.metadata.posterUrl || undefined : undefined
})
</script>

<template>
  <div class="flex h-full flex-col">
    <div v-if="!hideHeader" class="flex h-12 items-center justify-between border-b border-border/60 px-4">
      <span class="text-sm font-medium text-foreground">任务详情</span>
      <button
        class="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
        @click="$emit('close')"
      >
        <X class="h-4 w-4" />
      </button>
    </div>

    <div class="flex-1 overflow-auto p-4">
      <!-- Media Preview Section -->
      <div v-if="job.outputs && job.outputs.length > 0" class="mb-5 overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-subtle">
        <video
          v-if="job.outputs[0].mediaKind === 'video'"
          :src="firstOutputUrl"
          :poster="firstOutputPoster"
          controls
          preload="metadata"
          playsinline
          class="block max-h-48 w-full bg-black"
        />
        <img
          v-else
          :src="firstOutputUrl"
          alt="Preview"
          class="block h-auto max-h-48 w-full object-cover"
        />
        <div v-if="job.outputs.length > 1" class="border-t border-border bg-surface/50 px-2 py-1 text-center text-xs text-muted-foreground backdrop-blur-sm">
          共 {{ job.outputs.length }} {{ isVideoJob ? '个视频' : '张图片' }}（仅预览第一个）
        </div>
      </div>

      <div class="mb-5">
        <StatusBadge :status="job.status" variant="soft" />
        <p class="mt-2 line-clamp-2 text-sm font-medium text-foreground">{{ titleText }}</p>
        <p class="mt-1 text-xs text-muted-foreground">{{ createdLabel }}</p>
      </div>

      <dl class="space-y-4">
        <div v-for="f in fields" :key="f.label">
          <dt class="text-xs text-muted-foreground">{{ f.label }}</dt>
          <dd
            class="mt-1 break-all text-sm text-foreground"
            :class="f.mono ? 'font-mono' : ''"
          >{{ f.value }}</dd>
        </div>
      </dl>

      <div class="mt-5 border-t border-border/60 pt-5">
        <p class="text-xs font-medium text-muted-foreground">原提示词</p>
        <p class="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-[var(--radius-card)] border border-border bg-surface-subtle px-3 py-2 text-sm leading-relaxed text-foreground">
          {{ originalPrompt || '—' }}
        </p>

        <div v-if="canUseOptimizedPrompt" class="mt-3 border-t border-border/40 pt-3">
          <p class="text-xs font-medium text-muted-foreground">优化后提示词</p>
          <p class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-[var(--radius-card)] border border-border bg-surface-subtle px-3 py-2 text-sm leading-relaxed text-foreground">
            {{ optimizedPrompt }}
          </p>
        </div>

        <p
          v-else-if="optimizedPromptNotice"
          class="mt-3 rounded-[var(--radius-control)] bg-surface-subtle px-3 py-2 text-xs leading-relaxed text-muted-foreground"
        >
          {{ optimizedPromptNotice }}
        </p>
      </div>

      <!-- Reference Images Section -->
      <div v-if="job.inputImages && job.inputImages.length > 0" class="mt-5 border-t border-border/60 pt-5">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-muted-foreground">输入参考图 ({{ job.inputImages.length }})</p>
          <span class="text-[11px] text-muted-foreground">点击预览</span>
        </div>
        <div class="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button
            v-for="(img, idx) in job.inputImages"
            :key="img.id || idx"
            type="button"
            class="group relative aspect-square overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface-subtle transition-all hover:border-primary hover:shadow-sm"
            :aria-label="`查看参考图 ${idx + 1}`"
            @click="previewInputImage(idx)"
          >
            <img
              :src="img.imageUrl"
              :alt="`参考图 ${idx + 1}`"
              class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
              loading="lazy"
            />
            <span
              class="pointer-events-none absolute left-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/65 text-[10px] font-semibold text-white"
            >
              {{ idx + 1 }}
            </span>
            <span
              v-if="img.width && img.height"
              class="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 py-0.5 text-center text-[9px] text-white/90 backdrop-blur-xs"
            >
              {{ img.width }}x{{ img.height }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="shrink-0 space-y-2 border-t border-border/60 p-4">
      <button
        v-if="isComplete"
        class="flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
        @click="handleDownloadAll"
      >
        <Download class="h-4 w-4" />
        {{ (job.outputs?.length ?? 0) > 1 ? (isVideoJob ? '全部下载视频' : '全部下载图片') : (isVideoJob ? '下载视频' : '下载图片') }}
      </button>
      <button
        v-if="isFailed"
        class="flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
        @click="$emit('retry')"
      >
        <RotateCcw class="h-4 w-4" />
        重试
      </button>
      <!-- Reuse prompt dropdown -->
      <div class="relative">
        <button
          class="flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-4 text-sm text-foreground transition-colors hover:border-border-strong hover:bg-surface-subtle"
          @click="showReuseMenu = !showReuseMenu"
        >
          <Copy class="h-4 w-4" />
          <span>复用提示词</span>
          <ChevronDown
            class="h-4 w-4 transition-transform duration-200"
            :class="{ 'rotate-180': showReuseMenu }"
          />
        </button>
        <Transition
          enter-active-class="transition ease-out duration-100"
          enter-from-class="transform opacity-0 scale-95 -translate-y-1"
          enter-to-class="transform opacity-100 scale-100 translate-y-0"
          leave-active-class="transition ease-in duration-75"
          leave-from-class="transform opacity-100 scale-100 translate-y-0"
          leave-to-class="transform opacity-0 scale-95 -translate-y-1"
        >
          <div
            v-show="showReuseMenu"
            class="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface shadow-lg"
          >
            <button
              class="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-surface-subtle"
              @click="handleReuse('original')"
            >
              原提示词
            </button>
            <button
              v-if="canUseOptimizedPrompt"
              class="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-surface-subtle"
              @click="handleReuse('optimized')"
            >
              优化后提示词
            </button>
          </div>
        </Transition>
      </div>
      <button
        class="flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-4 text-sm text-foreground transition-colors hover:border-border-strong hover:bg-surface-subtle"
        @click="$emit('new-generation')"
      >
        <Plus class="h-4 w-4" />
        新建生成
      </button>
      <button
        class="flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-danger/30 bg-surface px-4 text-sm text-danger transition-colors hover:bg-danger-soft"
        @click="$emit('delete')"
      >
        <Trash2 class="h-4 w-4" />
        删除任务
      </button>
    </div>

    <!-- Lightbox for reference images -->
    <Lightbox
      :images="lightboxImages"
      v-model:open="lightboxOpen"
      v-model="lightboxIndex"
    />
  </div>
</template>
