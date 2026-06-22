<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAdminStore } from '@/stores/admin'
import DataTable from '@/components/ui/DataTable.vue'
import StatusBadge from '@/components/ui/StatusBadge.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import type { AdminUser } from '@/types'
import type { Column } from '@/components/ui/DataTable.vue'

const admin = useAdminStore()
const deleteTarget = ref<AdminUser | null>(null)
const showDeleteConfirm = ref(false)

onMounted(() => {
  admin.fetchUsers()
})

function handleToggleStatus(user: AdminUser) {
  const newStatus = user.status === 'active' ? 'disabled' : 'active'
  admin.updateUserStatus(user.id, newStatus)
}

function handleDelete(user: AdminUser) {
  deleteTarget.value = user
  showDeleteConfirm.value = true
}

function confirmDelete() {
  if (deleteTarget.value) {
    admin.deleteUser(deleteTarget.value.id)
  }
  showDeleteConfirm.value = false
  deleteTarget.value = null
}

const userColumns: Column<AdminUser>[] = [
  { key: 'email', label: '邮箱' },
  { key: 'role', label: '角色', render: (row) => row.role === 'admin' ? '管理员' : '用户' },
  { key: 'status', label: '状态' },
  {
    key: 'createdAt',
    label: '注册时间',
    render: (row) => new Date(row.createdAt).toLocaleDateString('zh-CN'),
  },
]
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-sm font-semibold text-neutral-900">用户管理</h1>
      <span class="text-xs text-neutral-500">共 {{ admin.usersTotal }} 位用户</span>
    </div>

    <DataTable
      :columns="userColumns"
      :data="admin.users"
      :row-key="(row: AdminUser) => row.id"
      empty-text="暂无用户"
    >
      <template #cell-status="{ row }">
        <StatusBadge :status="row.status" />
      </template>

      <template #actions="{ row }">
        <div class="flex items-center justify-end gap-2">
          <button
            class="text-xs text-neutral-600 hover:underline"
            @click="handleToggleStatus(row)"
          >
            {{ row.status === 'active' ? '停用' : '恢复' }}
          </button>
          <button
            class="text-xs text-danger hover:underline"
            @click="handleDelete(row)"
          >
            删除
          </button>
        </div>
      </template>
    </DataTable>

    <div v-if="admin.usersNextCursor" class="text-center">
      <button class="h-8 rounded-lg border border-neutral-200 px-4 text-xs text-neutral-600 hover:bg-neutral-50" @click="admin.fetchUsers(true)">加载更多</button>
    </div>

    <ConfirmDialog
      v-model:open="showDeleteConfirm"
      title="删除用户"
      description="此操作将软删除用户并撤销其所有会话，关联的图片和任务将由后台任务清理。"
      confirm-text="删除"
      variant="danger"
      @confirm="confirmDelete"
    />
  </div>
</template>
