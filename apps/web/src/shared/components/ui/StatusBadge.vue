<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/shared/lib/utils'
import type { JobStatus, UserStatus } from '@/shared/types'

type Variant = 'soft' | 'outline' | 'solid'

const props = defineProps<{
  status: JobStatus | UserStatus | string
  variant?: Variant
}>()

const statusConfig: Record<string, { label: string; classes: string }> = {
  // Job statuses
  queued: { label: '排队中', classes: 'bg-neutral-100 text-neutral-600' },
  running: { label: '生成中', classes: 'bg-info-soft text-info' },
  succeeded: { label: '已完成', classes: 'bg-success-soft text-success' },
  failed: { label: '失败', classes: 'bg-danger-soft text-danger' },
  canceled: { label: '已取消', classes: 'bg-neutral-100 text-neutral-500' },
  retry_wait: { label: '重试中', classes: 'bg-warning-soft text-warning' },
  // User statuses
  active: { label: '正常', classes: 'bg-success-soft text-success' },
  disabled: { label: '已停用', classes: 'bg-danger-soft text-danger' },
}

const config = computed(() => {
  return statusConfig[props.status] || { label: props.status, classes: 'bg-neutral-100 text-neutral-600' }
})

const baseClasses = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium'

const variantClasses = computed(() => {
  switch (props.variant) {
    case 'outline':
      return 'border bg-transparent'
    case 'solid':
      return 'text-white'
    default:
      return config.value.classes
  }
})
</script>

<template>
  <span :class="cn(baseClasses, variantClasses)">
    {{ config.label }}
  </span>
</template>
