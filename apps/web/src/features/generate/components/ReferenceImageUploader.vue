<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  ImagePlus,
  X,
  RotateCcw,
  Check,
  AlertCircle,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Trash2,
} from 'lucide-vue-next'
import { useGenerationStore } from '@/features/generate/stores/generation'

const store = useGenerationStore()
const props = defineProps<{ disabled?: boolean }>()

const fileInputRef = ref<HTMLInputElement | null>(null)
const isDraggingOver = ref(false)
const draggedThumbIndex = ref<number | null>(null)
const liveAnnouncement = ref('')

const maxAllowed = computed(() =>
  Math.min(store.modelMaxInputImages > 0 ? store.modelMaxInputImages : 4, 4)
)

const canAddMore = computed(
  () => !props.disabled && store.isModelSupportingImages && store.stagedImages.length < maxAllowed.value
)

const totalSizeFormatted = computed(() => {
  const mb = store.stagedImagesTotalBytes / (1024 * 1024)
  return mb < 0.1 && store.stagedImagesTotalBytes > 0 ? '<0.1MB' : `${mb.toFixed(1)}MB`
})

// Update screen-reader live announcements
watch(
  () => store.stagedImages.map((i) => `${i.localId}:${i.status}:${i.progress}`),
  () => {
    if (store.stagedImages.length === 0) {
      liveAnnouncement.value = '已清空所有参考图'
      return
    }
    const uploading = store.stagedImages.filter((i) => i.status === 'uploading')
    const errors = store.stagedImages.filter((i) => i.status === 'error')
    const ready = store.stagedImages.filter((i) => i.status === 'ready')

    if (errors.length > 0) {
      liveAnnouncement.value = `${errors.length} 张参考图上传失败`
    } else if (uploading.length > 0) {
      liveAnnouncement.value = `正在上传参考图，已就绪 ${ready.length} 张`
    } else if (ready.length === store.stagedImages.length) {
      liveAnnouncement.value = `所有参考图上传完成，共 ${ready.length} 张已就绪`
    }
  }
)

function triggerFileInput() {
  if (!canAddMore.value) return
  fileInputRef.value?.click()
}

function onFileInputChange(e: Event) {
  if (props.disabled) return
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    store.addStagedFiles(input.files)
    // Clear input value so same files can be re-selected if removed
    input.value = ''
  }
}

// OS file drag & drop handlers
function onDragOver(e: DragEvent) {
  if (!canAddMore.value) return
  if (e.dataTransfer?.types.includes('Files')) {
    isDraggingOver.value = true
  }
}

function onDragLeave(e: DragEvent) {
  // Only unset if we're leaving the drop container itself
  const currentTarget = e.currentTarget as HTMLElement
  const relatedTarget = e.relatedTarget as Node | null
  if (!relatedTarget || !currentTarget.contains(relatedTarget)) {
    isDraggingOver.value = false
  }
}

function onDrop(e: DragEvent) {
  if (!canAddMore.value) return
  isDraggingOver.value = false
  if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
    store.addStagedFiles(e.dataTransfer.files)
  }
}

// Thumbnail internal reorder drag & drop
function onThumbDragStart(e: DragEvent, index: number) {
  if (props.disabled) return
  draggedThumbIndex.value = index
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
  }
}

function onThumbDragOver(e: DragEvent) {
  if (draggedThumbIndex.value !== null && e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move'
  }
}

function onThumbDrop(targetIndex: number) {
  if (props.disabled) return
  if (draggedThumbIndex.value !== null && draggedThumbIndex.value !== targetIndex) {
    store.reorderStagedImages(draggedThumbIndex.value, targetIndex)
  }
  draggedThumbIndex.value = null
}

function onThumbDragEnd() {
  draggedThumbIndex.value = null
}

// Keyboard reordering
function handleThumbKeydown(e: KeyboardEvent, index: number) {
  if (props.disabled) return
  if (e.altKey && e.key === 'ArrowLeft' && index > 0) {
    e.preventDefault()
    store.reorderStagedImages(index, index - 1)
  } else if (e.altKey && e.key === 'ArrowRight' && index < store.stagedImages.length - 1) {
    e.preventDefault()
    store.reorderStagedImages(index, index + 1)
  }
}

function clearAll() {
  if (props.disabled) return
  store.clearStagedImages()
}
</script>

<template>
  <!-- Hidden accessible file input -->
  <input
    ref="fileInputRef"
    type="file"
    accept="image/png,image/jpeg"
    :disabled="props.disabled"
    multiple
    tabindex="-1"
    class="sr-only"
    aria-label="选择本地参考图文件"
    @change="onFileInputChange"
  />

  <!-- Accessible live region for status announcements -->
  <div class="sr-only" aria-live="polite" aria-atomic="true">
    {{ liveAnnouncement }}
  </div>

  <div class="w-full space-y-3 px-4 py-3">
    <!-- Unsupported Model Warning Banner -->
    <div
      v-if="store.stagedImages.length > 0 && !store.isModelSupportingImages"
      class="flex items-start justify-between gap-3 rounded-[var(--radius-control)] border border-warning/40 bg-warning-soft px-3.5 py-2.5 text-xs text-warning"
      role="alert"
    >
      <div class="flex items-start gap-2">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p class="font-semibold">当前模型不支持参考图</p>
          <p class="mt-0.5 text-foreground/80">
            当前模型（{{ store.selectedModel?.displayName || '未选择' }}）不支持带参考图生成。请切换至支持参考图的模型（如 GPT Image 2、Seedream 4.0），或移除已添加的参考图后继续。
          </p>
        </div>
      </div>
      <button
        type="button"
        :disabled="props.disabled"
        class="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-control)] border border-warning/50 bg-surface px-2.5 py-1 text-xs font-medium text-warning hover:bg-surface-subtle"
        aria-label="清空所有参考图"
        @click="clearAll"
      >
        <Trash2 class="h-3 w-3" />
        清空参考图
      </button>
    </div>

    <!-- Inline Upload Error Banner -->
    <div
      v-if="store.inlineUploadError"
      class="flex items-center justify-between gap-2 rounded-[var(--radius-control)] border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger"
      role="alert"
    >
      <div class="flex items-center gap-1.5">
        <AlertCircle class="h-4 w-4 shrink-0" />
        <span>{{ store.inlineUploadError }}</span>
      </div>
      <button
        type="button"
        class="rounded p-1 hover:bg-danger/10"
        aria-label="关闭提示"
        @click="store.inlineUploadError = null"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>

    <!-- Dropzone / Thumbnail Strip Container -->
    <div
      class="relative flex flex-col gap-2 rounded-[var(--radius-card)] border-2 border-dashed p-3 transition-colors duration-200"
      :class="[
        isDraggingOver
          ? 'border-primary bg-primary-soft/50 ring-2 ring-primary/20'
          : 'border-border/80 bg-surface-subtle/50 hover:border-border-strong',
      ]"
      @dragover.prevent="onDragOver"
      @dragleave.prevent="onDragLeave"
      @drop.prevent="onDrop"
    >
      <!-- Header row: label + counter -->
      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <div class="flex items-center gap-1.5 font-medium text-foreground">
          <ImagePlus class="h-3.5 w-3.5 text-primary" />
          <span>{{ store.isVideo ? '输入图片 (首帧 / 尾帧 / 参考)' : '参考图 (图生图)' }}</span>
          <span class="text-[11px] font-normal text-muted-foreground">
            {{ store.stagedImages.length }}/{{ maxAllowed }}
          </span>
        </div>
        <div class="flex items-center gap-2 text-[11px]">
          <span>总计: {{ totalSizeFormatted }} / 20MB</span>
          <button
            v-if="store.stagedImages.length > 0"
            type="button"
            class="text-muted-foreground underline-offset-2 hover:text-danger hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="props.disabled"
            @click="clearAll"
          >
            清空
          </button>
        </div>
      </div>

      <!-- Thumbnail Strip & Add Button Row -->
      <div class="flex flex-wrap items-center gap-2.5 pt-1">
        <!-- Staged Thumbnail Cards -->
        <div
          v-for="(img, index) in store.stagedImages"
          :key="img.localId"
          class="group relative flex h-20 w-20 shrink-0 flex-col items-center justify-center overflow-hidden rounded-[var(--radius-control)] border bg-surface shadow-xs transition-all duration-200"
          :class="[
            img.status === 'error'
              ? 'border-danger ring-1 ring-danger/30'
              : img.status === 'ready'
                ? 'border-border hover:border-primary/60 hover:shadow-sm'
                : 'border-primary/40',
            draggedThumbIndex === index ? 'opacity-40 scale-95' : '',
          ]"
          :draggable="!props.disabled"
          role="group"
          :aria-label="`参考图 ${index + 1}, 状态: ${
            img.status === 'ready'
              ? '已就绪'
              : img.status === 'uploading'
                ? `上传中 ${img.progress}%`
                : img.status === 'error'
                  ? '上传失败'
                  : '处理中'
          }`"
          tabindex="0"
          @dragstart="onThumbDragStart($event, index)"
          @dragover.prevent="onThumbDragOver($event)"
          @drop.prevent="onThumbDrop(index)"
          @dragend="onThumbDragEnd"
          @keydown="handleThumbKeydown($event, index)"
        >
          <!-- Image preview -->
          <img
            :src="img.previewUrl"
            :alt="`参考图 ${index + 1}`"
            class="h-full w-full object-cover"
          />

          <!-- Order badge -->
          <span
            class="pointer-events-none absolute left-1 top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-black/65 text-[10px] font-semibold text-white backdrop-blur-xs"
          >
            {{ index + 1 }}
          </span>

          <!-- Status overlay: Uploading -->
          <div
            v-if="img.status === 'uploading' || img.status === 'pending'"
            class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/60 p-1 text-white backdrop-blur-xs"
          >
            <div class="relative flex h-8 w-8 items-center justify-center">
              <svg class="h-8 w-8 -rotate-90" viewBox="0 0 36 36">
                <path
                  class="text-white/20"
                  stroke-width="3.5"
                  stroke="currentColor"
                  fill="none"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
                <path
                  class="text-primary transition-all duration-200"
                  stroke-dasharray="100, 100"
                  :stroke-dashoffset="100 - img.progress"
                  stroke-width="3.5"
                  stroke-linecap="round"
                  stroke="currentColor"
                  fill="none"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
              </svg>
              <span class="absolute text-[9px] font-bold">{{ img.progress }}%</span>
            </div>
            <span class="mt-0.5 text-[9px] text-white/90">上传中</span>
          </div>

          <!-- Status overlay: Processing -->
          <div
            v-else-if="img.status === 'processing'"
            class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/60 p-1 text-white backdrop-blur-xs"
          >
            <Loader2 class="h-5 w-5 animate-spin text-primary" />
            <span class="mt-1 text-[9px] text-white/90">处理中</span>
          </div>

          <!-- Status overlay: Error -->
          <div
            v-else-if="img.status === 'error'"
            class="absolute inset-0 z-40 flex flex-col items-center justify-center bg-danger/85 p-1 text-white backdrop-blur-xs"
          >
            <AlertCircle class="h-4 w-4" />
            <span class="mt-0.5 text-center text-[9px] leading-tight">上传失败</span>
            <button
              type="button"
              :disabled="props.disabled"
              class="mt-1 flex items-center gap-0.5 rounded bg-white/20 px-1.5 py-0.5 text-[9px] font-medium hover:bg-white/30"
              :aria-label="`重试上传参考图 ${index + 1}`"
              title="重试"
              @click.stop="!props.disabled && store.retryUpload(img.localId)"
            >
              <RotateCcw class="h-2.5 w-2.5" />
              重试
            </button>
          </div>

          <span
            v-else-if="img.status === 'ready'"
            class="pointer-events-none absolute bottom-7 right-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-white shadow-xs"
            title="已就绪"
          >
            <Check class="h-2.5 w-2.5 stroke-[3]" />
          </span>
          <!-- Action buttons overlay on hover / focus-within -->
          <div
            class="pointer-events-none absolute inset-0 z-30 flex items-start justify-end p-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <!-- Delete button -->
            <button
              type="button"
              :disabled="props.disabled"
              class="pointer-events-auto flex h-5 w-5 items-center justify-center rounded-full bg-black/75 text-white shadow-sm transition-colors hover:bg-danger disabled:cursor-not-allowed disabled:opacity-50"
              :aria-label="`移除参考图 ${index + 1}`"
              title="移除此参考图"
              @click.stop="!props.disabled && store.removeStagedImage(img.localId)"
            >
              <X class="h-3 w-3" />
            </button>
          </div>

          <!-- Reorder controls (left / right arrows) on hover -->
          <div
            v-if="store.stagedImages.length > 1"
            class="pointer-events-none absolute bottom-7 left-1 z-30 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <button
              v-if="index > 0"
              type="button"
              :disabled="props.disabled"
              class="pointer-events-auto flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
              :aria-label="`向左移动参考图 ${index + 1}`"
              title="向前移动 (Alt+←)"
              @click.stop="!props.disabled && store.reorderStagedImages(index, index - 1)"
            >
              <ChevronLeft class="h-3 w-3" />
            </button>
            <button
              v-if="index < store.stagedImages.length - 1"
              type="button"
              :disabled="props.disabled"
              class="pointer-events-auto flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
              :aria-label="`向右移动参考图 ${index + 1}`"
              title="向后移动 (Alt+→)"
              @click.stop="!props.disabled && store.reorderStagedImages(index, index + 1)"
            >
              <ChevronRight class="h-3 w-3" />
            </button>
          </div>
          <!-- Input role selector -->
          <div class="absolute inset-x-1 bottom-1 z-30" @click.stop>
            <select
              :value="img.role || 'reference_image'"
              :disabled="props.disabled"
              :aria-label="`第 ${index + 1} 张图的输入角色`"
              title="输入角色：首帧须首位，尾帧须末位"
              class="w-full cursor-pointer rounded bg-black/70 px-1 py-0.5 text-center text-[10px] font-medium text-white backdrop-blur-xs transition-colors hover:bg-black/85 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              @change="store.setStagedImageRole(img.localId, ($event.target as HTMLSelectElement).value as 'reference_image' | 'first_frame' | 'last_frame')"
            >
              <option value="reference_image">参考图</option>
              <option value="first_frame">首帧</option>
              <option value="last_frame">尾帧</option>
            </select>
          </div>
        </div>

        <!-- Add Button Card -->
        <button
          v-if="canAddMore"
          type="button"
          class="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] border border-dashed border-border-strong bg-surface/80 text-muted-foreground transition-all duration-200 hover:border-primary hover:bg-primary-soft/40 hover:text-primary active:scale-95"
          aria-label="添加参考图"
          @click="triggerFileInput"
          @keydown.enter.prevent="triggerFileInput"
          @keydown.space.prevent="triggerFileInput"
        >
          <ImagePlus class="h-5 w-5" />
          <span class="text-[10px] font-medium">添加图片</span>
        </button>
      </div>

      <!-- Drag & drop prompt / hint -->
      <div class="flex items-center justify-between text-[11px] text-muted-foreground/80">
        <span>支持 PNG/JPEG，单张 &le; 10MB，总大小 &le; 20MB</span>
        <span v-if="store.stagedImages.length > 1" class="hidden sm:inline">
          可拖拽或按 Alt+方向键调整顺序
        </span>
      </div>
    </div>
  </div>
</template>