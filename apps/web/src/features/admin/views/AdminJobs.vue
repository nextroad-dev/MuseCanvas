<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import DataTable from '@/shared/components/ui/DataTable.vue'
import StatusBadge from '@/shared/components/ui/StatusBadge.vue'
import BaseDropdown from '@/shared/components/ui/BaseDropdown.vue'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import AppTooltip from '@/shared/components/ui/AppTooltip.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import Field from '@/shared/components/ui/Field.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
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
  if (!row.providerError) return row.errorCode && row.status === 'failed' ? '未记录上游详情' : '-'
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

function providerReferenceLabel(row: AdminJob) {
  return row.providerReferenceId || row.providerError?.providerReferenceId || (row.providerError ? '未返回' : '-')
}

onMounted(() => {
  admin.fetchJobs()
  admin.fetchModels()
})

const jobColumns: Column<AdminJob>[] = [
  { key: 'id', label: '任务 ID', class: 'w-40 max-w-40 truncate', mono: true },
  { key: 'modelName', label: '模型', class: 'w-36 max-w-36 truncate' },
  { key: 'status', label: '状态', class: 'w-24 whitespace-nowrap' },
  { key: 'phase', label: '处理阶段', class: 'w-28 whitespace-nowrap', render: row => row.phase || '-' },
  { key: 'templateName', label: '最终模板', class: 'w-32 max-w-32 truncate', render: row => row.templateName || '待选择' },
  { key: 'languageModelName', label: '优化模型', class: 'w-56 max-w-56 truncate', render: row => row.languageModelName ? `${row.languageModelName} · ${row.languageModelVendorId || ''} · ${row.languageModelProtocol || ''}` : '-' },
  {
    key: 'createdAt',
    label: '创建时间',
    class: 'w-40 whitespace-nowrap',
    mono: true,
    render: (row) => new Date(row.createdAt).toLocaleString('zh-CN'),
  },
  {
    key: 'durationMs',
    label: '耗时',
    class: 'w-20 whitespace-nowrap',
    align: 'right',
    render: (row) => row.durationMs === undefined ? '-' : `${(row.durationMs / 1000).toFixed(1)}s`,
  },
  {
    key: 'quotedCredits',
    label: '消耗积分',
    class: 'w-20 whitespace-nowrap',
    align: 'right',
    render: (row) => row.quotedCredits != null ? `${row.quotedCredits}` : '-',
  },
  {
    key: 'errorCode',
    label: '错误码',
    class: 'w-36 max-w-36 truncate',
    mono: true,
    render: (row) => row.errorCode || '-',
  },
  {
    key: 'providerError',
    label: '上游返回',
    class: 'w-64 max-w-64',
    render: providerErrorLabel,
  },
  { key: 'providerReferenceId', label: '供应商引用', class: 'w-36 max-w-36 truncate', mono: true, render: providerReferenceLabel },
]

const hasActiveFilters = computed(() => {
  const f = filters.value
  return !!(f.userId || f.status || f.modelId || f.from || f.to)
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="任务监控" :description="`共 ${admin.jobsTotal} 条`" />

    <div class="space-y-3">
      <div class="flex flex-wrap items-end gap-3">
        <div>
          <span id="jobs-status-label" class="mb-1 block text-xs font-medium text-muted-foreground">状态</span>
          <BaseDropdown v-model="filters.status" :options="statusOptions" label="状态筛选" aria-labelledby="jobs-status-label" />
        </div>
        <div>
          <span id="jobs-model-label" class="mb-1 block text-xs font-medium text-muted-foreground">模型</span>
          <BaseDropdown v-model="filters.modelId" :options="modelOptions" label="模型筛选" aria-labelledby="jobs-model-label" />
        </div>
        <Field label="用户 ID" class="w-48">
          <TextInput v-model="filters.userId" placeholder="可选" />
        </Field>
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <Field label="开始时间">
          <TextInput v-model="filters.from" type="datetime-local" />
        </Field>
        <Field label="结束时间">
          <TextInput v-model="filters.to" type="datetime-local" />
        </Field>
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
      :filtered="hasActiveFilters"
      empty-text="暂无任务"
    >
      <template #cell-status="{ row }">
        <div class="whitespace-nowrap">
          <StatusBadge :status="row.status" />
        </div>
      </template>
      <template #cell-providerError="{ row }">
        <div v-if="row.providerError" class="max-w-64">
          <AppTooltip :text="providerErrorDetail(row)">
            <p class="truncate font-mono text-xs text-foreground">
              {{ providerErrorLabel(row) }}
            </p>
          </AppTooltip>
          <p v-if="row.providerError.detail" class="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {{ row.providerError.detail }}
          </p>
        </div>
        <span v-else class="text-muted-foreground">-</span>
      </template>
    </DataTable>

    <div v-if="admin.jobsNextCursor" class="text-center">
      <BaseButton variant="secondary" size="sm" @click="admin.fetchJobs(apiFilters(), true)">
        加载更多
      </BaseButton>
    </div>
  </div>
</template>
