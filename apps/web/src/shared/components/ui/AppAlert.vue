<script setup lang="ts">
import { CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-vue-next'
import type { ToastType } from '@/shared/composables/useToast'

interface Props {
  type?: ToastType
  message?: string
  title?: string
}

withDefaults(defineProps<Props>(), {
  type: 'info',
  message: '',
  title: '',
})

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
      'flex items-start gap-2 rounded-[var(--radius-control)] border px-3 py-2.5 text-xs',
      colorMap[type],
    ]"
    :role="type === 'error' ? 'alert' : 'status'"
  >
    <component :is="iconMap[type]" class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p v-if="title" class="mb-0.5 font-medium">{{ title }}</p>
      <p>{{ message }}</p>
    </div>
  </div>
</template>
