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
  success: 'bg-green-50 text-green-700 border-green-200',
  error: 'bg-red-50 text-red-700 border-red-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  info: 'bg-blue-50 text-blue-700 border-blue-200',
}
</script>

<template>
  <div
    :class="[
      'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs',
      colorMap[type],
    ]"
    role="alert"
  >
    <component :is="iconMap[type]" class="mt-0.5 h-4 w-4 shrink-0" />
    <div class="min-w-0 flex-1">
      <p v-if="title" class="mb-0.5 font-medium">{{ title }}</p>
      <p>{{ message }}</p>
    </div>
  </div>
</template>
