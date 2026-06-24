<script setup lang="ts">
import { onMounted } from 'vue'
import DataTable from '@/shared/components/ui/DataTable.vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import { toast } from '@/shared/composables/useToast'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-vue-next'
import type { Column } from '@/shared/components/ui/DataTable.vue'
import type { PromptTemplateEntry } from '@/shared/types'

const admin = useAdminStore()

const columns: Column<PromptTemplateEntry>[] = [
  { key: 'name', label: '名称' },
  { key: 'description', label: '描述' },
  { key: 'path', label: '索引位置' },
  { key: 'resolvedPath', label: '解析位置' },
  { key: 'fileExists', label: '文件' },
  { key: 'valid', label: '校验' },
]

onMounted(async () => {
  await admin.fetchPromptTemplates()
})

async function reload() {
  const result = await admin.reloadPromptTemplates()
  toast(result.success ? '模板索引已重新加载' : result.error?.message || '重新加载失败', result.success ? 'success' : 'error')
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="提示词模板" description="查看外部只读模板索引。提示词前处理设置已移至模型管理页面。">
      <template #actions>
        <BaseButton variant="secondary" @click="reload">重新加载</BaseButton>
      </template>
    </PageHeader>

    <div class="space-y-3">
      <h2 class="text-sm font-semibold text-foreground">索引状态</h2>
      <dl class="grid gap-3 text-xs md:grid-cols-3">
        <div>
          <dt class="text-muted-foreground">索引位置</dt>
          <dd class="mt-1 break-all text-foreground">{{ admin.promptTemplates?.indexPath || '-' }}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">根目录</dt>
          <dd class="mt-1 break-all text-foreground">{{ admin.promptTemplates?.rootDirectory || '-' }}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">加载结果</dt>
          <dd class="mt-1 text-foreground">{{ admin.promptTemplates?.valid ? '校验通过' : '校验失败' }} · {{ admin.promptTemplates?.entryCount || 0 }} 条</dd>
        </div>
      </dl>
    </div>

    <DataTable :columns="columns" :data="admin.promptTemplates?.entries || []" :row-key="(row: PromptTemplateEntry) => row.path || row.name" empty-text="暂无模板条目">
      <template #cell-fileExists="{ row }">
        <CheckCircle2 v-if="row.fileExists" class="h-4 w-4 text-success" />
        <XCircle v-else class="h-4 w-4 text-danger" />
      </template>
      <template #cell-valid="{ row }">
        <CheckCircle2 v-if="row.valid" class="h-4 w-4 text-success" />
        <AlertTriangle v-else class="h-4 w-4 text-danger" :title="row.errorCode || '校验失败'" />
      </template>
    </DataTable>
  </div>
</template>
