<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useGenerationStore } from '@/features/generate/stores/generation'
import { Image as ImageIcon, PanelLeftOpen, PanelLeftClose } from 'lucide-vue-next'
import IdleConsole from '@/features/generate/components/IdleConsole.vue'
import FlowLinesBg from '@/shared/components/FlowLinesBg.vue'
import GeneratingView from '@/features/generate/components/GeneratingView.vue'
import ResultView from '@/features/generate/components/ResultView.vue'
import HistoryDetailView from '@/features/generate/components/HistoryDetailView.vue'
import JobListItem from '@/shared/components/jobs/JobListItem.vue'
import JobDetailPanel from '@/shared/components/jobs/JobDetailPanel.vue'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import { toast } from '@/shared/composables/useToast'
import Lightbox from '@/shared/components/ui/Lightbox.vue'
import { useJobPolling } from '@/shared/composables/useJobPolling'
import type { GenerationJob } from '@/shared/types'

type ViewState = 'idle' | 'generating' | 'result'

const store = useGenerationStore()
const viewState = ref<ViewState>('idle')
const previewAsset = ref<{ url: string; prompt: string } | null>(null)
const historyCollapsed = ref(true)
const detailJobId = ref<string | null>(null)
const deleteTargetJobId = ref<string | null>(null)
const deleteConfirmOpen = ref(false)

const selectedJob = computed(() => store.selectedJob)
const detailJob = computed(() => store.jobs.find((j) => j.id === detailJobId.value) || null)
const polling = useJobPolling(() => store.jobs, (id) => store.refreshJob(id))

// Active generation takes priority; otherwise an inspected history job shows in
// the main area, then the generation result, then the idle console.
const mainView = computed<'idle' | 'generating' | 'result' | 'detail'>(() => {
  if (viewState.value === 'generating') return 'generating'
  if (detailJob.value) return 'detail'
  if (viewState.value === 'result' && selectedJob.value) return 'result'
  return 'idle'
})

async function handleGenerate() {
  const res = await store.createJob()
  if (!res?.success) {
    toast(res?.error?.message || '生成失败，请检查模型参数或供应商配置', 'error')
    return
  }
  detailJobId.value = null
  viewState.value = 'generating'
  polling.restart()
}

async function handleCancel() {
  const job = store.selectedJob
  if (!job) return
  if (job.status === 'queued' || job.status === 'retry_wait') {
    const res = await store.cancelJob(job.id)
    toast(res?.success ? '任务已取消' : res?.error?.message || '取消失败', res?.success ? 'success' : 'error')
  }
  viewState.value = 'idle'
  store.selectedJobId = null
}

async function handleRetry() {
  const job = store.selectedJob
  if (!job) return
  const res = await store.retryJob(job.id)
  if (res?.success) {
    viewState.value = 'generating'
    polling.restart()
  } else {
    toast(res?.error?.message || '重试失败', 'error')
  }
}

async function handleRetryFromDetail() {
  const job = detailJob.value
  if (!job) return
  const res = await store.retryJob(job.id)
  if (res?.success) {
    detailJobId.value = null
    viewState.value = 'generating'
    polling.restart()
  } else {
    toast(res?.error?.message || '重试失败', 'error')
  }
}

function handleNewGeneration() {
  viewState.value = 'idle'
  store.selectedJobId = null
  detailJobId.value = null
}

function handleReusePrompt(kind: 'original' | 'optimized') {
  const job = detailJob.value
  if (job) {
    store.prompt = kind === 'optimized' && job.finalPrompt
      ? job.finalPrompt
      : job.inputPrompt || job.prompt || ''
    toast(kind === 'optimized' ? '已复用优化后的提示词' : '已复用原提示词', 'success')
  }
  viewState.value = 'idle'
  store.selectedJobId = null
  detailJobId.value = null
}

function handleDownload(url: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = `musecanvas-${Date.now()}.png`
  a.click()
}

function handlePreview(url: string, prompt: string) {
  previewAsset.value = { url, prompt }
}

function handleSelectJob(job: GenerationJob) {
  detailJobId.value = job.id
  historyCollapsed.value = false
}

function toggleHistory() {
  const nextCollapsed = !historyCollapsed.value
  historyCollapsed.value = nextCollapsed
  if (nextCollapsed) detailJobId.value = null
}

function closeDetailPanel() {
  detailJobId.value = null
  historyCollapsed.value = true
}

function goToIdle() {
  viewState.value = 'idle'
  store.selectedJobId = null
}

function requestDeleteJob() {
  const job = detailJob.value
  if (!job) return
  deleteTargetJobId.value = job.id
  deleteConfirmOpen.value = true
}

async function confirmDeleteJob() {
  const id = deleteTargetJobId.value
  if (!id) return

  const res = await store.deleteJob(id)
  if (res?.success) {
    if (detailJobId.value === id) detailJobId.value = null
    if (store.selectedJobId === id) {
      store.selectedJobId = null
      viewState.value = 'idle'
    }
    toast('任务已删除', 'success')
  } else {
    toast(res?.error?.message || '删除失败', 'error')
  }
  deleteTargetJobId.value = null
}

watch(
  () => store.selectedJob?.status,
  (newStatus) => {
    const job = store.selectedJob
    if (!job) return

    if (viewState.value === 'generating') {
      if (newStatus === 'succeeded') {
        viewState.value = 'result'
      } else if (newStatus === 'failed') {
        toast('生成失败', 'error')
        viewState.value = 'result'
      } else if (newStatus === 'canceled') {
        toast('任务已取消', 'info')
        goToIdle()
      }
    }
  }
)

onMounted(async () => {
  await store.fetchModels()
  await store.fetchJobs()
  polling.start()
})
</script>

<template>
  <div class="relative flex h-full w-full">
    <h1 class="sr-only">创作</h1>

    <!-- Expand history button -->
    <button
      v-if="historyCollapsed"
      class="absolute left-4 top-4 z-30 hidden items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-surface-subtle lg:inline-flex"
      @click="toggleHistory"
    >
      <PanelLeftOpen class="h-4 w-4" />
      历史记录
    </button>

    <!-- Left sidebar: History -->
    <div
      class="shrink-0 overflow-hidden transition-all duration-300 ease-in-out"
      :class="historyCollapsed ? 'w-0' : 'w-[300px]'"
    >
      <aside class="flex h-full w-[300px] flex-col border-r border-border/60 bg-surface">
        <div class="flex h-12 items-center justify-between border-b border-border/60 px-4">
          <span class="text-sm font-medium text-foreground">历史记录</span>
          <div class="flex items-center gap-2">
            <span class="text-xs text-muted-foreground">{{ store.jobs.length }} 条</span>
            <button
              class="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
              @click="toggleHistory"
            >
              <PanelLeftClose class="h-4 w-4" />
            </button>
          </div>
        </div>

        <div class="flex-1 overflow-auto">
          <div v-if="store.jobs.length === 0" class="flex flex-col items-center justify-center px-4 py-16 text-center">
            <ImageIcon class="h-8 w-8 text-muted-foreground/50" />
            <p class="mt-3 text-sm font-medium text-foreground">还没有生成记录</p>
            <p class="mt-1 text-xs text-muted-foreground">开始创作后，结果会出现在这里</p>
          </div>
          <JobListItem
            v-for="job in store.jobs"
            :key="job.id"
            :job="job"
            :selected="detailJobId === job.id"
            @select="handleSelectJob(job)"
          />
        </div>
      </aside>
    </div>

    <!-- Main content area -->
    <main class="relative flex min-h-0 flex-1 flex-col overflow-auto bg-surface-dark">
      <FlowLinesBg />
      <div class="relative z-10 flex w-full flex-col items-start pt-[18vh]">
        <!-- Idle state -->
        <Transition
          enter-active-class="transition-all duration-500 ease-out"
          enter-from-class="opacity-0 translate-y-4"
          enter-to-class="opacity-100 translate-y-0"
          leave-active-class="transition-all duration-300 ease-in"
          leave-from-class="opacity-100 translate-y-0"
          leave-to-class="opacity-0 -translate-y-4"
        >
          <div v-if="mainView === 'idle'" class="flex w-full justify-center">
            <IdleConsole @generate="handleGenerate" />
          </div>
        </Transition>

        <!-- Generating state -->
        <Transition
          enter-active-class="transition-all duration-500 ease-out"
          enter-from-class="opacity-0 scale-95"
          enter-to-class="opacity-100 scale-100"
          leave-active-class="transition-all duration-300 ease-in"
          leave-from-class="opacity-100 scale-100"
          leave-to-class="opacity-0 scale-95"
        >
          <div v-if="mainView === 'generating'" class="flex w-full justify-center">
            <GeneratingView @cancel="handleCancel" />
          </div>
        </Transition>

        <!-- History detail state -->
        <Transition
          enter-active-class="transition-all duration-500 ease-out"
          enter-from-class="opacity-0 translate-y-4"
          enter-to-class="opacity-100 translate-y-0"
          leave-active-class="transition-all duration-300 ease-in"
          leave-from-class="opacity-100 translate-y-0"
          leave-to-class="opacity-0 -translate-y-4"
        >
          <div v-if="mainView === 'detail' && detailJob" class="flex w-full justify-center">
            <HistoryDetailView
              :job="detailJob"
              @preview="handlePreview"
            />
          </div>
        </Transition>

        <!-- Result state -->
        <Transition
          enter-active-class="transition-all duration-500 ease-out"
          enter-from-class="opacity-0 translate-y-6"
          enter-to-class="opacity-100 translate-y-0"
          leave-active-class="transition-all duration-300 ease-in"
          leave-from-class="opacity-100 translate-y-0"
          leave-to-class="opacity-0 -translate-y-6"
        >
          <div v-if="mainView === 'result' && selectedJob" class="flex w-full justify-center">
            <ResultView
              :job="selectedJob"
              @regenerate="handleRetry"
              @new-generation="handleNewGeneration"
              @download="handleDownload"
              @preview="handlePreview"
            />
          </div>
        </Transition>
      </div>
    </main>

    <!-- Right detail panel -->
    <div
      class="shrink-0 overflow-hidden transition-all duration-300 ease-in-out"
      :class="detailJob ? 'w-[320px]' : 'w-0'"
    >
      <aside class="flex h-full w-[320px] flex-col border-l border-border/60 bg-surface">
        <JobDetailPanel
          v-if="detailJob"
          :job="detailJob"
          @close="closeDetailPanel"
          @reuse-prompt="handleReusePrompt"
          @new-generation="handleNewGeneration"
          @retry="handleRetryFromDetail"
          @delete="requestDeleteJob"
        />
      </aside>
    </div>

    <ConfirmDialog
      v-model:open="deleteConfirmOpen"
      title="删除任务"
      description="此操作会将任务从历史记录中移除，正在处理的任务会被取消。"
      confirm-text="删除"
      variant="danger"
      @confirm="confirmDeleteJob"
    />

    <!-- Preview lightbox -->
    <Lightbox
      :images="previewAsset ? [{ url: previewAsset.url, prompt: previewAsset.prompt }] : []"
      :model-value="previewAsset ? 0 : -1"
      @update:model-value="previewAsset = null"
    />
  </div>
</template>
