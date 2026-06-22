<script setup lang="ts">
import { AlertTriangle } from 'lucide-vue-next'

defineProps<{
  open: boolean
  title: string
  description: string
  confirmText?: string
  variant?: 'danger' | 'default'
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
}>()

function close() {
  emit('update:open', false)
}

function confirm() {
  emit('confirm')
  close()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center">
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/40" @click="close" />

        <!-- Dialog -->
        <div class="relative z-10 w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 shadow-xl">
          <div class="mb-4 flex items-start gap-3">
            <div
              v-if="variant === 'danger'"
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-50"
            >
              <AlertTriangle class="h-5 w-5 text-danger" />
            </div>
            <div>
              <h3 class="text-sm font-semibold text-neutral-900">{{ title }}</h3>
              <p class="mt-1 text-sm text-neutral-500">{{ description }}</p>
            </div>
          </div>

          <div class="flex justify-end gap-2">
            <button
              class="inline-flex h-9 items-center rounded-lg border border-neutral-200 px-4 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
              @click="close"
            >
              取消
            </button>
            <button
              :class="[
                'inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium text-white transition-colors',
                variant === 'danger'
                  ? 'bg-danger hover:bg-danger-hover'
                  : 'bg-primary hover:bg-primary-hover',
              ]"
              @click="confirm"
            >
              {{ confirmText || '确认' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
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
