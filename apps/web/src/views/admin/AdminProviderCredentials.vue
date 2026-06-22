<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAdminStore } from '@/stores/admin'
import DataTable from '@/components/ui/DataTable.vue'
import type { Column } from '@/components/ui/DataTable.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { CheckCircle, AlertCircle, Plug } from 'lucide-vue-next'
import type { ProviderCredential, ProviderCredentialInput, ModelAdapter } from '@/types'

const admin = useAdminStore()

const loading = ref(true)
const loadError = ref('')
const showDialog = ref(false)
const editing = ref<ProviderCredential | null>(null)
const saving = ref(false)
const formError = ref('')
const deleteTarget = ref<ProviderCredential | null>(null)
const testingId = ref<string | null>(null)
const alert = ref<{ kind: 'success' | 'error'; text: string } | null>(null)
let alertTimer: ReturnType<typeof setTimeout> | undefined

const form = ref({
  displayName: '',
  adapter: 'openai' as ModelAdapter,
  baseUrl: '',
  apiKey: '',
  enabled: true,
})

const TEST_ERROR_LABELS: Record<string, string> = {
  CONNECTIVITY_FAILED: '无法连接供应商，请检查 API Key 与 Base URL',
  NO_API_KEY: '尚未配置 API Key',
  INVALID_BASE_URL: 'Base URL 不是安全的 HTTPS 地址',
}

function showAlert(kind: 'success' | 'error', text: string) {
  alert.value = { kind, text }
  if (alertTimer) clearTimeout(alertTimer)
  alertTimer = setTimeout(() => (alert.value = null), 5000)
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
    showAlert('success', editing.value ? '凭据已更新' : '凭据已创建')
  } else {
    formError.value = res.error?.message || '保存失败'
  }
}

async function handleToggle(cred: ProviderCredential) {
  const res = await admin.updateProviderCredential(cred.id, { enabled: !cred.enabled })
  if (!res.success) showAlert('error', res.error?.message || '操作失败')
}

async function handleTest(cred: ProviderCredential) {
  testingId.value = cred.id
  const res = await admin.testProviderCredential(cred.id)
  testingId.value = null
  if (res.success) showAlert('success', `「${cred.displayName}」连接测试通过`)
  else showAlert('error', TEST_ERROR_LABELS[res.error?.code || ''] || res.error?.message || '测试失败')
}

async function confirmDelete() {
  const target = deleteTarget.value
  if (!target) return
  const res = await admin.deleteProviderCredential(target.id)
  deleteTarget.value = null
  if (res.success) showAlert('success', '凭据已删除')
  else showAlert('error', res.error?.message || '删除失败')
}

function hostOf(url: string) {
  try { return new URL(url).host } catch { return '默认地址' }
}

function fmtDate(iso?: string) {
  return iso ? new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

const testStatusLabel: Record<string, string> = { success: '通过', failed: '失败', not_tested: '未测试' }

const columns: Column<ProviderCredential>[] = [
  { key: 'displayName', label: '名称' },
  { key: 'adapter', label: '供应商', render: (r) => (r.adapter === 'openai' ? 'OpenAI' : 'Seedream') },
  { key: 'baseUrl', label: 'API 主机', render: (r) => (r.baseUrl ? hostOf(r.baseUrl) : '默认地址') },
  { key: 'hasApiKey', label: 'API Key' },
  { key: 'lastTestStatus', label: '最近测试' },
  { key: 'enabled', label: '启用' },
]

const isEmpty = computed(() => !loading.value && !loadError.value && admin.providerCredentials.length === 0)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-sm font-semibold text-neutral-900">供应商凭据</h1>
        <p class="mt-1 text-xs text-neutral-500">配置生图供应商的 API Key 与 Base URL，密钥仅写入、不可回读。</p>
      </div>
      <button
        class="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        @click="openCreate"
      >
        添加凭据
      </button>
    </div>

    <!-- Inline alert -->
    <div
      v-if="alert"
      :class="[
        'flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
        alert.kind === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700',
      ]"
      role="status"
    >
      <CheckCircle v-if="alert.kind === 'success'" class="h-4 w-4 shrink-0" />
      <AlertCircle v-else class="h-4 w-4 shrink-0" />
      {{ alert.text }}
    </div>

    <!-- Loading -->
    <div v-if="loading" class="rounded-xl border border-neutral-200 p-12 text-center text-xs text-neutral-400">
      加载中…
    </div>

    <!-- Load error -->
    <div v-else-if="loadError" class="rounded-xl border border-red-200 bg-red-50 p-8 text-center">
      <p class="text-xs text-red-700">{{ loadError }}</p>
      <button class="mt-3 text-xs font-medium text-primary hover:underline" @click="() => admin.fetchProviderCredentials()">重试</button>
    </div>

    <!-- Empty -->
    <div v-else-if="isEmpty" class="rounded-xl border border-dashed border-neutral-200 p-12 text-center">
      <Plug class="mx-auto h-8 w-8 text-neutral-300" />
      <p class="mt-3 text-sm text-neutral-500">暂无供应商凭据</p>
      <p class="mt-1 text-xs text-neutral-400">添加凭据后，可在模型管理中关联使用。</p>
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
        <span v-if="row.hasApiKey" class="inline-flex items-center gap-1.5 text-xs text-neutral-600">
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-success" />
          已配置<span v-if="row.keyFingerprint" class="font-mono text-neutral-400">·{{ row.keyFingerprint }}</span>
        </span>
        <span v-else class="inline-flex items-center gap-1.5 text-xs text-neutral-400">
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-neutral-300" />
          未配置
        </span>
      </template>

      <template #cell-lastTestStatus="{ row }">
        <span
          :class="[
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
            row.lastTestStatus === 'success' ? 'bg-green-50 text-green-700'
              : row.lastTestStatus === 'failed' ? 'bg-red-50 text-red-700'
              : 'bg-neutral-100 text-neutral-500',
          ]"
        >
          {{ testStatusLabel[row.lastTestStatus] || row.lastTestStatus }}
        </span>
        <span class="ml-2 text-xs text-neutral-400">{{ fmtDate(row.lastTestedAt) }}</span>
      </template>

      <template #cell-enabled="{ row }">
        <button
          :class="[
            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
            row.enabled ? 'bg-primary' : 'bg-neutral-300',
          ]"
          role="switch"
          :aria-checked="row.enabled"
          :aria-label="`切换 ${row.displayName} 启用状态`"
          @click="handleToggle(row)"
        >
          <span
            :class="['inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform', row.enabled ? 'translate-x-[18px]' : 'translate-x-0.5']"
          />
        </button>
      </template>

      <template #actions="{ row }">
        <div class="flex items-center justify-end gap-3">
          <button
            class="text-xs text-neutral-600 hover:underline disabled:opacity-50"
            :disabled="testingId === row.id"
            @click="handleTest(row)"
          >
            {{ testingId === row.id ? '测试中…' : '测试连接' }}
          </button>
          <button class="text-xs text-neutral-600 hover:underline" @click="openEdit(row)">编辑</button>
          <button class="text-xs text-danger hover:underline" @click="deleteTarget = row">删除</button>
        </div>
      </template>
    </DataTable>

    <!-- Create / Edit dialog -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="showDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" @click.self="showDialog = false">
          <div class="relative z-10 w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 shadow-xl">
            <h3 class="mb-4 text-sm font-semibold text-neutral-900">{{ editing ? '编辑凭据' : '添加凭据' }}</h3>
            <div class="space-y-3">
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-700">凭据名称</label>
                <input
                  v-model="form.displayName"
                  type="text"
                  placeholder="例如：OpenAI 主账号"
                  class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-700">供应商类型</label>
                <BaseSelect v-model="form.adapter" :disabled="!!editing">
                  <option value="openai">OpenAI (GPT Image)</option>
                  <option value="seedream">Seedream (火山引擎)</option>
                </BaseSelect>
                <p v-if="editing" class="mt-1 text-xs text-neutral-400">供应商类型创建后不可修改。</p>
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-700">API Base URL</label>
                <input
                  v-model="form.baseUrl"
                  type="url"
                  :placeholder="form.adapter === 'openai' ? 'https://api.openai.com' : 'https://ark.cn-beijing.volces.com'"
                  class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <p class="mt-1 text-xs text-neutral-400">必须是安全的 HTTPS 地址；留空使用供应商默认地址。</p>
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-700">API Key</label>
                <input
                  v-model="form.apiKey"
                  type="password"
                  autocomplete="off"
                  :placeholder="editing?.hasApiKey ? '已配置（留空保持不变）' : '输入 API Key'"
                  class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <p class="mt-1 text-xs text-neutral-400">密钥仅加密写入，保存后不可回读；填写新值即轮换。</p>
              </div>
              <label class="flex items-center gap-2 text-xs font-medium text-neutral-700">
                <input v-model="form.enabled" type="checkbox" class="h-4 w-4 rounded border-neutral-300" />
                启用该凭据
              </label>
              <div v-if="formError" class="text-xs text-danger">{{ formError }}</div>
            </div>
            <div class="mt-4 flex justify-end gap-2">
              <button
                class="inline-flex h-9 items-center rounded-lg border border-neutral-200 px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                @click="showDialog = false"
              >
                取消
              </button>
              <button
                :disabled="saving || !form.displayName.trim()"
                class="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
                @click="handleSave"
              >
                {{ saving ? '保存中…' : editing ? '保存' : '添加' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

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
