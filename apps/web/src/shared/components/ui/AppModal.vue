<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { X } from 'lucide-vue-next'
import { useFocusTrap } from '@/shared/composables/useFocusTrap'
import { cn } from '@/shared/lib/utils'

const props = defineProps<{
  open: boolean
  title?: string
  description?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const modalRef = ref<HTMLElement | null>(null)
const { activate, deactivate } = useFocusTrap(modalRef)

const sizeMap = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
}

watch(() => props.open, (val) => {
  if (val) {
    document.body.style.overflow = 'hidden'
    nextTick(() => activate())
  } else {
    document.body.style.overflow = ''
    deactivate()
  }
})

function close() {
  emit('update:open', false)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4" @keydown="handleKeydown">
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/40" @click="close" />

        <!-- Dialog -->
        <div
          ref="modalRef"
          :class="cn(
            'relative z-10 flex max-h-[85vh] w-full flex-col rounded-[var(--radius-card)] border border-border bg-surface shadow-lg',
            sizeMap[size || 'md'],
          )"
          role="dialog"
          aria-modal="true"
        >
          <div class="flex items-start justify-between gap-4 border-b border-border p-5">
            <div class="min-w-0 flex-1">
              <h3 v-if="title" class="text-base font-semibold text-foreground">{{ title }}</h3>
              <p v-if="description" class="mt-1 text-sm text-muted-foreground">{{ description }}</p>
            </div>
            <button
              class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-neutral-500 hover:bg-neutral-100"
              aria-label="关闭"
              @click="close"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
          <div class="flex-1 overflow-y-auto p-5">
            <slot />
          </div>
          <div v-if="$slots.footer" class="flex shrink-0 justify-end gap-2 border-t border-border p-5">
            <slot name="footer" :close="close" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity var(--motion-base) ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-active .relative,
.modal-leave-active .relative {
  transition: transform var(--motion-base) ease;
}
.modal-enter-from .relative,
.modal-leave-to .relative {
  transform: scale(0.98);
}
</style>
