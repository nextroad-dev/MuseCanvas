<script setup lang="ts">
import type { ToastType } from '@/shared/composables/useToast'
import { CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-vue-next'

defineProps<{
  type: ToastType
  message: string
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
  <div
    :class="[
      'pointer-events-auto flex items-center gap-2 rounded-[var(--radius-control)] border px-4 py-3 shadow-lg',
      colorMap[type],
    ]"
    :role="type === 'error' ? 'alert' : 'status'"
  >
    <component :is="iconMap[type]" class="h-5 w-5 shrink-0" aria-hidden="true" />
    <span class="text-sm font-medium">{{ message }}</span>
  </div>
</template>
