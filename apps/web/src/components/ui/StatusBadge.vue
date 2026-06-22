<script setup lang="ts">
import { cn } from '@/lib/utils'
import type { JobStatus, UserStatus } from '@/types'

defineProps<{
  status: JobStatus | UserStatus
}>()

const variants: Record<string, string> = {
  queued: 'bg-neutral-100 text-neutral-600',
  running: 'bg-blue-50 text-blue-700',
  succeeded: 'bg-green-50 text-green-700',
  failed: 'bg-red-50 text-red-700',
  canceled: 'bg-neutral-100 text-neutral-500',
  retry_wait: 'bg-yellow-50 text-yellow-700',
  active: 'bg-green-50 text-green-700',
  disabled: 'bg-red-50 text-red-700',
}

const labels: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
  retry_wait: '重试中',
  active: '正常',
  disabled: '已停用',
}
</script>

<template>
  <span
    :class="cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', variants[status] || 'bg-neutral-100 text-neutral-600')"
  >
    {{ labels[status] || status }}
  </span>
</template>
