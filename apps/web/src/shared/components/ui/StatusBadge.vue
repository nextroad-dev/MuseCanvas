<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/shared/lib/utils'
import type { JobStatus, UserStatus } from '@/shared/types'

type Variant = 'soft' | 'outline' | 'solid'

const props = defineProps<{
  status: JobStatus | UserStatus | string
  variant?: Variant
}>()

const statusConfig: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' | 'warning' }> = {
  // Job statuses
  queued: { label: '排队中', tone: 'neutral' },
  running: { label: '生成中', tone: 'info' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'neutral' },
  retry_wait: { label: '重试中', tone: 'warning' },
  // User statuses
  active: { label: '正常', tone: 'success' },
  disabled: { label: '已停用', tone: 'danger' },
}

const config = computed(() => {
  return statusConfig[props.status] || { label: props.status, tone: 'neutral' as const }
})

const toneClasses: Record<typeof config.value.tone, { soft: string; outline: string; solid: string }> = {
  neutral: {
    soft: 'bg-neutral-soft text-neutral-status',
    outline: 'border border-border bg-transparent text-foreground',
    solid: 'bg-neutral-status text-white',
  },
  info: {
    soft: 'bg-info-soft text-info',
    outline: 'border border-info bg-transparent text-info',
    solid: 'bg-info text-white',
  },
  success: {
    soft: 'bg-success-soft text-success',
    outline: 'border border-success bg-transparent text-success',
    solid: 'bg-success text-white',
  },
  danger: {
    soft: 'bg-danger-soft text-danger',
    outline: 'border border-danger bg-transparent text-danger',
    solid: 'bg-danger text-white',
  },
  warning: {
    soft: 'bg-warning-soft text-warning',
    outline: 'border border-warning bg-transparent text-warning',
    solid: 'bg-warning text-white',
  },
}

const baseClasses = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium'

const variantClasses = computed(() => {
  return toneClasses[config.value.tone][props.variant || 'soft']
})
</script>

<template>
  <span :class="cn(baseClasses, variantClasses)">
    {{ config.label }}
  </span>
</template>
