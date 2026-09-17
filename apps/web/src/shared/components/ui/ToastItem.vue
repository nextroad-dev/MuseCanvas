<script setup lang="ts">
import { X } from 'lucide-vue-next'
import type { ToastType } from '@/shared/composables/useToast'
import { CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-vue-next'

defineProps<{
  type: ToastType
  message: string
  dismissible?: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const iconMap = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
}

const colorMap: Record<ToastType, string> = {
  success: 'bg-success-soft text-success border-success-soft',
  error: 'bg-danger-soft text-danger border-danger-soft',
  warning: 'bg-warning-soft text-warning border-warning-soft',
  info: 'bg-info-soft text-info border-info-soft',
}
</script>

<template>
  <!-- Normal feedback is announced politely; only urgent problems use alert.
       Toasts never take focus. -->
  <div
    :class="[
      'pointer-events-auto flex items-center gap-2 rounded-[var(--radius-card)] border px-4 py-3 shadow-lg',
      colorMap[type],
    ]"
    :role="type === 'error' ? 'alert' : 'status'"
    aria-atomic="true"
  >
    <component :is="iconMap[type]" class="h-5 w-5 shrink-0" aria-hidden="true"/>
    <span class="min-w-0 flex-1 text-sm font-medium">{{ message }}</span>
    <button
      v-if="dismissible"
      type="button"
      class="-mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] transition-colors hover:bg-surface-subtle"
      aria-label="关闭提示"
      @click="emit('close')"
    >
      <X class="h-4 w-4" aria-hidden="true"/>
    </button>
  </div>
</template>