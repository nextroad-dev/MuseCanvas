<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { X, ChevronLeft, ChevronRight, Download } from 'lucide-vue-next'
import { useFocusTrap } from '@/shared/composables/useFocusTrap'

interface LightboxImage {
  url: string
  prompt?: string
  alt?: string
}

const props = defineProps<{
  images: LightboxImage[]
  modelValue: number
}>()

const emit = defineEmits<{
  'update:modelValue': [index: number]
}>()

const containerRef = ref<HTMLElement | null>(null)
const { activate, deactivate } = useFocusTrap(containerRef)

const isOpen = computed(() => props.modelValue >= 0)
const currentIndex = computed(() => Math.max(0, Math.min(props.modelValue, props.images.length - 1)))
const currentImage = computed(() => props.images[currentIndex.value])

watch(isOpen, (val) => {
  if (val) {
    document.body.style.overflow = 'hidden'
    nextTick(() => activate())
  } else {
    document.body.style.overflow = ''
    deactivate()
  }
})

function close() {
  emit('update:modelValue', -1)
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
  if (e.key === 'Escape') close()
  if (e.key === 'ArrowLeft') prev()
  if (e.key === 'ArrowRight') next()
}

function handleDownload() {
  const a = document.createElement('a')
  a.href = currentImage.value.url
  a.download = `musecanvas-${Date.now()}.png`
  a.click()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="lightbox">
      <div
        v-if="isOpen"
        ref="containerRef"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
        @click="close"
        @keydown="handleKeydown"
      >
        <!-- Close -->
        <button
          class="absolute right-4 top-4 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
          aria-label="关闭"
          @click.stop="close"
        >
          <X class="h-5 w-5" />
        </button>

        <!-- Prev -->
        <button
          v-if="images.length > 1 && currentIndex > 0"
          class="absolute left-4 top-1/2 z-10 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
          aria-label="上一张"
          @click.stop="prev"
        >
          <ChevronLeft class="h-5 w-5" />
        </button>

        <!-- Next -->
        <button
          v-if="images.length > 1 && currentIndex < images.length - 1"
          class="absolute right-14 top-1/2 z-10 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
          aria-label="下一张"
          @click.stop="next"
        >
          <ChevronRight class="h-5 w-5" />
        </button>

        <!-- Image -->
        <div class="relative flex max-h-[85vh] max-w-[90vw] flex-col items-center justify-center" @click.stop>
          <img
            :src="currentImage?.url"
            :alt="currentImage?.alt || currentImage?.prompt || ''"
            class="max-h-[80vh] max-w-full rounded-lg shadow-2xl object-contain"
          />
          <div class="mt-3 flex items-center justify-between gap-4">
            <p v-if="currentImage?.prompt" class="max-w-lg text-xs text-white/70">
              {{ currentImage.prompt }}
            </p>
            <button
              class="inline-flex h-8 items-center gap-1 rounded-md bg-white/10 px-3 text-xs text-white hover:bg-white/20"
              @click.stop="handleDownload"
            >
              <Download class="h-3.5 w-3.5" />
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
  transition: opacity var(--motion-slow) ease;
}
.lightbox-enter-from,
.lightbox-leave-to {
  opacity: 0;
}
</style>
