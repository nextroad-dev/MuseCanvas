<script setup lang="ts">
import { onMounted } from 'vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import MetricCard from '@/shared/components/ui/MetricCard.vue'
import DataTable from '@/shared/components/ui/DataTable.vue'
import StatusBadge from '@/shared/components/ui/StatusBadge.vue'
import type { AdminJob } from '@/shared/types'
import type { Column } from '@/shared/components/ui/DataTable.vue'

const admin = useAdminStore()

onMounted(() => {
  admin.fetchDashboard()
  admin.fetchJobs()
})

const jobColumns: Column<AdminJob>[] = [
  { key: 'id', label: '任务 ID' },
  { key: 'modelName', label: '模型' },
  {
    key: 'status',
    label: '状态',
  },
  {
    key: 'createdAt',
    label: '创建时间',
    render: (row) => new Date(row.createdAt).toLocaleString('zh-CN'),
  },
]
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="系统概览" description="查看系统汇总指标和最近任务。" />

    <!-- Metrics -->
    <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <MetricCard label="用户总数" :value="admin.metrics?.totalUsers || 0" />
      <MetricCard label="任务总数" :value="admin.metrics?.totalJobs || 0" />
      <MetricCard label="成功率 (7天)" :value="admin.metrics?.successRate7d || 0" suffix="%" />
      <MetricCard label="失败数 (7天)" :value="admin.metrics?.failedJobs7d || 0" />
    </div>

    <!-- Recent jobs -->
    <div>
      <h2 class="mb-3 text-sm font-medium text-muted-foreground">最近任务</h2>
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
    </div>
  </div>
</template>
