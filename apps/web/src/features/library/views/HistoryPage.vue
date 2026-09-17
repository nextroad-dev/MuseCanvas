<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import { useGenerationStore } from '@/features/generate/stores/generation'
import StatusBadge from '@/shared/components/ui/StatusBadge.vue'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import EmptyState from '@/shared/components/ui/EmptyState.vue'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import JobListItem from '@/shared/components/jobs/JobListItem.vue'
import Lightbox from '@/shared/components/ui/Lightbox.vue'
import {
  Loader2, RefreshCw, XCircle, Image as ImageIcon, Trash2, Copy,
} from 'lucide-vue-next'
import { canCancelJob, phaseLabel } from '@/shared/lib/job'
import { cn } from '@/shared/lib/utils'
import { toast } from '@/shared/composables/useToast'
import type { GenerationJob } from '@/shared/types'

const store = useGenerationStore()
const deleteTarget = ref<string | null>(null)
const showDeleteConfirm = ref(false)
const showPromptDetail = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null
const lightboxOpen = ref(false)
const lightboxIndex = ref(0)
const lightboxImages = ref<{ url: string; prompt?: string; alt?: string }[]>([])

const selectedJob = computed<GenerationJob>(() => store.selectedJob as GenerationJob)
const finalPromptNotice = computed(() => {
  const job = selectedJob.value
  if (!job || job.optimizationMode !== 'enabled' || job.finalPrompt) return ''
  if (!job.canReadFinalPrompt) return '管理员已关闭最终提示词查看。'
  if (job.optimizationStatus === 'failed' || job.phase === 'optimization_failed' || job.phase === 'template_failed') {
    return '提示词优化失败，未生成最终提示词。'
  }
  if (job.status === 'queued' || job.status === 'running' || job.status === 'retry_wait') {
    return '提示词优化尚未完成，完成后会显示最终提示词。'
  }
  return '该任务没有可显示的最终提示词。'
})

function previewInputImage(idx: number) {
  lightboxImages.value = (selectedJob.value?.inputImages || []).map((img, i) => ({
    url: img.imageUrl,
    prompt: `参考图 ${i + 1}`,
    alt: `参考图 ${i + 1}`,
  }))
  lightboxIndex.value = idx
  lightboxOpen.value = true
}

function previewOutput(url: string) {
  const outputs = selectedJob.value?.outputs || []
  lightboxImages.value = outputs.map((output) => ({
    url: output.url || output.imageUrl,
    prompt: taskTitle(),
    alt: taskTitle(),
  }))
  const index = outputs.findIndex((output) => (output.url || output.imageUrl) === url)
  lightboxIndex.value = Math.max(0, index)
  lightboxOpen.value = true
}

onMounted(async () => {
  await store.fetchJobs()
  if (!store.selectedJobId && store.jobs.length) {
    store.selectedJobId = store.jobs[0].id
  }

  pollTimer = setInterval(() => {
    const running = store.jobs.filter((job) => job.status === 'running' || job.status === 'queued' || job.status === 'retry_wait')
    running.forEach((job) => store.refreshJob(job.id))
  }, 3000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

async function cancelJob(id: string) {
  const res = await store.cancelJob(id)
  toast(res?.success ? '任务已取消' : res?.error?.message || '取消失败', res?.success ? 'success' : 'error')
}

async function retryJob(id: string) {
  const res = await store.retryJob(id)
  toast(res?.success ? '任务已重新进入队列' : res?.error?.message || '重试失败', res?.success ? 'success' : 'error')
}

function requestDelete(id: string) {
  deleteTarget.value = id
  showDeleteConfirm.value = true
}

async function confirmDelete() {
  if (deleteTarget.value) {
    const res = await store.deleteJob(deleteTarget.value)
    if (!res?.success) toast(res?.error?.message || '删除失败', 'error')
  }
  showDeleteConfirm.value = false
  deleteTarget.value = null
}

async function copyFinalPrompt() {
  if (!selectedJob.value?.finalPrompt) return
  await navigator.clipboard.writeText(selectedJob.value.finalPrompt)
  toast('最终提示词已复制', 'success')
}

function reuseFinalPrompt() {
  if (!selectedJob.value?.finalPrompt) return
  store.prompt = selectedJob.value.finalPrompt
  store.selectedJobId = null
  toast('最终提示词已带入编辑器', 'success')
}

async function selectJob(id: string) {
  store.selectedJobId = id
  await store.refreshJob(id)
}

function taskTitle() {
  return selectedJob.value?.title || selectedJob.value?.inputPrompt || selectedJob.value?.prompt || '任务详情'
}
</script>

<template>
  <div class="flex h-full w-full">
    <!-- Sidebar -->
    <aside class="hidden w-80 shrink-0 flex-col border-r border-border bg-surface lg:flex">
      <div class="flex h-14 items-center justify-between border-b border-border px-4">
        <span class="text-sm font-medium text-foreground">历史任务</span>
        <span class="text-xs tabular-nums text-muted-foreground">{{ store.jobs.length }} 条</span>
      </div>

      <div class="flex-1 overflow-auto">
        <div v-if="store.jobs.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
          暂无任务
        </div>
        <JobListItem
          v-for="job in store.jobs"
          :key="job.id"
          :job="job"
          :selected="store.selectedJobId === job.id"
          @select="selectJob"
        />
      </div>

      <div class="shrink-0 border-t border-border p-4">
        <BaseButton to="/generate" variant="secondary" class="w-full">
          去生成
        </BaseButton>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex min-w-0 flex-1 flex-col gap-6 overflow-auto bg-canvas p-4 lg:p-6">
      <PageHeader
        title="历史任务"
        description="查看历史任务、预览结果、复制最终提示词并带入编辑器。"
      >
        <template #actions>
          <BaseButton to="/generate" variant="secondary" size="md">
            新建任务
          </BaseButton>
        </template>
      </PageHeader>

      <!-- Mobile list -->
      <div v-if="store.jobs.length" class="grid gap-2 rounded-[var(--radius-card)] border border-border bg-surface p-3 lg:hidden">
        <button
          v-for="job in store.jobs"
          :key="job.id"
          type="button"
          :class="
            cn(
              'flex items-center gap-3 rounded-[var(--radius-control)] border border-border px-3 py-2 text-left transition-colors hover:bg-surface-subtle',
              store.selectedJobId === job.id && 'border-accent bg-accent-soft',
            )
          "
          @click="selectJob(job.id)"
        >
          <div class="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)] bg-surface-subtle">
            <video
              v-if="job.outputs.length && job.outputs[0].mediaKind === 'video'"
              :src="job.outputs[0].url || job.outputs[0].imageUrl"
              preload="metadata"
              muted
              playsinline
              class="h-full w-full object-cover"
            />
            <img
              v-else-if="job.outputs.length"
              :src="job.outputs[0].url || job.outputs[0].imageUrl"
              class="h-full w-full object-cover"
              loading="lazy"
            />
            <ImageIcon v-else class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-foreground">{{ job.title || job.inputPrompt || job.prompt || '无提示词' }}</p>
            <div class="mt-1 flex items-center gap-2">
              <StatusBadge :status="job.status" />
              <span class="font-mono text-xs tabular-nums text-muted-foreground">{{ new Date(job.createdAt).toLocaleDateString('zh-CN') }}</span>
            </div>
          </div>
        </button>
      </div>

      <EmptyState
        v-if="!selectedJob && store.jobs.length === 0"
        kind="first-use"
        title="还没有任务"
        description="先去生成一个任务，历史列表会自动在这里显示。"
        action-label="去创作"
        @action="$router.push('/generate')"
      />

      <section v-if="selectedJob" class="space-y-4">
        <div v-if="selectedJob.outputs.length" class="p-0">
          <div
            v-if="selectedJob.outputs.length === 1"
            class="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-subtle"
          >
            <video
              v-if="selectedJob.outputs[0].mediaKind === 'video'"
              :src="selectedJob.outputs[0].url || selectedJob.outputs[0].imageUrl"
              :poster="selectedJob.outputs[0].mediaKind === 'video' ? (selectedJob.outputs[0] as any).metadata?.posterUrl : undefined"
              controls
              preload="metadata"
              playsinline
              class="max-h-[60vh] w-full bg-overlay"
            />
            <button
              v-else
              type="button"
              class="block w-full cursor-zoom-in"
              :aria-label="`放大查看：${taskTitle()}`"
              @click="previewOutput(selectedJob.outputs[0].url || selectedJob.outputs[0].imageUrl)"
            >
              <img
                :src="selectedJob.outputs[0].url || selectedJob.outputs[0].imageUrl"
                :alt="taskTitle()"
                class="h-auto max-h-[60vh] w-full object-contain"
                loading="lazy"
              />
            </button>
          </div>
          <div v-else class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div
              v-for="output in selectedJob.outputs"
              :key="output.id"
              class="group relative flex aspect-square items-center justify-center overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-subtle text-left"
            >
              <video
                v-if="output.mediaKind === 'video'"
                :src="output.url || output.imageUrl"
                :poster="output.mediaKind === 'video' ? (output as any).metadata?.posterUrl : undefined"
                controls
                preload="metadata"
                playsinline
                class="h-full w-full bg-overlay"
              />
              <button
                v-else
                type="button"
                class="flex h-full w-full cursor-zoom-in items-center justify-center"
                :aria-label="`放大查看：${taskTitle()}`"
                @click="previewOutput(output.url || output.imageUrl)"
              >
                <img :src="output.url || output.imageUrl" :alt="taskTitle()" class="h-full w-full object-contain" loading="lazy" />
              </button>
              <span v-if="output.mediaKind === 'video'" class="absolute left-2 top-2 rounded-[var(--radius-control)] bg-overlay/70 px-1.5 py-0.5 text-xs font-medium text-foreground-inverse">视频</span>
            </div>
          </div>
        </div>

        <div
          v-else-if="canCancelJob(selectedJob.status) || selectedJob.status === 'running'"
          class="flex min-h-72 items-center justify-center p-6 text-center"
          role="status"
          aria-atomic="true"
        >
          <div class="flex flex-col items-center gap-3">
            <Loader2 class="h-8 w-8 animate-spin text-accent" aria-hidden="true" />
            <span class="text-sm text-muted-foreground">
              {{ selectedJob.status === 'queued' ? '排队中...' : phaseLabel(selectedJob.phase) }}
            </span>
            <BaseButton
              v-if="canCancelJob(selectedJob.status)"
              variant="secondary"
              @click="cancelJob(selectedJob.id)"
            >
              <XCircle class="h-4 w-4" aria-hidden="true" />
              取消任务
            </BaseButton>
          </div>
        </div>

        <div v-else-if="selectedJob.status === 'failed'" class="flex min-h-72 flex-col items-center justify-center gap-3 p-6 text-center" role="status">
          <XCircle class="h-8 w-8 text-danger" aria-hidden="true" />
          <span class="text-sm text-foreground">{{ selectedJob.phase === 'template_failed' || selectedJob.phase === 'optimization_failed' ? '提示词优化服务暂时不可用，请稍后重试' : '生成失败' }}</span>
          <span v-if="selectedJob.errorCode" class="font-mono text-xs text-muted-foreground">
            {{ selectedJob.errorCode }}
          </span>
          <BaseButton variant="primary" @click="retryJob(selectedJob.id)">
            <RefreshCw class="h-4 w-4" aria-hidden="true" />
            重试任务
          </BaseButton>
        </div>

        <div v-else-if="selectedJob.status === 'canceled'" class="flex min-h-72 flex-col items-center justify-center gap-3 p-6 text-center" role="status">
          <XCircle class="h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <span class="text-sm text-muted-foreground">任务已取消</span>
        </div>

        <div v-else class="flex min-h-72 items-center justify-center p-6 text-sm text-muted-foreground">
          任务已完成，结果会保留在这里。
        </div>

        <!-- Status & Actions -->
        <div class="rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <StatusBadge :status="selectedJob.status" />
              <span class="font-mono text-xs tabular-nums text-muted-foreground">{{ new Date(selectedJob.createdAt).toLocaleString('zh-CN') }}</span>
            </div>
            <div class="flex flex-wrap gap-2">
              <BaseButton
                v-if="selectedJob.status === 'failed'"
                variant="primary"
                size="sm"
                @click="retryJob(selectedJob.id)"
              >
                <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
                重试
              </BaseButton>
              <BaseButton
                v-if="canCancelJob(selectedJob.status)"
                variant="secondary"
                size="sm"
                @click="cancelJob(selectedJob.id)"
              >
                <XCircle class="h-3.5 w-3.5" aria-hidden="true" />
                取消
              </BaseButton>
              <BaseButton variant="danger-ghost" size="sm" @click="requestDelete(selectedJob.id)">
                <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                删除
              </BaseButton>
            </div>
          </div>
        </div>

        <!-- Metadata -->
        <div class="rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <h3 class="mb-3 text-sm font-medium text-foreground">任务信息</h3>
          <div class="flex flex-wrap gap-2">
            <span class="inline-flex items-center rounded-full border border-border bg-surface-subtle px-2.5 py-1 text-xs text-muted-foreground">
              {{ selectedJob.modelName }}
            </span>
            <span class="inline-flex items-center rounded-full border border-border bg-surface-subtle px-2.5 py-1 text-xs tabular-nums text-muted-foreground">
              {{ selectedJob.size }}
            </span>
            <span v-if="selectedJob.quality" class="inline-flex items-center rounded-full border border-border bg-surface-subtle px-2.5 py-1 text-xs capitalize text-muted-foreground">
              {{ selectedJob.quality }}
            </span>
            <span class="inline-flex items-center rounded-full border border-border bg-surface-subtle px-2.5 py-1 text-xs tabular-nums text-muted-foreground">
              {{ selectedJob.count }} 张
            </span>
            <span v-if="selectedJob.durationMs" class="inline-flex items-center rounded-full border border-border bg-surface-subtle px-2.5 py-1 text-xs tabular-nums text-muted-foreground">
              {{ (selectedJob.durationMs / 1000).toFixed(1) }}s
            </span>
            <span v-if="selectedJob.templateName" class="inline-flex items-center rounded-full border border-border bg-surface-subtle px-2.5 py-1 text-xs text-muted-foreground">
              {{ selectedJob.templateName }}
            </span>
          </div>
        </div>

        <!-- Reference Images (Input Images) -->
        <div v-if="selectedJob.inputImages && selectedJob.inputImages.length > 0" class="rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <div class="mb-3 flex items-center justify-between">
            <h3 class="text-sm font-medium text-foreground">输入参考图 ({{ selectedJob.inputImages.length }})</h3>
            <span class="text-xs text-muted-foreground">点击预览大图</span>
          </div>
          <div class="flex flex-wrap gap-2.5">
            <button
              v-for="(img, idx) in selectedJob.inputImages"
              :key="img.id || idx"
              type="button"
              class="relative h-16 w-16 cursor-zoom-in overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface-subtle transition-colors hover:border-border-control"
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
                class="pointer-events-none absolute left-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-overlay/70 text-xs font-medium tabular-nums text-foreground-inverse"
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

        <!-- Prompt -->
        <div class="rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <button
            type="button"
            class="flex w-full items-center justify-between"
            :aria-expanded="showPromptDetail"
            aria-controls="history-prompt-detail"
            @click="showPromptDetail = !showPromptDetail"
          >
            <h3 class="text-sm font-medium text-foreground">提示词</h3>
            <component :is="showPromptDetail ? 'ChevronUp' : 'ChevronDown'" class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </button>

          <div v-if="showPromptDetail" id="history-prompt-detail" class="mt-4 space-y-4">
            <div>
              <p class="mb-1 text-xs font-medium text-muted-foreground">原始提示词</p>
              <p class="whitespace-pre-wrap rounded-[var(--radius-card)] border border-border bg-surface-subtle px-3 py-2.5 text-sm leading-[1.59] text-foreground">
                {{ selectedJob.inputPrompt || selectedJob.prompt }}
              </p>
            </div>

            <div v-if="selectedJob.canReadFinalPrompt && selectedJob.finalPrompt">
              <div class="flex items-center justify-between">
                <p class="mb-1 text-xs font-medium text-muted-foreground">最终提示词</p>
                <BaseButton variant="secondary" size="sm" @click="copyFinalPrompt">
                  <Copy class="h-3 w-3" aria-hidden="true" />
                  复制
                </BaseButton>
              </div>
              <p class="mt-1 whitespace-pre-wrap rounded-[var(--radius-card)] border border-border bg-surface-subtle px-3 py-2.5 text-sm leading-[1.59] text-foreground">
                {{ selectedJob.finalPrompt }}
              </p>
            </div>

            <p v-else-if="finalPromptNotice" class="text-xs text-muted-foreground">
              {{ finalPromptNotice }}
            </p>

            <BaseButton
              v-if="selectedJob.canReadFinalPrompt && selectedJob.finalPrompt"
              variant="secondary"
              size="sm"
              @click="reuseFinalPrompt"
            >
              带入编辑器
            </BaseButton>
          </div>
        </div>
      </section>

      <div v-else class="flex min-h-[320px] items-center justify-center rounded-[var(--radius-panel)] border border-border bg-surface px-6 text-center">
        <div class="max-w-sm">
          <p class="text-sm font-medium text-foreground">请选择一个历史任务</p>
          <p class="mt-1 text-xs text-muted-foreground">点击左侧列表中的任务即可查看预览、详情和可用操作。</p>
        </div>
      </div>
    </main>
  </div>

  <Lightbox
    :images="lightboxImages"
    v-model:open="lightboxOpen"
    v-model="lightboxIndex"
  />

  <ConfirmDialog
    v-model:open="showDeleteConfirm"
    title="删除任务"
    description="此操作会将任务从历史记录中移除，正在处理的任务会被取消。"
    confirm-text="删除"
    variant="danger"
    @confirm="confirmDelete"
  />
</template>