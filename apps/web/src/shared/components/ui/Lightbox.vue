<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { X, ChevronLeft, ChevronRight, Download } from 'lucide-vue-next'
import { useOverlay } from '@/shared/composables/useOverlay'

interface LightboxImage {
  url: string
  prompt?: string
  alt?: string
}

const props = defineProps<{
  images: LightboxImage[]
  open: boolean
  modelValue?: number
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'update:modelValue': [value: number]
}>()

const containerRef = ref<HTMLElement | null>(null)
useOverlay(containerRef, toRef(props, 'open'), {
  onClose: () => emit('update:open', false),
})

const currentIndex = computed(() => Math.max(0, Math.min(props.modelValue ?? 0, props.images.length - 1)))
const currentImage = computed(() => props.images[currentIndex.value])

function close() {
  emit('update:open', false)
}

function prev() {
  if (currentIndex.value > 0) {
    emit('update:modelValue', currentIndex.value - 1)
  }
}

function next() {
  if (currentIndex.value < props.images.length - 1) {
    emit('update:modelValue', currentIndex.value + 1)
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') prev()
  if (e.key === 'ArrowRight') next()
}

function handleDownload() {
  const url = currentImage.value?.url
  if (!url) return
  const a = document.createElement('a')
  a.href = url
  a.download = `musecanvas-${Date.now()}.png`
  a.click()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="lightbox">
      <div
        v-if="open"
        ref="containerRef"
        class="fixed inset-0 z-overlay flex items-center justify-center bg-overlay/90"
        role="dialog"
        aria-modal="true"
        aria-label="媒体预览"
        @click="close"
        @keydown="handleKeydown"
      >
        <!-- Close -->
        <button
          type="button"
          class="absolute right-4 top-4 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-overlay/60 text-foreground-inverse transition-colors hover:bg-overlay"
          aria-label="关闭"
          @click.stop="close"
        >
          <X class="h-5 w-5" aria-hidden="true"/>
        </button>

        <!-- Prev -->
        <button
          v-if="images.length > 1 && currentIndex > 0"
          type="button"
          class="absolute left-4 top-1/2 z-10 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-overlay/60 text-foreground-inverse transition-colors hover:bg-overlay"
          aria-label="上一张"
          @click.stop="prev"
        >
          <ChevronLeft class="h-5 w-5" aria-hidden="true"/>
        </button>

        <!-- Next -->
        <button
          v-if="images.length > 1 && currentIndex < images.length - 1"
          type="button"
          class="absolute right-4 top-1/2 z-10 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-overlay/60 text-foreground-inverse transition-colors hover:bg-overlay sm:right-16"
          aria-label="下一张"
          @click.stop="next"
        >
          <ChevronRight class="h-5 w-5" aria-hidden="true"/>
        </button>

        <!-- Media -->
        <div class="relative flex max-h-[85vh] max-w-[90vw] flex-col items-center justify-center" @click.stop>
          <img
            :src="currentImage?.url"
            :alt="currentImage?.alt || currentImage?.prompt || ''"
            class="max-h-[80vh] max-w-full rounded-[var(--radius-card)] object-contain"
          />
          <div class="mt-3 flex items-center justify-between gap-4">
            <p v-if="currentImage?.prompt" class="line-clamp-2 max-w-lg text-xs text-foreground-inverse">
              {{ currentImage.prompt }}
            </p>
            <span v-if="images.length > 1" class="text-xs tabular-nums text-foreground-inverse">
              {{ currentIndex + 1 }} / {{ images.length }}
            </span>
            <button
              type="button"
              class="inline-flex min-h-8 items-center gap-1 rounded-[var(--radius-control)] bg-foreground-inverse/15 px-3 text-xs font-medium text-foreground-inverse transition-colors hover:bg-foreground-inverse/25"
              @click.stop="handleDownload"
            >
              <Download class="h-3.5 w-3.5" aria-hidden="true"/>
              下载
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.lightbox-enter-active,
.lightbox-leave-active {
  transition: opacity var(--motion-base) var(--ease-standard);
}
.lightbox-enter-from,
.lightbox-leave-to {
  opacity: 0;
}
</style>