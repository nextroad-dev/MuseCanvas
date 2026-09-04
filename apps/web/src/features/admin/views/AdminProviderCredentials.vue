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
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
import Textarea from '@/shared/components/ui/Textarea.vue'
import Field from '@/shared/components/ui/Field.vue'
import Badge from '@/shared/components/ui/Badge.vue'
import { Plug } from 'lucide-vue-next'
import { toast } from '@/shared/composables/useToast'
import type { BuiltinProviderTemplate, ProviderCredential, ProviderCredentialInput, ModelAdapter } from '@/shared/types'
import { buildTemplateCredentialInput, findTemplateForCredential, parseServiceAccountJson, templateConfiguredCount } from '@/features/admin/lib/provider-templates'

const admin = useAdminStore()

const loading = ref(true)
const loadError = ref('')
const showDialog = ref(false)
const editing = ref<ProviderCredential | null>(null)
const saving = ref(false)
const formError = ref('')
const deleteTarget = ref<ProviderCredential | null>(null)
const testingId = ref<string | null>(null)
const templatesLoading = ref(true)
const templatesError = ref('')
const showTemplateDialog = ref(false)
const templateTarget = ref<BuiltinProviderTemplate | null>(null)
const templateSaving = ref(false)
const templateError = ref('')
const templateForm = ref({ displayName: '', secret: '', serviceAccountJson: '', enabled: true })
const SERVICE_ACCOUNT_PLACEHOLDER = '{"type":"service_account","project_id":"...","client_email":"...","private_key":"..."}'

const form = ref({
  displayName: '',
  adapter: 'openai' as ModelAdapter,
  providerId: '',
  baseUrl: '',
  apiKey: '',
  serviceAccountJson: '',
  accessKeyId: '',
  secretAccessKey: '',
  credentialJson: '',
  enabled: true,
})

const adapterOptions = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'seedream', label: 'Seedream (火山引擎)' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'veo', label: 'Veo (Google 视频)' },
  { value: 'volcengine', label: '火山引擎 (Seedance 视频)' },
  { value: 'google', label: 'Google (通用)' },
]

const isGoogleAdapter = computed(() => form.value.adapter === 'veo' || form.value.adapter === 'google')
const isVolcAdapter = computed(() => form.value.adapter === 'volcengine' || form.value.adapter === 'seedream')

const TEST_ERROR_LABELS: Record<string, string> = {
  CONNECTIVITY_FAILED: '无法连接供应商，请检查凭据与 Base URL',
  NO_API_KEY: '尚未配置凭据',
  INVALID_BASE_URL: 'Base URL 不是安全的 HTTPS 地址',
  INVALID_CREDENTIAL: '凭据格式或内容无效',
  INVALID_PLUGIN: '插件不存在或版本不受支持',
  PLUGIN_NOT_LINKED: '凭据尚未绑定具体插件',
  PLUGIN_NOT_REGISTERED: '绑定的插件不存在或版本不受支持',
  PROVIDER_REJECTED: '已连通，但供应商拒绝了请求，请检查模型授权或凭据权限',
  PROVIDER_TEMPORARY_ERROR: '供应商暂时不可用，请稍后重试',
  PROVIDER_EMPTY_RESULT: '供应商没有返回可用结果',
}
async function loadProviderTemplates() {
  templatesLoading.value = true
  templatesError.value = ''
  try {
    const result = await admin.fetchProviderTemplates()
    if (!result.success) {
      templatesError.value = result.error?.message || '加载内置插件失败'
    }
  } catch {
    templatesError.value = '加载内置插件失败'
  } finally {
    templatesLoading.value = false
  }
}


onMounted(async () => {
  loading.value = true
  loadError.value = ''
  try {
    const credentialsResult = await admin.fetchProviderCredentials()
    if (!credentialsResult.success) {
      loadError.value = credentialsResult.error?.message || '加载供应商凭据失败'
    }
  } catch {
    loadError.value = '加载供应商凭据失败'
  } finally {
    loading.value = false
  }
  await loadProviderTemplates()
})

const editingTemplate = computed(() => editing.value ? findTemplateForCredential(admin.providerTemplates, editing.value) : null)
const editingIsBuiltin = computed(() => !!editingTemplate.value)

function configuredCount(template: BuiltinProviderTemplate) {
  return templateConfiguredCount(admin.providerCredentials, template)
}

function modalityLabel(modality: BuiltinProviderTemplate['modality']) {
  return modality === 'video' ? '视频' : '图像'
}

function openTemplate(template: BuiltinProviderTemplate) {
  templateTarget.value = template
  templateError.value = ''
  templateForm.value = { displayName: template.displayName, secret: '', serviceAccountJson: '', enabled: true }
  showTemplateDialog.value = true
}

async function handleTemplateSave() {
  const template = templateTarget.value
  if (!template) return
  if (!templateForm.value.displayName.trim()) {
    templateError.value = '请填写凭据名称'
    return
  }
  let secret: string | Record<string, unknown>
  if (template.credential.kind === 'google_service_account') {
    const parsed = parseServiceAccountJson(templateForm.value.serviceAccountJson)
    if (!parsed.ok) {
      templateError.value = parsed.error
      return
    }
    secret = parsed.value
  } else {
    if (!templateForm.value.secret.trim()) {
      templateError.value = '请输入 API Key'
      return
    }
    secret = templateForm.value.secret.trim()
  }
  templateSaving.value = true
  templateError.value = ''
  const input = buildTemplateCredentialInput(template, secret, templateForm.value.displayName)
  input.enabled = templateForm.value.enabled
  const res = await admin.createProviderCredential(input)
  templateSaving.value = false
  if (res.success) {
    showTemplateDialog.value = false
    toast('凭据已创建', 'success')
  } else {
    templateError.value = res.error?.message || '保存失败'
  }
}

function openCreate() {
  editing.value = null
  formError.value = ''
  form.value = { displayName: '', adapter: 'openai', providerId: '', baseUrl: '', apiKey: '', serviceAccountJson: '', accessKeyId: '', secretAccessKey: '', credentialJson: '', enabled: true }
  showDialog.value = true
}

function openEdit(cred: ProviderCredential) {
  editing.value = cred
  formError.value = ''
  form.value = {
    displayName: cred.displayName,
    adapter: cred.adapter,
    providerId: cred.providerId || '',
    baseUrl: cred.baseUrl || '',
    apiKey: '',
    serviceAccountJson: '',
    accessKeyId: '',
    secretAccessKey: '',
    credentialJson: '',
    enabled: cred.enabled,
  }
  showDialog.value = true
}

async function handleSave() {
  if (!form.value.displayName.trim()) {
    formError.value = '请填写凭据名称'
    return
  }
  // Built-in credentials keep their plugin identity: only display name,
  // enabled flag, and a replacement secret are writable.
  if (editing.value && editingIsBuiltin.value) {
    saving.value = true
    formError.value = ''
    const payload: ProviderCredentialInput = {
      displayName: form.value.displayName.trim(),
      enabled: form.value.enabled,
    }
    if (form.value.apiKey.trim()) payload.credential = form.value.apiKey.trim()
    else if (form.value.serviceAccountJson.trim()) {
      const parsed = parseServiceAccountJson(form.value.serviceAccountJson)
      if (!parsed.ok) {
        saving.value = false
        formError.value = parsed.error
        return
      }
      payload.credential = parsed.value
    } else if (form.value.credentialJson.trim()) {
      try {
        payload.credential = JSON.parse(form.value.credentialJson) as Record<string, unknown>
      } catch {
        saving.value = false
        formError.value = '凭据 JSON 不是合法 JSON'
        return
      }
    }
    const res = await admin.updateProviderCredential(editing.value.id, payload)
    saving.value = false
    if (res.success) {
      showDialog.value = false
      toast('凭据已更新', 'success')
    } else {
      formError.value = res.error?.message || '保存失败'
    }
    return
  }
  saving.value = true
  formError.value = ''
  const payload: ProviderCredentialInput = {
    displayName: form.value.displayName.trim(),
    baseUrl: form.value.baseUrl.trim(),
    enabled: form.value.enabled,
  }
  if (form.value.providerId.trim()) payload.providerId = form.value.providerId.trim()
  // API Key is write-only: only send when the admin typed a new one (rotation).
  if (form.value.apiKey.trim()) payload.apiKey = form.value.apiKey.trim()
  // Google service-account JSON (write-only) for Veo/Google video providers.
  if (form.value.serviceAccountJson.trim()) payload.serviceAccountJson = form.value.serviceAccountJson
  // Volcengine AK/SK bundle (write-only) for Seedance/volcengine providers.
  if (form.value.accessKeyId.trim()) payload.accessKeyId = form.value.accessKeyId.trim()
  if (form.value.secretAccessKey.trim()) payload.secretAccessKey = form.value.secretAccessKey.trim()
  // Generic plugin credential JSON (write-only).
  if (form.value.credentialJson.trim()) payload.credentialJson = form.value.credentialJson

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
  if (adapter === 'openai') return 'OpenAI 兼容'
  if (adapter === 'anthropic') return 'Anthropic'
  if (adapter === 'seedream') return 'Seedream'
  if (adapter === 'veo') return 'Veo (Google 视频)'
  if (adapter === 'volcengine') return '火山引擎视频'
  if (adapter === 'google') return 'Google'
  return String(adapter)
}

function pluginIdentityLabel(row: ProviderCredential) {
  const pluginId = row.configuredFields?.pluginId
  const pluginVersion = row.configuredFields?.pluginVersion
  const schema = row.schemaId || 'legacy-api-key-v1'
  if (pluginId && pluginVersion) return `${pluginId}@${pluginVersion} · ${schema}`
  return `${adapterLabel(row.adapter)} · ${schema}`
}

const columns: Column<ProviderCredential>[] = [
  { key: 'displayName', label: '名称' },
  { key: 'adapter', label: '供应商', render: (r) => adapterLabel(r.adapter) },
  { key: 'plugin', label: '插件/协议', render: (r) => pluginIdentityLabel(r) },
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
      description="配置图像与视频供应商的密钥（API Key / Google 服务账号 JSON / 火山引擎 AK·SK），密钥仅写入、不可回读。"
    >
      <template #actions>
        <BaseButton size="sm" @click="openCreate">
          添加自定义凭据
        </BaseButton>
      </template>
    </PageHeader>

    <!-- Built-in provider templates -->
    <section aria-label="内置插件">
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 class="text-sm font-medium text-foreground">内置插件</h2>
        <p class="text-xs text-muted-foreground">选择插件卡片直接配置，无需填写标识符；语言模型与自定义供应商继续使用下方添加入口。</p>
      </div>
      <div v-if="templatesLoading" class="py-6 text-center text-xs text-muted-foreground">
        内置插件加载中…
      </div>
      <div v-else-if="templatesError" class="py-4 text-center">
        <p class="text-xs text-danger">{{ templatesError }}</p>
        <button class="mt-2 text-xs font-medium text-primary hover:underline" @click="loadProviderTemplates">重试</button>
      </div>
      <div v-else class="grid gap-4 sm:grid-cols-2">
        <div
          v-for="template in admin.providerTemplates"
          :key="template.key"
          class="flex flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-surface-subtle p-4"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium text-foreground">{{ template.displayName }}</span>
            <Badge :tone="configuredCount(template) > 0 ? 'success' : 'neutral'">
              {{ configuredCount(template) > 0 ? `已配置 ${configuredCount(template)}` : '未配置' }}
            </Badge>
          </div>
          <p class="font-mono text-xs text-muted-foreground">{{ template.pluginId }}@{{ template.pluginVersion }} · {{ modalityLabel(template.modality) }}</p>
          <p v-if="template.description" class="text-xs leading-5 text-muted-foreground">{{ template.description }}</p>
          <p class="truncate text-xs text-muted-foreground">模型：{{ template.models.map((m) => m.name || m.id).join(' / ') || '—' }}</p>
          <div class="mt-auto flex items-center justify-between gap-3 pt-1">
            <span class="truncate font-mono text-xs text-muted-foreground">{{ hostOf(template.baseUrl) }}</span>
            <BaseButton size="sm" variant="secondary" @click="openTemplate(template)">
              {{ configuredCount(template) > 0 ? '继续配置' : '配置' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </section>

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
        <span v-if="row.hasApiKey || row.hasCredential" class="inline-flex items-center gap-1.5 text-xs text-foreground">
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-success" />
          已配置<span v-if="row.keyFingerprint || row.credentialFingerprint" class="font-mono text-muted-foreground">·{{ row.keyFingerprint || row.credentialFingerprint }}</span>
        </span>
        <span v-else class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-border" />
          未配置
        </span>
      </template>

      <template #cell-lastTestStatus="{ row }">
        <Badge :tone="row.lastTestStatus === 'success' ? 'success' : row.lastTestStatus === 'failed' ? 'danger' : 'neutral'">
          {{ testStatusLabel[row.lastTestStatus] || row.lastTestStatus }}
        </Badge>
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

    <AppModal v-model:open="showDialog" :title="editing ? (editingIsBuiltin ? '编辑内置凭据' : '编辑凭据') : '添加自定义凭据'">
      <div class="space-y-3">
        <Field label="凭据名称">
          <TextInput
            v-model="form.displayName"
            type="text"
            placeholder="例如：OpenAI 兼容主账号"
          />
        </Field>
        <div v-if="editingIsBuiltin && editingTemplate" class="rounded-[var(--radius-card)] bg-surface-subtle px-3 py-2 text-xs text-muted-foreground">
          <p class="font-mono">{{ editingTemplate.pluginId }}@{{ editingTemplate.pluginVersion }}</p>
          <p class="mt-1">供应商 {{ editingTemplate.providerId }} · 协议 {{ editingTemplate.credential.schemaId }}#{{ editingTemplate.credential.schemaVersion }} · {{ hostOf(editingTemplate.baseUrl) }}</p>
          <p class="mt-1">插件标识与地址已锁定，仅可修改名称、启用状态与密钥（填写新值即轮换，留空保持不变）。</p>
        </div>
        <div v-if="!editingIsBuiltin">
          <label class="mb-1 block text-xs font-medium text-foreground">供应商类型</label>
          <BaseDropdown v-model="form.adapter" :options="adapterOptions" :disabled="!!editing" />
          <p v-if="editing" class="mt-1 text-xs text-muted-foreground">供应商类型创建后不可修改。</p>
        </div>
        <Field v-if="!editingIsBuiltin" label="供应商 ID（可选）">
          <TextInput
            v-model="form.providerId"
            type="text"
            placeholder="例如：veo / seedance，留空由服务端按类型推断"
          />
        </Field>
        <Field v-if="!editingIsBuiltin" label="API Base URL" hint="必须是安全的 HTTPS 地址；留空使用供应商默认地址。">
          <TextInput
            v-model="form.baseUrl"
            type="url"
            :placeholder="form.adapter === 'openai' ? 'https://api.openai.com' : form.adapter === 'anthropic' ? 'https://api.anthropic.com' : isGoogleAdapter ? 'https://generativelanguage.googleapis.com' : 'https://ark.cn-beijing.volces.com'"
          />
        </Field>
        <Field v-if="editingIsBuiltin ? editingTemplate?.credential.kind === 'api_key' : !isGoogleAdapter" label="API Key" hint="密钥仅加密写入，保存后不可回读；填写新值即轮换。">
          <TextInput
            v-model="form.apiKey"
            type="password"
            autocomplete="off"
            :placeholder="editing?.hasApiKey ? '已配置（留空保持不变）' : '输入 API Key'"
          />
        </Field>
        <Field v-if="editingIsBuiltin ? editingTemplate?.credential.kind === 'google_service_account' : isGoogleAdapter" label="Google 服务账号 JSON（写入后不可回读）" hint="Veo / Google 视频凭据使用服务账号 JSON；留空表示保持现有配置不变。">
          <Textarea
            v-model="form.serviceAccountJson"
            :rows="5"
            placeholder='{"type": "service_account", "project_id": "...", "private_key": "...", "client_email": "..."}'
            spellcheck="false"
            class="font-mono text-xs"
          />
        </Field>
        <div v-if="!editingIsBuiltin && isVolcAdapter" class="grid gap-3 md:grid-cols-2">
          <Field label="Access Key ID">
            <TextInput
              v-model="form.accessKeyId"
              type="text"
              autocomplete="off"
              placeholder="火山引擎 AK"
            />
          </Field>
          <Field label="Secret Access Key">
            <TextInput
              v-model="form.secretAccessKey"
              type="password"
              autocomplete="off"
              placeholder="火山引擎 SK（留空保持不变）"
            />
          </Field>
          <p class="text-xs text-muted-foreground md:col-span-2">AK/SK 仅加密写入，保存后不可回读；填写新值即轮换。</p>
        </div>
        <div class="flex items-center gap-2">
          <PillToggle v-model="form.enabled" />
          <span class="text-xs font-medium text-foreground">启用该凭据</span>
        </div>
        <div v-if="formError" class="text-xs text-danger">{{ formError }}</div>
      </div>
      <template #footer="{ close }">
        <BaseButton variant="secondary" @click="close">
          取消
        </BaseButton>
        <BaseButton variant="primary" :disabled="saving || !form.displayName.trim()" :loading="saving" @click="handleSave">
          {{ saving ? '保存中…' : editing ? '保存' : '添加' }}
        </BaseButton>
      </template>
    </AppModal>
    <AppModal v-model:open="showTemplateDialog" :title="templateTarget ? `配置${templateTarget.displayName}` : '配置内置插件'">
      <div v-if="templateTarget" class="space-y-3">
        <div class="rounded-[var(--radius-card)] bg-surface-subtle px-3 py-2 text-xs text-muted-foreground">
          <p class="font-mono">{{ templateTarget.pluginId }}@{{ templateTarget.pluginVersion }} · {{ modalityLabel(templateTarget.modality) }}</p>
          <p class="mt-1">供应商 {{ templateTarget.providerId }} · 协议 {{ templateTarget.credential.schemaId }}#{{ templateTarget.credential.schemaVersion }} · {{ hostOf(templateTarget.baseUrl) }}</p>
          <p class="mt-1">插件标识与地址已锁定，保存时将原样提交。</p>
        </div>
        <Field label="凭据名称">
          <TextInput
            v-model="templateForm.displayName"
            type="text"
            :placeholder="templateTarget.displayName"
          />
        </Field>
        <Field v-if="templateTarget.credential.kind === 'api_key'" :label="templateTarget.credential.label" :hint="templateTarget.credential.helpText || '密钥仅加密写入，保存后不可回读。'">
          <TextInput
            v-model="templateForm.secret"
            type="password"
            autocomplete="off"
            :placeholder="templateTarget.credential.placeholder || '输入 API Key'"
          />
        </Field>
        <Field v-else :label="templateTarget.credential.label" :hint="templateTarget.credential.helpText || '粘贴完整的服务账号 JSON，保存时将解析为对象提交。'">
          <Textarea
            v-model="templateForm.serviceAccountJson"
            :rows="5"
            :placeholder="templateTarget.credential.placeholder || SERVICE_ACCOUNT_PLACEHOLDER"
            spellcheck="false"
            class="font-mono text-xs"
          />
        </Field>
        <div class="flex items-center gap-2">
          <PillToggle v-model="templateForm.enabled" />
          <span class="text-xs font-medium text-foreground">启用该凭据</span>
        </div>
        <div v-if="templateError" class="text-xs text-danger">{{ templateError }}</div>
      </div>
      <template #footer="{ close }">
        <BaseButton variant="secondary" @click="close">
          取消
        </BaseButton>
        <BaseButton variant="primary" :disabled="templateSaving || !templateForm.displayName.trim()" :loading="templateSaving" @click="handleTemplateSave">
          {{ templateSaving ? '保存中…' : '添加' }}
        </BaseButton>
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
