<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import DataTable from '@/shared/components/ui/DataTable.vue'
import StatusBadge from '@/shared/components/ui/StatusBadge.vue'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import AppModal from '@/shared/components/ui/AppModal.vue'
import PillToggle from '@/shared/components/ui/PillToggle.vue'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import type { AdminUser, Invitation } from '@/shared/types'
import type { Column } from '@/shared/components/ui/DataTable.vue'

const admin = useAdminStore()
const deleteTarget = ref<AdminUser | null>(null)
const showDeleteConfirm = ref(false)
const revokeTarget = ref<Invitation | null>(null)
const showRevokeConfirm = ref(false)
const showCreateDialog = ref(false)

onMounted(() => {
  admin.fetchUsers()
  admin.fetchRegistration()
  admin.fetchInvitations()
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

function handleRegistrationToggle(value: boolean) {
  admin.setRequiresInvitation(value)
}

async function handleCreateInvitation() {
  await admin.createInvitation()
  showCreateDialog.value = false
}

function handleRevoke(invite: Invitation) {
  revokeTarget.value = invite
  showRevokeConfirm.value = true
}

function confirmRevoke() {
  if (revokeTarget.value) {
    admin.revokeInvitation(revokeTarget.value.id)
  }
  showRevokeConfirm.value = false
  revokeTarget.value = null
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

const inviteColumns: Column<Invitation>[] = [
  { key: 'code', label: '邀请码', render: (row) => row.code || '-' },
  {
    key: 'used',
    label: '状态',
    render: (row) => row.revoked ? '已撤销' : row.used ? '已使用' : '未使用',
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
    <PageHeader
      title="用户管理"
      description="管理用户、注册策略和邀请码。"
    >
      <template #actions>
        <span class="text-xs text-muted-foreground">共 {{ admin.usersTotal }} 位用户</span>
      </template>
    </PageHeader>

    <div class="flex items-center justify-between gap-4">
      <div>
        <h2 class="text-sm font-medium text-foreground">注册控制</h2>
        <p class="mt-1 text-xs text-muted-foreground">
          当前：{{ admin.requiresInvitation ? '未注册用户需要邀请码' : '开放注册，未注册用户可直接验证邮箱' }}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-xs font-medium text-foreground">使用邀请码</span>
        <PillToggle
          :model-value="admin.requiresInvitation"
          @update:model-value="handleRegistrationToggle"
        />
      </div>
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
            class="text-xs text-foreground hover:underline"
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
      <button class="h-8 rounded-[var(--radius-control)] border border-border px-4 text-xs text-muted-foreground hover:bg-surface-subtle" @click="admin.fetchUsers(true)">加载更多</button>
    </div>

    <section class="space-y-3">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-sm font-medium text-foreground">邀请码</h2>
          <p class="mt-1 text-xs text-muted-foreground">每个邀请码不绑定邮箱，只能被一个新用户使用一次。</p>
        </div>
        <button
          class="inline-flex h-8 items-center rounded-[var(--radius-control)] bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
          @click="showCreateDialog = true"
        >
          创建邀请码
        </button>
      </div>

      <DataTable
        :columns="inviteColumns"
        :data="admin.invitations"
        :row-key="(row: Invitation) => row.id"
        empty-text="暂无邀请码"
      >
        <template #actions="{ row }">
          <button
            v-if="!row.used && !row.revoked"
            class="text-xs text-danger hover:underline"
            @click="handleRevoke(row)"
          >
            撤销
          </button>
        </template>
      </DataTable>
    </section>

    <AppModal v-model:open="showCreateDialog" title="创建邀请码">
      <p class="text-sm text-muted-foreground">
        系统将生成 1 个不绑定邮箱的一次性邀请码。创建后请及时交给需要注册的用户。
      </p>
      <template #footer="{ close }">
        <button
          class="inline-flex h-9 items-center rounded-[var(--radius-control)] border border-border px-4 text-sm font-medium text-foreground hover:bg-surface-subtle"
          @click="close"
        >
          取消
        </button>
        <button
          class="inline-flex h-9 items-center rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-white hover:bg-primary-hover"
          @click="handleCreateInvitation"
        >
          创建
        </button>
      </template>
    </AppModal>

    <ConfirmDialog
      v-model:open="showDeleteConfirm"
      title="删除用户"
      description="此操作将软删除用户并撤销其所有会话，关联的图片和任务将由后台任务清理。"
      confirm-text="删除"
      variant="danger"
      @confirm="confirmDelete"
    />

    <ConfirmDialog
      v-model:open="showRevokeConfirm"
      title="撤销邀请码"
      description="撤销后该邀请码将无法使用。"
      confirm-text="撤销"
      variant="danger"
      @confirm="confirmRevoke"
    />
  </div>
</template>
