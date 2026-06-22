<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAdminStore } from '@/stores/admin'
import DataTable from '@/components/ui/DataTable.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import type { Invitation } from '@/types'
import type { Column } from '@/components/ui/DataTable.vue'

const admin = useAdminStore()
const showCreateDialog = ref(false)
const newEmail = ref('')
const newCount = ref(1)
const revokeTarget = ref<Invitation | null>(null)
const showRevokeConfirm = ref(false)

onMounted(() => {
  admin.fetchRegistration()
  admin.fetchInvitations()
})

function handleToggleMode() {
  const newMode = admin.registrationMode === 'open' ? 'invite_only' : 'open'
  admin.setRegistrationMode(newMode)
}

async function handleCreate() {
  if (!newEmail.value.trim()) return
  await admin.createInvitation(newEmail.value.trim(), newCount.value)
  showCreateDialog.value = false
  newEmail.value = ''
  newCount.value = 1
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

const inviteColumns: Column<Invitation>[] = [
  { key: 'email', label: '邮箱' },
  { key: 'code', label: '邀请码（仅本次显示）', render: (row) => row.code || '已隐藏' },
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
    <h1 class="text-sm font-semibold text-neutral-900">注册管理</h1>

    <!-- Registration mode toggle -->
    <div class="flex items-center justify-between rounded-xl border border-neutral-200 px-4 py-3">
      <div>
        <p class="text-sm font-medium text-neutral-900">注册模式</p>
        <p class="text-xs text-neutral-500">
          当前：<span class="font-medium text-neutral-700">
            {{ admin.registrationMode === 'open' ? '开放注册' : '邀请码注册' }}
          </span>
        </p>
      </div>
      <button
        :class="[
          'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
          admin.registrationMode === 'invite_only' ? 'bg-primary' : 'bg-neutral-300',
        ]"
        @click="handleToggleMode"
      >
        <span
          :class="[
            'inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
            admin.registrationMode === 'invite_only' ? 'translate-x-6' : 'translate-x-1',
          ]"
        />
      </button>
    </div>

    <!-- Invitations -->
    <div>
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-xs font-medium text-neutral-500">邀请码</h2>
        <button
          class="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
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
    </div>

    <!-- Create invitation dialog -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="showCreateDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div class="relative z-10 w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-6 shadow-xl">
            <h3 class="mb-4 text-sm font-semibold text-neutral-900">创建邀请码</h3>
            <div class="space-y-3">
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-700">目标邮箱</label>
                <input
                  v-model="newEmail"
                  type="email"
                  placeholder="guest@example.com"
                  class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-700">数量</label>
                <input
                  v-model.number="newCount"
                  type="number"
                  min="1"
                  max="50"
                  class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            <div class="mt-4 flex justify-end gap-2">
              <button
                class="inline-flex h-9 items-center rounded-lg border border-neutral-200 px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                @click="showCreateDialog = false"
              >
                取消
              </button>
              <button
                :disabled="!newEmail.trim()"
                class="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
                @click="handleCreate"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Revoke confirmation -->
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

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
