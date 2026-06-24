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
  success: 'bg-green-50 text-green-700 border-green-200',
  error: 'bg-red-50 text-red-700 border-red-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  info: 'bg-blue-50 text-blue-700 border-blue-200',
}
</script>

<template>
  <div
    :class="[
      'pointer-events-auto flex items-center gap-2 rounded-xl border px-4 py-3 shadow-lg',
      colorMap[type],
    ]"
    role="alert"
  >
    <component :is="iconMap[type]" class="h-5 w-5 shrink-0" />
    <span class="text-sm font-medium">{{ message }}</span>
  </div>
</template>
