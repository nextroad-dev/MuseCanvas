<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useGenerationStore } from '@/features/generate/stores/generation'
import { Brush, Clock, X, PanelLeftClose, PanelLeftOpen, Loader2 } from 'lucide-vue-next'
import IdleConsole from '@/features/generate/components/IdleConsole.vue'
import GeneratingView from '@/features/generate/components/GeneratingView.vue'
import ResultView from '@/features/generate/components/ResultView.vue'
import HistoryGallery from '@/features/generate/components/HistoryGallery.vue'
import JobDetailPanel from '@/shared/components/jobs/JobDetailPanel.vue'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import AppModal from '@/shared/components/ui/AppModal.vue'
import { toast } from '@/shared/composables/useToast'
import Lightbox from '@/shared/components/ui/Lightbox.vue'
import FlowLinesBg from '@/shared/components/FlowLinesBg.vue'
import MatrixBg from '@/shared/components/MatrixBg.vue'
import { useJobPolling } from '@/shared/composables/useJobPolling'
import type { GenerationJob } from '@/shared/types'
import { canCancelJob } from '@/shared/lib/job'

type ViewState = 'idle' | 'generating' | 'result'
type MobileTab = 'create' | 'history'

const store = useGenerationStore()
const viewState = ref<ViewState>('idle')
const previewAsset = ref<{ url: string; prompt: string } | null>(null)
const detailJobId = ref<string | null>(null)
const detailSheetOpen = ref(false)
const historyCollapsed = ref(false)
const mobileTab = ref<MobileTab>('create')

// Responsive
const windowWidth = ref(window.innerWidth)
function onResize() { windowWidth.value = window.innerWidth }
const isMobile = computed(() => windowWidth.value < 1024)

const deleteTargetJobId = ref<string | null>(null)
const deleteConfirmOpen = ref(false)
const updateLogOpen = ref(false)

const selectedJob = computed(() => store.selectedJob)
const detailJob = computed(() => store.jobs.find((j) => j.id === detailJobId.value) || null)
const polling = useJobPolling(() => store.jobs, (id) => store.refreshJob(id))
const selectedJobIsActive = computed(() => !!selectedJob.value && ['queued', 'running', 'retry_wait'].includes(selectedJob.value.status))

const mainView = computed<'idle' | 'generating' | 'result'>(() => {
  if (viewState.value === 'generating') return 'generating'
  if (viewState.value === 'result' && selectedJob.value) return 'result'
  return 'idle'
})

function jobFailureMessage(job: GenerationJob) {
  if (job.errorCode === 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR') return '提示词优化服务暂时不可用，请稍后重试'
  if (job.errorCode === 'PROMPT_OPTIMIZATION_REJECTED') return '提示词优化请求被拒绝，请调整提示词后重试'
  if (job.errorCode === 'PROMPT_MODEL_NOT_CONFIGURED') return '提示词优化模型配置不完整，请联系管理员'
  if (job.errorCode === 'PROVIDER_NOT_CONFIGURED') return '生图供应商凭据未配置，请联系管理员'
  if (job.errorCode === 'PROVIDER_BUSY') return '生成服务繁忙，系统已尝试自动重试'
  if (job.phase === 'optimization_failed') return '提示词优化暂时不可用，请稍后重试'
  if (job.phase === 'template_failed') return '提示词模板暂时不可用，请稍后重试'
  return '生成失败，请检查模型参数或稍后重试'
}

async function handleGenerate() {
  const res = await store.createJob()
  if (!res?.success) {
    toast(res?.error?.message || '生成失败，请检查模型参数或供应商配置', 'error')
    return
  }
  viewState.value = 'generating'
  polling.restart()
  // On mobile, switch to create tab so user sees progress
  mobileTab.value = 'create'
}

async function handleCancel() {
  const job = store.selectedJob
  if (!job) return
  if (canCancelJob(job.status)) {
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
    detailSheetOpen.value = false
    viewState.value = 'generating'
    polling.restart()
    mobileTab.value = 'create'
  } else {
    toast(res?.error?.message || '重试失败', 'error')
  }
}

function handleNewGeneration() {
  viewState.value = 'idle'
  store.selectedJobId = null
}

function handleReusePrompt(kind: 'original' | 'optimized') {
  const job = detailJob.value
  if (job) {
    store.prompt = kind === 'optimized' && job.finalPrompt
      ? job.finalPrompt
      : job.inputPrompt || job.prompt || ''
    toast(kind === 'optimized' ? '已复用优化后的提示词' : '已复用原提示词', 'success')
  }
  closeDetail()
  viewState.value = 'idle'
  store.selectedJobId = null
  // Navigate to create tab on mobile
  mobileTab.value = 'create'
}



function handlePreview(url: string, prompt: string) {
  previewAsset.value = { url, prompt }
}

async function handleSelectJob(job: GenerationJob) {
  detailJobId.value = job.id
  detailSheetOpen.value = true
  await store.refreshJob(job.id)
}

async function handleDownload(url: string) {
  try {
    const response = await fetch(url)
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    
    const filename = url.split('/').pop()?.split('?')[0] || `musecanvas-${Date.now()}.png`
    
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  } catch (error) {
    console.error('Failed to download image:', error)
    // Fallback to opening in new tab
    window.open(url, '_blank')
  }
}

function closeDetail() {
  detailJobId.value = null
  detailSheetOpen.value = false
}

function requestDeleteJob() {
  const job = detailJob.value
  if (!job) return
  deleteTargetJobId.value = job.id
  deleteConfirmOpen.value = true
}

function handleDeleteHistory(job: GenerationJob) {
  deleteTargetJobId.value = job.id
  deleteConfirmOpen.value = true
}

async function confirmDeleteJob() {
  const id = deleteTargetJobId.value
  if (!id) return
  const res = await store.deleteJob(id)
  if (res?.success) {
    if (detailJobId.value === id) closeDetail()
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
        toast(jobFailureMessage(job), 'error')
        viewState.value = 'result'
      } else if (newStatus === 'canceled') {
        toast('任务已取消', 'info')
        viewState.value = 'idle'
        store.selectedJobId = null
      }
    }
  }
)

onMounted(async () => {
  window.addEventListener('resize', onResize)
  await store.fetchModels()
  await store.fetchJobs()
  polling.start()
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div class="relative flex h-full w-full overflow-hidden">
    <h1 class="sr-only">创作</h1>

    <!-- ===== DESKTOP: Left history sidebar (≥ 1024px) ===== -->
    <aside
      v-if="!isMobile"
      class="flex h-full shrink-0 flex-col border-r border-border/60 bg-surface transition-all duration-300"
      :class="historyCollapsed ? 'w-[48px]' : 'w-[340px]'"
    >
      <!-- Collapsed State -->
      <template v-if="historyCollapsed">
        <div class="flex flex-1 flex-col items-center gap-3 overflow-y-auto py-4 no-scrollbar">
          <button
            v-for="job in store.jobs"
            :key="job.id"
            class="relative h-8 w-8 shrink-0 overflow-hidden rounded-[var(--radius-control)] border border-border/50 bg-surface-subtle transition-all hover:ring-2 hover:ring-primary/50"
            :class="{ 'ring-2 ring-primary': job.id === detailJobId }"
            :title="job.prompt"
            @click="handleSelectJob(job)"
          >
            <img
              v-if="job.outputs?.[0]?.imageUrl"
              :src="job.outputs[0].imageUrl"
              class="h-full w-full object-cover"
              loading="lazy"
            />
            <div v-else-if="job.status === 'running' || job.status === 'queued' || job.status === 'retry_wait'" class="flex h-full w-full items-center justify-center">
              <Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          </button>
        </div>
        <!-- Footer for collapsed -->
        <div class="flex h-12 shrink-0 items-center justify-center border-t border-border/60">
          <button
            class="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
            @click="historyCollapsed = false"
            title="展开"
          >
            <PanelLeftOpen class="h-4 w-4" />
          </button>
        </div>
      </template>

      <!-- Expanded State -->
      <template v-else>
        <!-- Sidebar header -->
        <div class="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-4">
          <span class="text-sm font-semibold text-foreground">历史画廊</span>
          <span
            v-if="store.jobs.length"
            class="text-xs text-muted-foreground"
          >
            {{ store.jobs.length }}
          </span>
        </div>

        <!-- Gallery scroll area -->
        <div class="flex-1 overflow-auto">
          <HistoryGallery
            :jobs="store.jobs"
            :selected-id="detailJobId"
            @select="handleSelectJob"
            @delete="handleDeleteHistory"
          />
        </div>

        <!-- Footer for expanded -->
        <div class="flex h-12 shrink-0 items-center justify-between border-t border-border/60 px-4">
            <button
              class="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
              @click="updateLogOpen = true"
              title="查看更新日志"
            >
              v2026.06.28
            </button>
          <button
            class="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
            @click="historyCollapsed = true"
            title="折叠"
          >
            <PanelLeftClose class="h-4 w-4" />
          </button>
        </div>
      </template>
    </aside>

    <!-- ===== Main creation work area ===== -->
    <main
      class="relative flex min-h-0 flex-1 flex-col overflow-auto bg-canvas"
      :class="isMobile && mobileTab === 'history' ? 'hidden' : ''"
    >
      <!-- Animated background layers -->
      <FlowLinesBg class="opacity-30" :density="0.5" :speed="0.25" :layers="3" :line-width="0.8" />
      <MatrixBg class="opacity-15" :grid-spacing="56" :dot-size="1" :line-opacity="0.04" :dot-opacity="0.14" :pulse-speed="0.4" :speed="0.4" />
      <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_15%,var(--color-primary-soft)_0%,transparent_38%),linear-gradient(to_bottom,var(--color-canvas)_0%,transparent_40%,var(--color-canvas)_100%)]" />

      <!-- Content -->
      <div
        class="relative z-10 flex w-full flex-1 flex-col items-center px-4 pb-24"
        :class="isMobile ? 'pt-6' : 'pt-[8vh]'"
      >
        <!-- Idle: prompt console (always shown unless generating OR result) -->
        <Transition
          enter-active-class="transition-all duration-500 ease-out"
          enter-from-class="opacity-0 translate-y-4"
          enter-to-class="opacity-100 translate-y-0"
          leave-active-class="transition-all duration-300 ease-in"
          leave-from-class="opacity-100 translate-y-0"
          leave-to-class="opacity-0 -translate-y-4"
        >
          <div v-if="mainView !== 'result'" class="flex w-full justify-center">
            <IdleConsole
              :generating="selectedJobIsActive"
              @generate="handleGenerate"
              @cancel="handleCancel"
            />
          </div>
        </Transition>

        <!-- Generating state -->
        <Transition
          enter-active-class="transition-all duration-500 ease-out"
          enter-from-class="opacity-0 translate-y-4"
          enter-to-class="opacity-100 translate-y-0"
          leave-active-class="transition-all duration-300 ease-in"
          leave-from-class="opacity-100 translate-y-0"
          leave-to-class="opacity-0 -translate-y-4"
        >
          <div v-if="mainView === 'generating' && selectedJob" class="mt-5 flex w-full justify-center">
            <GeneratingView @cancel="handleCancel" />
          </div>
        </Transition>

        <!-- Result state -->
        <Transition
          enter-active-class="transition-all duration-600 ease-out"
          enter-from-class="opacity-0 translate-y-6 scale-[0.98]"
          enter-to-class="opacity-100 translate-y-0 scale-100"
          leave-active-class="transition-all duration-300 ease-in"
          leave-from-class="opacity-100 translate-y-0"
          leave-to-class="opacity-0 -translate-y-4"
        >
          <div v-if="mainView === 'result' && selectedJob" class="flex w-full flex-col items-center">
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

    <!-- ===== MOBILE: History tab panel (< 1024px) ===== -->
    <div
      v-if="isMobile && mobileTab === 'history'"
      class="flex h-full flex-1 flex-col overflow-auto bg-canvas pb-16"
    >
      <div class="flex h-12 shrink-0 items-center border-b border-border/60 px-4">
        <span class="text-sm font-semibold text-foreground">历史画廊</span>
        <span
          v-if="store.jobs.length"
          class="ml-2 rounded-full bg-surface-subtle px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {{ store.jobs.length }}
        </span>
      </div>
      <div class="flex-1 overflow-auto">
        <HistoryGallery
          :jobs="store.jobs"
          :selected-id="detailJobId"
          @select="handleSelectJob"
        />
      </div>
    </div>

    <!-- ===== MOBILE: Bottom Tab Bar (< 1024px) ===== -->
    <nav
      v-if="isMobile"
      class="fixed bottom-0 left-0 right-0 z-30 flex items-center border-t border-border/60 bg-surface/90 backdrop-blur-md"
      style="padding-bottom: env(safe-area-inset-bottom)"
    >
      <button
        class="flex flex-1 flex-col items-center gap-1 px-4 py-2.5 transition-colors"
        :class="mobileTab === 'create' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'"
        @click="mobileTab = 'create'"
      >
        <Brush class="h-5 w-5" />
        <span class="text-[10px] font-medium">创作</span>
      </button>
      <button
        class="relative flex flex-1 flex-col items-center gap-1 px-4 py-2.5 transition-colors"
        :class="mobileTab === 'history' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'"
        @click="mobileTab = 'history'"
      >
        <Clock class="h-5 w-5" />
        <span class="text-[10px] font-medium">历史</span>
        <!-- Active job indicator dot -->
        <span
          v-if="selectedJobIsActive"
          class="absolute right-6 top-2 h-2 w-2 rounded-full bg-primary"
        />
      </button>
    </nav>

    <!-- ===== Bottom Detail Sheet (both desktop & mobile) ===== -->
    <Transition
      enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-all duration-200 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="detailSheetOpen && detailJob"
        class="fixed inset-0 z-40 flex items-center justify-center p-4 md:p-6"
        @click.self="closeDetail"
      >
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/30 backdrop-blur-[2px]" @click="closeDetail" />

        <!-- Sheet panel -->
        <Transition
          enter-active-class="transition-all duration-300 ease-out"
          enter-from-class="translate-y-full opacity-0"
          enter-to-class="translate-y-0 opacity-100"
          leave-active-class="transition-all duration-200 ease-in"
          leave-from-class="translate-y-0 opacity-100"
          leave-to-class="translate-y-full opacity-0"
        >
          <div
            v-if="detailSheetOpen && detailJob"
            class="relative z-50 flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-xl md:rounded-2xl"
          >
            <!-- Sheet handle -->
            <div class="flex shrink-0 items-center justify-center pt-3 md:hidden">
              <div class="h-1 w-10 rounded-full bg-border" />
            </div>

            <!-- Sheet header -->
            <div class="flex shrink-0 items-center justify-between border-b border-border/60 px-5 py-3">
              <span class="text-sm font-semibold text-foreground">任务详情</span>
              <button
                class="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
                @click="closeDetail"
              >
                <X class="h-4 w-4" />
              </button>
            </div>

            <!-- Detail panel content -->
            <div class="flex-1 overflow-auto">
              <JobDetailPanel
                :job="detailJob"
                :hide-header="true"
                @close="closeDetail"
                @reuse-prompt="handleReusePrompt"
                @new-generation="handleNewGeneration"
                @retry="handleRetryFromDetail"
                @delete="requestDeleteJob"
                @download="handleDownload"
              />
            </div>
          </div>
        </Transition>
      </div>
    </Transition>

    <!-- Confirm delete dialog -->
    <ConfirmDialog
      v-model:open="deleteConfirmOpen"
      title="删除任务"
      description="此操作会将任务从历史记录中移除，正在处理的任务会被取消。"
      confirm-text="删除"
      variant="danger"
      @confirm="confirmDeleteJob"
    />

    <!-- Lightbox -->
    <Lightbox
      :images="previewAsset ? [{ url: previewAsset.url, prompt: previewAsset.prompt }] : []"
      :model-value="previewAsset ? 0 : -1"
      @update:model-value="previewAsset = null"
    />

    <AppModal
      v-model:open="updateLogOpen"
      title="更新日志 (v2026.06.28)"
      size="md"
    >
      <div class="space-y-4 text-sm text-foreground">
        <div>
          <h3 class="font-semibold text-base mb-2 text-foreground">v2026.06.28 更新</h3>
          <ul class="list-disc pl-5 space-y-1.5 text-muted-foreground">
            <li>多图生成支持一键「全部下载图片」，并优化了并发下载防拦截和自动重命名机制。</li>
            <li>任务详情面板顶部增加图片大尺寸预览区域，便于随时检视生成结果。</li>
          </ul>
        </div>
        <div>
          <h3 class="font-semibold text-base mb-2 text-foreground">v2026.06.27 极简升级</h3>
          <ul class="list-disc pl-5 space-y-1.5 text-muted-foreground">
            <li>历史画廊调整为底部横条式布局，支持折叠。</li>
            <li>各个组件大小放大，提升点击舒适度。</li>
            <li>移除多余前缀与形状提示，尺寸/模型选项仅保留必要信息。</li>
            <li>生成按钮移除冗余图标，界面更加纯净。</li>
            <li>详情页面全面居中，采用对话框展现，配合顶部线性加载条。</li>
            <li>图库调节替换为直观的放大/缩小图标。</li>
            <li>修复了图片下载的跨域预览问题，支持一键直接下载。</li>
          </ul>
        </div>
      </div>
    </AppModal>
  </div>
</template>
