<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import DataTable from '@/shared/components/ui/DataTable.vue'
import type { Column } from '@/shared/components/ui/DataTable.vue'
import BaseDropdown from '@/shared/components/ui/BaseDropdown.vue'
import PillToggle from '@/shared/components/ui/PillToggle.vue'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import AppModal from '@/shared/components/ui/AppModal.vue'
import { Plug } from 'lucide-vue-next'
import { toast } from '@/shared/composables/useToast'
import type { ProviderCredential, ProviderCredentialInput, ModelAdapter } from '@/shared/types'

const admin = useAdminStore()

const loading = ref(true)
const loadError = ref('')
const showDialog = ref(false)
const editing = ref<ProviderCredential | null>(null)
const saving = ref(false)
const formError = ref('')
const deleteTarget = ref<ProviderCredential | null>(null)
const testingId = ref<string | null>(null)

const form = ref({
  displayName: '',
  adapter: 'openai' as ModelAdapter,
  baseUrl: '',
  apiKey: '',
  enabled: true,
})

const adapterOptions = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'seedream', label: 'Seedream (火山引擎)' },
  { value: 'anthropic', label: 'Anthropic' },
]

const TEST_ERROR_LABELS: Record<string, string> = {
  CONNECTIVITY_FAILED: '无法连接供应商，请检查 API Key 与 Base URL',
  NO_API_KEY: '尚未配置 API Key',
  INVALID_BASE_URL: 'Base URL 不是安全的 HTTPS 地址',
  PROVIDER_REJECTED: '已连通，但供应商拒绝了请求，请检查模型授权或 API Key 权限',
  PROVIDER_TEMPORARY_ERROR: '供应商暂时不可用，请稍后重试',
  PROVIDER_EMPTY_RESULT: '供应商没有返回可用图片结果',
}

onMounted(async () => {
  loading.value = true
  loadError.value = ''
  try {
    await admin.fetchProviderCredentials()
  } catch {
    loadError.value = '加载供应商凭据失败'
  } finally {
    loading.value = false
  }
})

function openCreate() {
  editing.value = null
  formError.value = ''
  form.value = { displayName: '', adapter: 'openai', baseUrl: '', apiKey: '', enabled: true }
  showDialog.value = true
}

function openEdit(cred: ProviderCredential) {
  editing.value = cred
  formError.value = ''
  form.value = {
    displayName: cred.displayName,
    adapter: cred.adapter,
    baseUrl: cred.baseUrl || '',
    apiKey: '',
    enabled: cred.enabled,
  }
  showDialog.value = true
}

async function handleSave() {
  if (!form.value.displayName.trim()) {
    formError.value = '请填写凭据名称'
    return
  }
  saving.value = true
  formError.value = ''
  const payload: ProviderCredentialInput = {
    displayName: form.value.displayName.trim(),
    baseUrl: form.value.baseUrl.trim(),
    enabled: form.value.enabled,
  }
  // API Key is write-only: only send when the admin typed a new one (rotation).
  if (form.value.apiKey.trim()) payload.apiKey = form.value.apiKey.trim()

  const res = editing.value
    ? await admin.updateProviderCredential(editing.value.id, payload)
    : await admin.createProviderCredential({ ...payload, adapter: form.value.adapter })
  saving.value = false
  if (res.success) {
    showDialog.value = false
    toast(editing.value ? '凭据已更新' : '凭据已创建', 'success')
  } else {
    formError.value = res.error?.message || '保存失败'
  }
}

async function handleToggle(cred: ProviderCredential) {
  const res = await admin.updateProviderCredential(cred.id, { enabled: !cred.enabled })
  if (!res.success) toast(res.error?.message || '操作失败', 'error')
}

async function handleTest(cred: ProviderCredential) {
  testingId.value = cred.id
  const res = await admin.testProviderCredential(cred.id)
  testingId.value = null
  if (res.success) toast(`「${cred.displayName}」连接测试通过`, 'success')
  else toast(TEST_ERROR_LABELS[res.error?.code || ''] || res.error?.message || '测试失败', 'error')
}

async function confirmDelete() {
  const target = deleteTarget.value
  if (!target) return
  const res = await admin.deleteProviderCredential(target.id)
  deleteTarget.value = null
  if (res.success) toast('凭据已删除', 'success')
  else toast(res.error?.message || '删除失败', 'error')
}

function hostOf(url: string) {
  try { return new URL(url).host } catch { return '默认地址' }
}

function fmtDate(iso?: string) {
  return iso ? new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

const testStatusLabel: Record<string, string> = { success: '通过', failed: '失败', not_tested: '未测试' }
function adapterLabel(adapter: ModelAdapter) {
  return adapter === 'openai' ? 'OpenAI 兼容' : adapter === 'anthropic' ? 'Anthropic' : 'Seedream'
}

const columns: Column<ProviderCredential>[] = [
  { key: 'displayName', label: '名称' },
  { key: 'adapter', label: '供应商', render: (r) => adapterLabel(r.adapter) },
  { key: 'baseUrl', label: 'API 主机', render: (r) => (r.baseUrl ? hostOf(r.baseUrl) : '默认地址') },
  { key: 'hasApiKey', label: 'API Key' },
  { key: 'lastTestStatus', label: '最近测试' },
  { key: 'enabled', label: '启用' },
]

const isEmpty = computed(() => !loading.value && !loadError.value && admin.providerCredentials.length === 0)
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="供应商凭据"
      description="配置生图供应商的 API Key 与 Base URL，密钥仅写入、不可回读。"
    >
      <template #actions>
        <button
          class="inline-flex h-8 items-center rounded-[var(--radius-control)] bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          @click="openCreate"
        >
          添加凭据
        </button>
      </template>
    </PageHeader>

    <!-- Loading -->
    <div v-if="loading" class="py-12 text-center text-xs text-muted-foreground">
      加载中…
    </div>

    <!-- Load error -->
    <div v-else-if="loadError" class="py-8 text-center">
      <p class="text-xs text-danger">{{ loadError }}</p>
      <button class="mt-3 text-xs font-medium text-primary hover:underline" @click="() => admin.fetchProviderCredentials()">重试</button>
    </div>

    <!-- Empty -->
    <div v-else-if="isEmpty" class="py-12 text-center">
      <Plug class="mx-auto h-8 w-8 text-muted-foreground" />
      <p class="mt-3 text-sm text-muted-foreground">暂无供应商凭据</p>
      <p class="mt-1 text-xs text-muted-foreground">添加凭据后，可在模型管理中关联使用。</p>
    </div>

    <!-- Table -->
    <DataTable
      v-else
      :columns="columns"
      :data="admin.providerCredentials"
      :row-key="(row: ProviderCredential) => row.id"
      empty-text="暂无供应商凭据"
    >
      <template #cell-hasApiKey="{ row }">
        <span v-if="row.hasApiKey" class="inline-flex items-center gap-1.5 text-xs text-foreground">
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-success" />
          已配置<span v-if="row.keyFingerprint" class="font-mono text-muted-foreground">·{{ row.keyFingerprint }}</span>
        </span>
        <span v-else class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-neutral-300" />
          未配置
        </span>
      </template>

      <template #cell-lastTestStatus="{ row }">
        <span
          :class="[
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
            row.lastTestStatus === 'success' ? 'bg-success-soft text-success'
              : row.lastTestStatus === 'failed' ? 'bg-danger-soft text-danger'
              : 'bg-neutral-100 text-neutral-500',
          ]"
        >
          {{ testStatusLabel[row.lastTestStatus] || row.lastTestStatus }}
        </span>
        <span class="ml-2 text-xs text-muted-foreground">{{ fmtDate(row.lastTestedAt) }}</span>
      </template>

      <template #cell-enabled="{ row }">
        <PillToggle :model-value="row.enabled" @update:model-value="() => handleToggle(row)" />
      </template>

      <template #actions="{ row }">
        <div class="flex items-center justify-end gap-3">
          <button
            class="text-xs text-foreground hover:underline disabled:opacity-50"
            :disabled="testingId === row.id"
            @click="handleTest(row)"
          >
            {{ testingId === row.id ? '测试中…' : '测试连接' }}
          </button>
          <button class="text-xs text-foreground hover:underline" @click="openEdit(row)">编辑</button>
          <button class="text-xs text-danger hover:underline" @click="deleteTarget = row">删除</button>
        </div>
      </template>
    </DataTable>

    <AppModal v-model:open="showDialog" :title="editing ? '编辑凭据' : '添加凭据'">
      <div class="space-y-3">
        <div>
          <label class="mb-1 block text-xs font-medium text-foreground">凭据名称</label>
          <input
            v-model="form.displayName"
            type="text"
            placeholder="例如：OpenAI 兼容主账号"
            class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-foreground">供应商类型</label>
          <BaseDropdown v-model="form.adapter" :options="adapterOptions" :disabled="!!editing" />
          <p v-if="editing" class="mt-1 text-xs text-muted-foreground">供应商类型创建后不可修改。</p>
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-foreground">API Base URL</label>
          <input
            v-model="form.baseUrl"
            type="url"
            :placeholder="form.adapter === 'openai' ? 'https://api.openai.com' : form.adapter === 'anthropic' ? 'https://api.anthropic.com' : 'https://ark.cn-beijing.volces.com'"
            class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <p class="mt-1 text-xs text-muted-foreground">必须是安全的 HTTPS 地址；留空使用供应商默认地址。</p>
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-foreground">API Key</label>
          <input
            v-model="form.apiKey"
            type="password"
            autocomplete="off"
            :placeholder="editing?.hasApiKey ? '已配置（留空保持不变）' : '输入 API Key'"
            class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <p class="mt-1 text-xs text-muted-foreground">密钥仅加密写入，保存后不可回读；填写新值即轮换。</p>
        </div>
        <div class="flex items-center gap-2">
          <PillToggle v-model="form.enabled" />
          <span class="text-xs font-medium text-foreground">启用该凭据</span>
        </div>
        <div v-if="formError" class="text-xs text-danger">{{ formError }}</div>
      </div>
      <template #footer="{ close }">
        <button
          class="inline-flex h-9 items-center rounded-[var(--radius-control)] border border-border px-4 text-sm font-medium text-foreground hover:bg-surface-subtle"
          @click="close"
        >
          取消
        </button>
        <button
          :disabled="saving || !form.displayName.trim()"
          class="inline-flex h-9 items-center rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          @click="handleSave"
        >
          {{ saving ? '保存中…' : editing ? '保存' : '添加' }}
        </button>
      </template>
    </AppModal>

    <ConfirmDialog
      :open="!!deleteTarget"
      title="删除供应商凭据"
      :description="`确认删除「${deleteTarget?.displayName || ''}」？若仍被模型引用将无法删除。`"
      confirm-text="删除"
      variant="danger"
      @update:open="(v: boolean) => { if (!v) deleteTarget = null }"
      @confirm="confirmDelete"
    />
  </div>
</template>
