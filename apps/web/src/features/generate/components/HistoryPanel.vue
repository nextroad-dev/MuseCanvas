<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useGenerationStore } from '@/features/generate/stores/generation'
import StatusBadge from '@/shared/components/ui/StatusBadge.vue'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import EmptyState from '@/shared/components/ui/EmptyState.vue'
import JobListItem from '@/shared/components/jobs/JobListItem.vue'
import Lightbox from '@/shared/components/ui/Lightbox.vue'
import {
  Loader2, RefreshCw, XCircle, Image as ImageIcon, Trash2, Copy,
} from 'lucide-vue-next'
import { canCancelJob, phaseLabel } from '@/shared/lib/job'
import { cn } from '@/shared/lib/utils'
import { toast } from '@/shared/composables/useToast'

const store = useGenerationStore()
const deleteTarget = ref<string | null>(null)
const showDeleteConfirm = ref(false)
const showPromptDetail = ref(false)
const lightboxIndex = ref(-1)
let pollTimer: ReturnType<typeof setInterval> | null = null

const selectedJob = computed(() => store.selectedJob)
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

function previewOutput(url: string) {
  const index = selectedJob.value?.outputs.findIndex(o => o.imageUrl === url) ?? -1
  if (index >= 0) lightboxIndex.value = index
}

function taskTitle() {
  return selectedJob.value?.title || selectedJob.value?.inputPrompt || selectedJob.value?.prompt || '任务详情'
}
</script>

<template>
  <div class="flex h-full w-full">
    <!-- Sidebar: task list -->
    <aside class="hidden w-72 shrink-0 flex-col border-r border-border bg-surface lg:flex">
      <div class="flex h-12 items-center justify-between border-b border-border px-4">
        <span class="text-sm font-medium text-foreground">历史任务</span>
        <span class="text-xs text-muted-foreground">{{ store.jobs.length }} 条</span>
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
    </aside>

    <!-- Main content: task detail -->
    <main class="flex min-w-0 flex-1 flex-col gap-4 overflow-auto bg-canvas p-4 lg:p-6">
      <h2 class="text-lg font-semibold text-foreground lg:hidden">历史任务</h2>

      <!-- Mobile list -->
      <div v-if="store.jobs.length" class="grid gap-2 rounded-[var(--radius-card)] border border-border bg-surface p-3 shadow-sm lg:hidden">
        <button
          v-for="job in store.jobs"
          :key="job.id"
          type="button"
          :class="
            cn(
              'flex items-center gap-3 rounded-[var(--radius-card)] border border-border px-3 py-2 text-left transition-colors hover:bg-surface-subtle',
              store.selectedJobId === job.id && 'border-primary bg-primary-soft',
            )
          "
          @click="selectJob(job.id)"
        >
          <div class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)] bg-surface-subtle">
            <img
              v-if="job.outputs.length"
              :src="job.outputs[0].imageUrl"
              class="h-full w-full object-cover"
              loading="lazy"
            />
            <ImageIcon v-else class="h-4 w-4 text-muted-foreground" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-foreground">{{ job.title || job.inputPrompt || job.prompt || '无提示词' }}</p>
            <div class="mt-1 flex items-center gap-2">
              <StatusBadge :status="job.status" />
              <span class="text-[10px] text-muted-foreground">{{ new Date(job.createdAt).toLocaleDateString('zh-CN') }}</span>
            </div>
          </div>
        </button>
      </div>

      <EmptyState
        v-if="!selectedJob && store.jobs.length === 0"
        title="还没有任务"
        description="去生成一个任务，历史列表会自动在这里显示。"
      />

      <!-- Detail -->
      <template v-else-if="selectedJob">
        <!-- Image area -->
        <div class="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface shadow-sm">
          <div v-if="selectedJob.outputs.length" class="p-4">
            <div
              v-if="selectedJob.outputs.length === 1"
              class="flex justify-center rounded-[var(--radius-card)]"
            >
              <img
                :src="selectedJob.outputs[0].imageUrl"
                :alt="taskTitle()"
                class="h-auto w-auto max-h-[50vh] max-w-full cursor-pointer rounded-[var(--radius-card)] object-contain"
                loading="lazy"
                @click="previewOutput(selectedJob.outputs[0].imageUrl)"
              />
            </div>
            <div v-else class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <button
                v-for="output in selectedJob.outputs"
                :key="output.id"
                type="button"
                class="overflow-hidden rounded-[var(--radius-card)] bg-surface-subtle text-left transition-shadow hover:shadow-sm"
                @click="previewOutput(output.imageUrl)"
              >
                <img :src="output.imageUrl" :alt="taskTitle()" class="h-full w-full object-contain" loading="lazy" />
              </button>
            </div>
          </div>

          <div v-else-if="canCancelJob(selectedJob.status) || selectedJob.status === 'running'" class="flex min-h-48 items-center justify-center p-6 text-center">
            <div class="flex flex-col items-center gap-3">
              <Loader2 class="h-8 w-8 animate-spin text-primary" />
              <span class="text-sm text-muted-foreground">
                {{ selectedJob.status === 'queued' ? '排队中...' : phaseLabel(selectedJob.phase) }}
              </span>
              <button
                v-if="canCancelJob(selectedJob.status)"
                class="inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle"
                @click="cancelJob(selectedJob.id)"
              >
                <XCircle class="h-4 w-4" />
                取消任务
              </button>
            </div>
          </div>

          <div v-else-if="selectedJob.status === 'failed'" class="flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center">
            <XCircle class="h-8 w-8 text-danger" />
            <span class="text-sm text-foreground">{{ selectedJob.phase === 'template_failed' || selectedJob.phase === 'optimization_failed' ? '提示词优化服务暂时不可用，请稍后重试' : '生成失败' }}</span>
            <span v-if="selectedJob.errorCode" class="text-xs text-muted-foreground">
              {{ selectedJob.errorCode }}
            </span>
            <button
              class="inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
              @click="retryJob(selectedJob.id)"
            >
              <RefreshCw class="h-4 w-4" />
              重试任务
            </button>
          </div>

          <div v-else-if="selectedJob.status === 'canceled'" class="flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center">
            <XCircle class="h-8 w-8 text-muted-foreground" />
            <span class="text-sm text-muted-foreground">任务已取消</span>
          </div>

          <div v-else class="flex min-h-48 items-center justify-center p-6 text-sm text-muted-foreground">
            任务已完成，结果会保留在这里。
          </div>
        </div>

        <!-- Status & Actions -->
        <div class="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <StatusBadge :status="selectedJob.status" />
              <span class="text-sm text-muted-foreground">{{ new Date(selectedJob.createdAt).toLocaleString('zh-CN') }}</span>
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                v-if="selectedJob.status === 'failed'"
                class="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
                @click="retryJob(selectedJob.id)"
              >
                <RefreshCw class="h-3.5 w-3.5" />
                重试
              </button>
              <button
                v-if="canCancelJob(selectedJob.status)"
                class="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-subtle"
                @click="cancelJob(selectedJob.id)"
              >
                <XCircle class="h-3.5 w-3.5" />
                取消
              </button>
              <button
                class="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-red-200 px-3 text-xs font-medium text-danger transition-colors hover:bg-danger-soft"
                @click="requestDelete(selectedJob.id)"
              >
                <Trash2 class="h-3.5 w-3.5" />
                删除
              </button>
            </div>
          </div>
        </div>

        <!-- Metadata -->
        <div class="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-sm">
          <h3 class="mb-3 text-sm font-semibold text-foreground">任务信息</h3>
          <div class="flex flex-wrap gap-2">
            <span class="inline-flex items-center rounded-full border border-border bg-surface-subtle px-2.5 py-1 text-xs text-muted-foreground">
              {{ selectedJob.modelName }}
            </span>
            <span class="inline-flex items-center rounded-full border border-border bg-surface-subtle px-2.5 py-1 text-xs text-muted-foreground">
              {{ selectedJob.size }}
            </span>
            <span v-if="selectedJob.quality" class="inline-flex items-center rounded-full border border-border bg-surface-subtle px-2.5 py-1 text-xs text-muted-foreground capitalize">
              {{ selectedJob.quality }}
            </span>
            <span class="inline-flex items-center rounded-full border border-border bg-surface-subtle px-2.5 py-1 text-xs text-muted-foreground">
              {{ selectedJob.count }} 张
            </span>
            <span v-if="selectedJob.durationMs" class="inline-flex items-center rounded-full border border-border bg-surface-subtle px-2.5 py-1 text-xs text-muted-foreground">
              {{ (selectedJob.durationMs / 1000).toFixed(1) }}s
            </span>
            <span v-if="selectedJob.templateName" class="inline-flex items-center rounded-full border border-border bg-surface-subtle px-2.5 py-1 text-xs text-muted-foreground">
              {{ selectedJob.templateName }}
            </span>
          </div>
        </div>

        <!-- Prompt -->
        <div class="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-sm">
          <button
            class="flex w-full items-center justify-between"
            @click="showPromptDetail = !showPromptDetail"
          >
            <h3 class="text-sm font-semibold text-foreground">提示词</h3>
            <component :is="showPromptDetail ? 'ChevronUp' : 'ChevronDown'" class="h-4 w-4 text-muted-foreground" />
          </button>

          <div v-if="showPromptDetail" class="mt-4 space-y-4">
            <div>
              <label class="mb-1 block text-xs font-medium text-muted-foreground">原始提示词</label>
              <p class="rounded-[var(--radius-card)] border border-border bg-surface-subtle px-3 py-2.5 text-sm whitespace-pre-wrap text-foreground">
                {{ selectedJob.inputPrompt || selectedJob.prompt }}
              </p>
            </div>

            <div v-if="selectedJob.canReadFinalPrompt && selectedJob.finalPrompt">
              <div class="flex items-center justify-between">
                <label class="mb-1 block text-xs font-medium text-muted-foreground">最终提示词</label>
                <div class="flex gap-2">
                  <button class="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-surface-subtle" @click="copyFinalPrompt">
                    <Copy class="h-3 w-3" />
                    复制
                  </button>
                </div>
              </div>
              <p class="mt-1 rounded-[var(--radius-card)] border border-border bg-surface-subtle px-3 py-2.5 text-sm whitespace-pre-wrap text-foreground">
                {{ selectedJob.finalPrompt }}
              </p>
            </div>

            <p v-else-if="finalPromptNotice" class="text-xs text-muted-foreground">
              {{ finalPromptNotice }}
            </p>

            <button
              v-if="selectedJob.canReadFinalPrompt && selectedJob.finalPrompt"
              class="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-subtle"
              @click="reuseFinalPrompt"
            >
              带入编辑器
            </button>
          </div>
        </div>
      </template>

      <div v-else class="flex min-h-[320px] items-center justify-center rounded-[var(--radius-panel)] border border-dashed border-border bg-surface px-6 text-center shadow-sm">
        <div class="max-w-sm">
          <p class="text-sm font-medium text-foreground">请选择一个历史任务</p>
          <p class="mt-1 text-xs text-muted-foreground">点击左侧列表中的任务即可查看预览、详情和可用操作。</p>
        </div>
      </div>
    </main>

    <Lightbox
      :images="selectedJob?.outputs.map(o => ({ url: o.imageUrl, prompt: selectedJob?.inputPrompt || selectedJob?.prompt || '' })) || []"
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
  </div>
</template>
