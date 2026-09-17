<script setup lang="ts">
import { computed, ref } from 'vue'
import { X, RotateCcw, Copy, Plus, Trash2, ChevronDown, Download } from 'lucide-vue-next'
import StatusBadge from '@/shared/components/ui/StatusBadge.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import Popover from '@/shared/components/ui/Popover.vue'
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

const reuseMenuOpen = ref(false)
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
  reuseMenuOpen.value = false
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
  { label: '消耗积分', value: props.job.quotedCredits != null ? `${props.job.quotedCredits} 积分` : '—', mono: false },
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
    <div v-if="!hideHeader" class="flex h-14 items-center justify-between border-b border-border px-4">
      <span class="text-sm font-medium text-foreground">任务详情</span>
      <button
        type="button"
        class="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
        aria-label="关闭任务详情"
        @click="$emit('close')"
      >
        <X class="h-4 w-4" aria-hidden="true"/>
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
          class="block max-h-48 w-full bg-overlay"
        />
        <img
          v-else
          :src="firstOutputUrl"
          alt="生成结果预览"
          class="block h-auto max-h-48 w-full object-cover"
        />
        <div v-if="job.outputs.length > 1" class="border-t border-border bg-surface-subtle px-2 py-1 text-center text-xs tabular-nums text-muted-foreground">
          共 {{ job.outputs.length }} {{ isVideoJob ? '个视频' : '张图片' }}（仅预览第一个）
        </div>
      </div>

      <div class="mb-5" role="status" aria-atomic="true">
        <StatusBadge :status="job.status" variant="soft" />
        <p class="mt-2 line-clamp-2 text-sm font-medium text-foreground">{{ titleText }}</p>
        <p class="mt-1 font-mono text-xs tabular-nums text-muted-foreground">{{ createdLabel }}</p>
      </div>

      <dl class="space-y-4">
        <div v-for="f in fields" :key="f.label">
          <dt class="text-xs text-muted-foreground">{{ f.label }}</dt>
          <dd
            class="mt-1 break-all text-sm text-foreground"
            :class="f.mono ? 'font-mono text-xs' : 'tabular-nums'"
          >{{ f.value }}</dd>
        </div>
      </dl>

      <div class="mt-5 border-t border-border pt-5">
        <p class="text-xs font-medium text-muted-foreground">原提示词</p>
        <p class="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-[var(--radius-card)] border border-border bg-surface-subtle px-3 py-2 text-sm leading-[1.59] text-foreground">
          {{ originalPrompt || '—' }}
        </p>

        <div v-if="canUseOptimizedPrompt" class="mt-3 border-t border-border pt-3">
          <p class="text-xs font-medium text-muted-foreground">优化后提示词</p>
          <p class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-[var(--radius-card)] border border-border bg-surface-subtle px-3 py-2 text-sm leading-[1.59] text-foreground">
            {{ optimizedPrompt }}
          </p>
        </div>

        <p
          v-else-if="optimizedPromptNotice"
          class="mt-3 rounded-[var(--radius-control)] bg-surface-subtle px-3 py-2 text-xs leading-[1.5] text-muted-foreground"
        >
          {{ optimizedPromptNotice }}
        </p>
      </div>

      <!-- Reference Images Section -->
      <div v-if="job.inputImages && job.inputImages.length > 0" class="mt-5 border-t border-border pt-5">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-muted-foreground">输入参考图 ({{ job.inputImages.length }})</p>
          <span class="text-xs text-muted-foreground">点击预览</span>
        </div>
        <div class="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button
            v-for="(img, idx) in job.inputImages"
            :key="img.id || idx"
            type="button"
            class="group relative aspect-square overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface-subtle transition-colors hover:border-border-strong"
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
              class="pointer-events-none absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-overlay/65 text-xs font-medium tabular-nums text-foreground-inverse"
            >
              {{ idx + 1 }}
            </span>
            <span
              v-if="img.width && img.height"
              class="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-overlay/60 px-1 py-0.5 text-center text-xs tabular-nums text-foreground-inverse"
            >
              {{ img.width }}x{{ img.height }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="shrink-0 space-y-2 border-t border-border p-4">
      <BaseButton
        v-if="isComplete"
        variant="primary"
        class="w-full"
        @click="handleDownloadAll"
      >
        <template #icon>
          <Download class="h-4 w-4" aria-hidden="true"/>
        </template>
        {{ (job.outputs?.length ?? 0) > 1 ? (isVideoJob ? '全部下载视频' : '全部下载图片') : (isVideoJob ? '下载视频' : '下载图片') }}
      </BaseButton>

      <BaseButton
        v-if="isFailed"
        variant="primary"
        class="w-full"
        @click="$emit('retry')"
      >
        <template #icon>
          <RotateCcw class="h-4 w-4" aria-hidden="true"/>
        </template>
        重试
      </BaseButton>

      <!-- Reuse prompt menu -->
      <Popover
        v-model="reuseMenuOpen"
        role="menu"
        label="复用提示词"
        panel-class="left-0 right-0 min-w-0"
      >
        <template #trigger="{ open: isOpen, toggle }">
          <BaseButton variant="secondary" class="w-full" aria-haspopup="menu" :aria-expanded="isOpen" @click.stop="toggle">
            <template #icon>
              <Copy class="h-4 w-4" aria-hidden="true"/>
            </template>
            <span>复用提示词</span>
            <ChevronDown
              class="h-4 w-4 transition-transform"
              :class="{ 'rotate-180': isOpen }"
              aria-hidden="true"
            />
          </BaseButton>
        </template>
        <div role="presentation" class="flex flex-col gap-1">
          <button
            type="button"
            role="menuitem"
            data-menu-item
            tabindex="-1"
            class="flex min-h-10 w-full items-center rounded-[var(--radius-control)] px-3 text-left text-sm text-foreground transition-colors hover:bg-surface-subtle"
            @click="handleReuse('original')"
          >
            原提示词
          </button>
          <button
            v-if="canUseOptimizedPrompt"
            type="button"
            role="menuitem"
            data-menu-item
            tabindex="-1"
            class="flex min-h-10 w-full items-center rounded-[var(--radius-control)] px-3 text-left text-sm text-foreground transition-colors hover:bg-surface-subtle"
            @click="handleReuse('optimized')"
          >
            优化后提示词
          </button>
        </div>
      </Popover>

      <BaseButton variant="secondary" class="w-full" @click="$emit('new-generation')">
        <template #icon>
          <Plus class="h-4 w-4" aria-hidden="true"/>
        </template>
        新建生成
      </BaseButton>

      <BaseButton variant="danger-ghost" class="w-full" @click="$emit('delete')">
        <template #icon>
          <Trash2 class="h-4 w-4" aria-hidden="true"/>
        </template>
        删除任务
      </BaseButton>
    </div>

    <!-- Lightbox for reference images -->
    <Lightbox
      :images="lightboxImages"
      v-model:open="lightboxOpen"
      v-model="lightboxIndex"
    />
  </div>
</template>