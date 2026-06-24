<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import DataTable from '@/shared/components/ui/DataTable.vue'
import StatusBadge from '@/shared/components/ui/StatusBadge.vue'
import BaseDropdown from '@/shared/components/ui/BaseDropdown.vue'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import type { AdminJob, JobStatus } from '@/shared/types'
import type { Column } from '@/shared/components/ui/DataTable.vue'

const admin = useAdminStore()
const filters = ref({ userId: '', status: '' as JobStatus | '', modelId: '', from: '', to: '' })

const statusOptions = [
  { value: '', label: '全部' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '生成中' },
  { value: 'retry_wait', label: '等待重试' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '已取消' },
]

const modelOptions = computed(() => [
  { value: '', label: '全部' },
  ...admin.models.map(m => ({ value: m.id, label: m.displayName })),
])

function apiFilters() {
  return {
    userId: filters.value.userId.trim(),
    status: filters.value.status,
    modelId: filters.value.modelId,
    from: filters.value.from ? new Date(filters.value.from).toISOString() : '',
    to: filters.value.to ? new Date(filters.value.to).toISOString() : '',
  }
}

function applyFilters() { admin.fetchJobs(apiFilters()) }
function resetFilters() {
  filters.value = { userId: '', status: '', modelId: '', from: '', to: '' }
  admin.fetchJobs()
}

function providerErrorLabel(row: AdminJob) {
  if (!row.providerError) return '-'
  const status = row.providerError.status ? `HTTP ${row.providerError.status}` : '上游错误'
  return row.providerError.statusText ? `${status} ${row.providerError.statusText}` : status
}

function providerErrorDetail(row: AdminJob) {
  if (!row.providerError) return ''
  const error = row.providerError
  return [
    error.adapter ? `adapter=${error.adapter}` : '',
    error.endpoint ? `endpoint=${error.endpoint}` : '',
    error.occurredAt ? `time=${new Date(error.occurredAt).toLocaleString('zh-CN')}` : '',
    error.detail || '',
  ].filter(Boolean).join('\n')
}

onMounted(() => {
  admin.fetchJobs()
  admin.fetchModels()
})

const jobColumns: Column<AdminJob>[] = [
  { key: 'id', label: '任务 ID', class: 'w-40 max-w-40 truncate font-mono text-xs' },
  { key: 'modelName', label: '模型', class: 'w-36 max-w-36 truncate' },
  { key: 'status', label: '状态', class: 'w-24 whitespace-nowrap' },
  { key: 'phase', label: '处理阶段', class: 'w-28 whitespace-nowrap', render: row => row.phase || '-' },
  { key: 'templateName', label: '最终模板', class: 'w-32 max-w-32 truncate', render: row => row.templateName || '待选择' },
  { key: 'languageModelName', label: '优化模型', class: 'w-56 max-w-56 truncate', render: row => row.languageModelName ? `${row.languageModelName} · ${row.languageModelVendorId || ''} · ${row.languageModelProtocol || ''}` : '-' },
  {
    key: 'createdAt',
    label: '创建时间',
    class: 'w-40 whitespace-nowrap',
    render: (row) => new Date(row.createdAt).toLocaleString('zh-CN'),
  },
  {
    key: 'durationMs',
    label: '耗时',
    class: 'w-20 whitespace-nowrap',
    render: (row) => row.durationMs === undefined ? '-' : `${(row.durationMs / 1000).toFixed(1)}s`,
  },
  {
    key: 'errorCode',
    label: '错误码',
    class: 'w-36 max-w-36 truncate',
    render: (row) => row.errorCode || '-',
  },
  {
    key: 'providerError',
    label: '上游返回',
    class: 'w-64 max-w-64',
    render: providerErrorLabel,
  },
  { key: 'providerReferenceId', label: '供应商引用', class: 'w-36 max-w-36 truncate', render: (row) => row.providerReferenceId || '-' },
]
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="任务监控" :description="`共 ${admin.jobsTotal} 条`" />

    <div class="space-y-3">
      <div class="flex flex-wrap items-end gap-3">
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground">状态</label>
          <BaseDropdown v-model="filters.status" :options="statusOptions" />
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground">模型</label>
          <BaseDropdown v-model="filters.modelId" :options="modelOptions" />
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground">用户 ID</label>
          <input v-model="filters.userId" type="text" placeholder="可选" class="h-9 w-48 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground">开始时间</label>
          <input v-model="filters.from" type="datetime-local" class="h-9 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground">结束时间</label>
          <input v-model="filters.to" type="datetime-local" class="h-9 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>
        <div class="flex gap-2">
          <BaseButton size="sm" @click="applyFilters">筛选</BaseButton>
          <BaseButton size="sm" variant="secondary" @click="resetFilters">重置</BaseButton>
        </div>
      </div>
    </div>

    <DataTable
      :columns="jobColumns"
      :data="admin.jobs"
      :row-key="(row: AdminJob) => row.id"
      empty-text="暂无任务"
    >
      <template #cell-status="{ row }">
        <div class="whitespace-nowrap">
          <StatusBadge :status="row.status" />
        </div>
      </template>
      <template #cell-providerError="{ row }">
        <div v-if="row.providerError" class="max-w-64">
          <p class="truncate font-mono text-xs text-foreground" :title="providerErrorDetail(row)">
            {{ providerErrorLabel(row) }}
          </p>
          <p v-if="row.providerError.detail" class="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground" :title="providerErrorDetail(row)">
            {{ row.providerError.detail }}
          </p>
        </div>
        <span v-else class="text-muted-foreground">-</span>
      </template>
    </DataTable>

    <div v-if="admin.jobsNextCursor" class="text-center">
      <button class="h-8 rounded-[var(--radius-control)] border border-border px-4 text-xs text-muted-foreground hover:bg-surface-subtle" @click="admin.fetchJobs(apiFilters(), true)">加载更多</button>
    </div>
  </div>
</template>
