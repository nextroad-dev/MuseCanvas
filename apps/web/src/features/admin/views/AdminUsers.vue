<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import DataTable from '@/shared/components/ui/DataTable.vue'
import StatusBadge from '@/shared/components/ui/StatusBadge.vue'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import AppModal from '@/shared/components/ui/AppModal.vue'
import PillToggle from '@/shared/components/ui/PillToggle.vue'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
import Field from '@/shared/components/ui/Field.vue'
import { toast } from '@/shared/composables/useToast'
import type { AdminUser, Invitation } from '@/shared/types'
import type { Column } from '@/shared/components/ui/DataTable.vue'

const admin = useAdminStore()
const deleteTarget = ref<AdminUser | null>(null)
const showDeleteConfirm = ref(false)
const revokeTarget = ref<Invitation | null>(null)
const showRevokeConfirm = ref(false)
const showCreateDialog = ref(false)

const adjustTarget = ref<AdminUser | null>(null)
const showAdjustDialog = ref(false)
const adjustType = ref<'add' | 'deduct'>('add')
const adjustAmount = ref<number | null>(null)
const adjustNote = ref('')
const adjustLoading = ref(false)
const adjustIdempotencyKey = ref('')

function generateIdempotencyKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `adj-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function openAdjustDialog(user: AdminUser) {
  adjustTarget.value = user
  adjustType.value = 'add'
  adjustAmount.value = null
  adjustNote.value = ''
  adjustIdempotencyKey.value = generateIdempotencyKey()
  showAdjustDialog.value = true
}

const isAdjustValid = () => {
  if (!adjustTarget.value) return false
  const amt = adjustAmount.value
  if (amt === null || !Number.isInteger(amt) || amt <= 0) return false
  if (adjustType.value === 'deduct') {
    const available = adjustTarget.value.credits?.availableCredits ?? 0
    if (amt > available) return false
  }
  if (!adjustNote.value.trim()) return false
  return true
}

async function handleConfirmAdjust() {
  if (!adjustTarget.value || !isAdjustValid()) return
  const amt = adjustAmount.value!
  const finalAmount = adjustType.value === 'add' ? amt : -amt

  adjustLoading.value = true
  if (!adjustIdempotencyKey.value) {
    adjustIdempotencyKey.value = generateIdempotencyKey()
  }
  const res = await admin.adjustUserCredits(adjustTarget.value.id, {
    amount: finalAmount,
    note: adjustNote.value.trim(),
    idempotencyKey: adjustIdempotencyKey.value,
  })
  adjustLoading.value = false

  if (res.success) {
    toast('调账成功', 'success')
    showAdjustDialog.value = false
    adjustTarget.value = null
    adjustIdempotencyKey.value = ''
  } else {
    toast(res.error?.message || '调账失败', 'error')
  }
}
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
  {
    key: 'credits',
    label: '积分余额',
    render: (row) => row.credits ? `${row.credits.availableCredits} (冻结 ${row.credits.reservedCredits})` : '0',
  },
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
            class="text-xs text-primary hover:underline"
            @click="openAdjustDialog(row)"
          >
            调账
          </button>
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
        <BaseButton size="sm" @click="showCreateDialog = true">
          创建邀请码
        </BaseButton>
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
        <BaseButton variant="secondary" @click="close">
          取消
        </BaseButton>
        <BaseButton variant="primary" @click="handleCreateInvitation">
          创建
        </BaseButton>
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

    <!-- Adjust Credits Dialog -->
    <AppModal
      :open="showAdjustDialog"
      title="用户积分调账"
      @update:open="(v: boolean) => { showAdjustDialog = v; if (!v) { adjustTarget = null; adjustIdempotencyKey = '' } }"
    >
      <div v-if="adjustTarget" class="space-y-4">
        <div class="rounded-[var(--radius-card)] bg-surface-subtle p-3 text-xs text-muted-foreground">
          <p>目标用户：<strong class="text-foreground">{{ adjustTarget.email }}</strong></p>
          <p class="mt-1">
            当前可用积分：<strong class="text-foreground">{{ adjustTarget.credits?.availableCredits ?? 0 }}</strong>
            （冻结中：{{ adjustTarget.credits?.reservedCredits ?? 0 }}）
          </p>
        </div>

        <div>
          <label class="block text-xs font-medium text-foreground">调账方向</label>
          <div class="mt-1.5 flex gap-3">
            <label class="flex items-center gap-1.5 text-xs text-foreground cursor-pointer">
              <input
                v-model="adjustType"
                type="radio"
                value="add"
                class="text-primary focus:ring-primary"
              />
              增加积分
            </label>
            <label class="flex items-center gap-1.5 text-xs text-foreground cursor-pointer">
              <input
                v-model="adjustType"
                type="radio"
                value="deduct"
                class="text-primary focus:ring-primary"
              />
              扣减积分
            </label>
          </div>
        </div>

        <Field label="调账积分数（正整数）" :error="adjustType === 'deduct' && adjustAmount && adjustAmount > (adjustTarget.credits?.availableCredits ?? 0) ? `扣减额度不能大于当前可用积分（${adjustTarget.credits?.availableCredits ?? 0}）` : undefined">
          <input
            v-model.number="adjustAmount"
            type="number"
            min="1"
            step="1"
            placeholder="输入正整数，例如 100"
            class="mt-1 block w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          />
        </Field>

        <Field label="调账原因 / 备注" required>
          <TextInput
            v-model="adjustNote"
            type="text"
            placeholder="例如：运营活动奖励、人工补偿等"
          />
        </Field>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <BaseButton
            variant="secondary"
            size="sm"
            @click="() => { showAdjustDialog = false; adjustTarget = null; adjustIdempotencyKey = '' }"
          >
            取消
          </BaseButton>
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="!isAdjustValid() || adjustLoading"
            :loading="adjustLoading"
            @click="handleConfirmAdjust"
          >
            确认调账
          </BaseButton>
        </div>
      </template>
    </AppModal>
  </div>
</template>
