<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useGenerationStore } from '@/stores/generation'
import PromptEditor from '@/components/ui/PromptEditor.vue'
import ModelSelector from '@/components/ui/ModelSelector.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { Sparkles, Loader2, XCircle, Image as ImageIcon } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

const store = useGenerationStore()
const previewAsset = ref<{ url: string; prompt: string } | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await Promise.all([store.fetchModels(), store.fetchJobs()])
  // Poll running jobs
  pollTimer = setInterval(() => {
    const running = store.jobs.filter((j) => j.status === 'running' || j.status === 'queued')
    running.forEach((j) => store.refreshJob(j.id))
  }, 3000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function handleGenerate() {
  store.createJob()
}

function cancelJob(id: string) {
  store.cancelJob(id)
}
</script>

<template>
  <div class="flex h-full w-full">
    <!-- Left sidebar: job history -->
    <aside class="flex w-64 shrink-0 flex-col border-r border-neutral-200">
      <div class="flex h-10 items-center border-b border-neutral-200 px-4">
        <span class="text-xs font-medium text-neutral-500">任务历史</span>
      </div>
      <div class="flex-1 overflow-auto">
        <div v-if="store.jobs.length === 0" class="px-4 py-8 text-center text-xs text-neutral-400">
          暂无任务
        </div>
        <div
          v-for="job in store.jobs"
          :key="job.id"
          :class="
            cn(
              'flex cursor-pointer items-start gap-3 border-b border-neutral-100 px-4 py-3 transition-colors hover:bg-neutral-50',
              store.selectedJobId === job.id && 'bg-primary-soft',
            )
          "
          @click="store.selectedJobId = job.id"
        >
          <!-- Thumbnail or placeholder -->
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 overflow-hidden">
            <img
              v-if="job.outputs.length"
              :src="job.outputs[0].imageUrl"
              class="h-full w-full object-cover"
              loading="lazy"
            />
            <ImageIcon v-else class="h-4 w-4 text-neutral-400" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs text-neutral-700">{{ job.prompt || '无提示词' }}</p>
            <div class="mt-1 flex items-center gap-2">
              <StatusBadge :status="job.status" />
              <span class="text-[10px] text-neutral-400">{{ job.modelName }}</span>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <!-- Main workspace: result preview -->
    <main class="flex min-w-0 flex-1 flex-col items-center justify-center bg-neutral-50 p-8">
      <template v-if="store.selectedJob">
        <div class="mb-4 flex items-center gap-3">
          <StatusBadge :status="store.selectedJob.status" />
          <span class="text-xs text-neutral-500">{{ store.selectedJob.modelName }}</span>
        </div>

        <!-- Prompt display -->
        <p class="mb-6 max-w-lg text-center text-sm text-neutral-600">
          {{ store.selectedJob.prompt }}
        </p>

        <!-- Result area -->
        <div
          v-if="store.selectedJob.outputs.length"
          class="grid max-w-2xl gap-4"
          :class="store.selectedJob.outputs.length > 1 ? 'grid-cols-2' : 'grid-cols-1'"
        >
          <div
            v-for="output in store.selectedJob.outputs"
            :key="output.id"
            class="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm cursor-pointer transition-shadow hover:shadow-md"
            @click="previewAsset = { url: output.imageUrl, prompt: store.selectedJob.prompt }"
          >
            <img :src="output.imageUrl" :alt="store.selectedJob.prompt" class="w-full" loading="lazy" />
          </div>
        </div>

        <!-- Loading state -->
        <div
          v-else-if="store.selectedJob.status === 'queued' || store.selectedJob.status === 'running'"
          class="flex flex-col items-center gap-3"
        >
          <Loader2 class="h-8 w-8 animate-spin text-primary" />
          <span class="text-sm text-neutral-500">
            {{ store.selectedJob.status === 'queued' ? '排队中...' : '生成中...' }}
          </span>
          <button
            class="text-xs text-neutral-400 hover:text-danger"
            @click="cancelJob(store.selectedJob.id)"
          >
            取消任务
          </button>
        </div>

        <!-- Failed state -->
        <div v-else-if="store.selectedJob.status === 'failed'" class="flex flex-col items-center gap-2">
          <XCircle class="h-8 w-8 text-danger" />
          <span class="text-sm text-neutral-500">生成失败</span>
          <span v-if="store.selectedJob.errorCode" class="text-xs text-neutral-400">
            {{ store.selectedJob.errorCode }}
          </span>
        </div>

        <!-- Canceled state -->
        <div v-else-if="store.selectedJob.status === 'canceled'" class="flex flex-col items-center gap-2">
          <XCircle class="h-8 w-8 text-neutral-400" />
          <span class="text-sm text-neutral-500">任务已取消</span>
        </div>
      </template>

      <!-- No job selected -->
      <EmptyState
        v-else
        title="输入提示词开始创作"
        description="在右侧填写提示词并选择参数，即可生成图片"
      />
    </main>

    <!-- Right panel: generation params -->
    <aside class="flex w-80 shrink-0 flex-col border-l border-neutral-200 bg-white">
      <div class="flex h-10 items-center border-b border-neutral-200 px-4">
        <span class="text-xs font-medium text-neutral-500">生成参数</span>
      </div>
      <div class="flex-1 overflow-auto p-4">
        <div class="space-y-4">
          <!-- Prompt -->
          <div>
            <label class="mb-1.5 block text-xs font-medium text-neutral-700">提示词</label>
            <PromptEditor
              v-model="store.prompt"
              :max-length="2000"
              placeholder="描述你想要生成的图片..."
            />
          </div>

          <!-- Model -->
          <ModelSelector
            v-model="store.selectedModelId"
            :models="store.models"
          />

          <!-- Size -->
          <div>
            <label class="mb-1.5 block text-xs font-medium text-neutral-700">尺寸</label>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="size in store.availableSizes"
                :key="size"
                :class="
                  cn(
                    'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                    store.selectedSize === size
                      ? 'border-primary bg-primary-soft text-primary'
                      : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50',
                  )
                "
                @click="store.selectedSize = size"
              >
                {{ size }}
              </button>
            </div>
          </div>

          <!-- Quality (GPT Image 2 only) -->
          <div v-if="store.availableQualities.length">
            <label class="mb-1.5 block text-xs font-medium text-neutral-700">质量</label>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="q in store.availableQualities"
                :key="q"
                :class="
                  cn(
                    'rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors',
                    store.selectedQuality === q
                      ? 'border-primary bg-primary-soft text-primary'
                      : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50',
                  )
                "
                @click="store.selectedQuality = q"
              >
                {{ q }}
              </button>
            </div>
          </div>

          <!-- Count -->
          <div>
            <label class="mb-1.5 block text-xs font-medium text-neutral-700">生成张数</label>
            <div class="flex items-center gap-2">
              <button
                class="flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-200 text-sm text-neutral-600 transition-colors hover:bg-neutral-50 disabled:opacity-50"
                :disabled="store.count <= 1"
                @click="store.count--"
              >
                -
              </button>
              <span class="w-8 text-center text-sm font-medium">{{ store.count }}</span>
              <button
                class="flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-200 text-sm text-neutral-600 transition-colors hover:bg-neutral-50 disabled:opacity-50"
                :disabled="store.count >= (store.selectedModel?.maxCount || 4)"
                @click="store.count++"
              >
                +
              </button>
            </div>
          </div>

          <!-- Generate button -->
          <button
            :disabled="store.loading || !store.prompt.trim() || !store.selectedModelId || !store.selectedSize"
            class="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            @click="handleGenerate"
          >
            <Sparkles class="h-4 w-4" />
            {{ store.loading ? '生成中...' : '生成' }}
          </button>
        </div>
      </div>
    </aside>

    <!-- Full-screen preview dialog -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="previewAsset" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80" @click="previewAsset = null">
          <div class="relative max-h-[90vh] max-w-[90vw]">
            <img :src="previewAsset.url" :alt="previewAsset.prompt" class="max-h-[85vh] rounded-lg shadow-2xl" />
            <p class="mt-3 max-w-lg text-center text-xs text-white/70">{{ previewAsset.prompt }}</p>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
