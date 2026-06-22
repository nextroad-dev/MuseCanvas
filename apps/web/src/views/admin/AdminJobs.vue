<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAdminStore } from '@/stores/admin'
import DataTable from '@/components/ui/DataTable.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import type { AdminJob, JobStatus } from '@/types'
import type { Column } from '@/components/ui/DataTable.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'

const admin = useAdminStore()
const filters = ref({ userId: '', status: '' as JobStatus | '', modelId: '', from: '', to: '' })

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

onMounted(() => {
  admin.fetchJobs()
  admin.fetchModels()
})

const jobColumns: Column<AdminJob>[] = [
  { key: 'id', label: '任务 ID' },
  { key: 'modelName', label: '模型' },
  { key: 'status', label: '状态' },
  {
    key: 'createdAt',
    label: '创建时间',
    render: (row) => new Date(row.createdAt).toLocaleString('zh-CN'),
  },
  {
    key: 'durationMs',
    label: '耗时',
    render: (row) => row.durationMs === undefined ? '-' : `${(row.durationMs / 1000).toFixed(1)}s`,
  },
  {
    key: 'errorCode',
    label: '错误码',
    render: (row) => row.errorCode || '-',
  },
  { key: 'providerReferenceId', label: '供应商引用', render: (row) => row.providerReferenceId || '-' },
]
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-sm font-semibold text-neutral-900">任务管理</h1>

    <div class="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2">
      <p class="text-xs text-neutral-500">
        管理员查看的任务诊断信息不包含用户提示词和图片内容。
      </p>
    </div>

    <div class="grid gap-3 rounded-xl border border-neutral-200 p-4 md:grid-cols-2 xl:grid-cols-5">
      <input v-model="filters.userId" type="text" placeholder="用户 ID" class="h-9 rounded-lg border border-neutral-200 px-3 text-xs focus:border-primary focus:outline-none" />
      <BaseSelect v-model="filters.status" aria-label="任务状态">
        <option value="">全部状态</option>
        <option value="queued">排队中</option><option value="running">生成中</option><option value="retry_wait">等待重试</option>
        <option value="succeeded">成功</option><option value="failed">失败</option><option value="canceled">已取消</option>
      </BaseSelect>
      <BaseSelect v-model="filters.modelId" aria-label="模型">
        <option value="">全部模型</option>
        <option v-for="model in admin.models" :key="model.id" :value="model.id">{{ model.displayName }}</option>
      </BaseSelect>
      <input v-model="filters.from" type="datetime-local" title="开始时间" class="h-9 rounded-lg border border-neutral-200 px-3 text-xs focus:border-primary focus:outline-none" />
      <input v-model="filters.to" type="datetime-local" title="结束时间" class="h-9 rounded-lg border border-neutral-200 px-3 text-xs focus:border-primary focus:outline-none" />
      <div class="flex gap-2 md:col-span-2 xl:col-span-5">
        <button class="h-8 rounded-lg bg-primary px-4 text-xs font-medium text-white" @click="applyFilters">筛选</button>
        <button class="h-8 rounded-lg border border-neutral-200 px-4 text-xs text-neutral-600" @click="resetFilters">重置</button>
        <span class="ml-auto self-center text-xs text-neutral-500">共 {{ admin.jobsTotal }} 条</span>
      </div>
    </div>

    <DataTable
      :columns="jobColumns"
      :data="admin.jobs"
      :row-key="(row: AdminJob) => row.id"
      empty-text="暂无任务"
    >
      <template #cell-status="{ row }">
        <StatusBadge :status="row.status" />
      </template>
    </DataTable>

    <div v-if="admin.jobsNextCursor" class="text-center">
      <button class="h-8 rounded-lg border border-neutral-200 px-4 text-xs text-neutral-600 hover:bg-neutral-50" @click="admin.fetchJobs(apiFilters(), true)">加载更多</button>
    </div>
  </div>
</template>
