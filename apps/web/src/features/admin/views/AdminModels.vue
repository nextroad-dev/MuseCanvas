<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useAdminStore } from '@/features/admin/stores/admin'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import DataTable from '@/shared/components/ui/DataTable.vue'
import BaseDropdown from '@/shared/components/ui/BaseDropdown.vue'
import PillToggle from '@/shared/components/ui/PillToggle.vue'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import Field from '@/shared/components/ui/Field.vue'
import type { AdminModel, LanguageProtocol, ModelAdapter, ModelPreset, PromptOptimizationSettings, ReasoningEffort } from '@/shared/types'
import type { Column } from '@/shared/components/ui/DataTable.vue'
import AppModal from '@/shared/components/ui/AppModal.vue'
import { toast } from '@/shared/composables/useToast'
import { credentialsForPreset, presetPluginKey } from '@/features/admin/lib/provider-templates'

const admin = useAdminStore()
const showCreateDialog = ref(false)
const editingModel = ref<AdminModel | null>(null)
const deleteTarget = ref<AdminModel | null>(null)
const deleteDialogOpen = ref(false)

const promptEnabled = ref(false)
const promptAllowRead = ref(false)
const promptLanguageModelId = ref('')
const promptSettingsSaving = ref(false)

const promptLanguageModelOptions = computed(() => [
  { value: '', label: '请选择语言模型' },
  ...admin.models
    .filter(m => m.modelKind === 'language' && m.enabled)
    .map(m => ({ value: m.id, label: `${m.displayName} · ${languageProtocolLabel(m.languageProtocol)} · ${reasoningLabel(m.reasoningEffort)}` })),
])

const form = ref({
  presetId: '',
  concurrencyLimit: 1,
  creditsPerImage: 0,
  watermark: false,
  sortOrder: 0,
  providerCredentialId: '',
  reasoningEffort: 'medium' as ReasoningEffort,
})
const selectedPreset = computed(() =>
  admin.modelPresets.find(preset => preset.id === form.value.presetId),
)

const presetOptions = computed(() => [
  { value: '', label: '请选择模型预设' },
  ...admin.modelPresets.map((p) => {
    const pluginKey = presetPluginKey(p)
    const suffix = pluginKey || presetProtocolLabel(p)
    return { value: p.id, label: `${p.displayName} · ${presetKindLabel(p)} · ${suffix}` }
  }),
])


// Built-in presets match by exact plugin identity (configuredFields) with a
// providerId fallback for legacy records; language/custom presets keep the
// legacy adapter match. Video presets carry no adapter and are never
// filtered by adapter comparison.
const mediaCredentials = computed(() => credentialsForPreset(admin.providerCredentials, selectedPreset.value))

const imageCredentialOptions = computed(() => [
  { value: '', label: '未关联（任务将因缺少凭据失败）' },
  ...mediaCredentials.value.map(c => ({ value: c.id, label: c.displayName })),
])

const languageCredentials = computed(() =>
  admin.providerCredentials.filter((c) =>
    c.adapter !== 'seedream'
    && c.enabled
    && c.hasApiKey
    && (selectedPreset.value?.modelKind !== 'language' || c.adapter === selectedPreset.value.adapter),
  ),
)

const languageCredentialOptions = computed(() => [
  { value: '', label: languageCredentials.value.length ? '请选择供应商凭据' : '暂无可用语言模型凭据' },
  ...languageCredentials.value.map(c => ({ value: c.id, label: `${c.displayName} · ${credentialProtocolLabel(c.adapter)}` })),
])

const reasoningEffortOptions = [
  { value: 'none', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '特高' },
]

const canSave = computed(() => {
  if (!selectedPreset.value) return !!editingModel.value
  return selectedPreset.value.modelKind !== 'language' || !!form.value.providerCredentialId
})

onMounted(async () => {
  await Promise.all([admin.fetchModels(), admin.fetchModelPresets(), admin.fetchProviderCredentials(), admin.fetchPromptOptimizationSettings()])
  if (admin.promptOptimizationSettings) syncPromptSettings(admin.promptOptimizationSettings)
})

function adapterLabel(adapter?: ModelAdapter) {
  if (!adapter) return '未设置'
  if (adapter === 'openai') return 'OpenAI 兼容'
  if (adapter === 'anthropic') return 'Anthropic'
  if (adapter === 'seedream' || adapter === 'volcengine') return '火山引擎'
  if (adapter === 'veo' || adapter === 'google') return 'Google Vertex AI'
  return String(adapter)
}

function languageProtocolLabel(protocol?: LanguageProtocol | null) {
  if (protocol === 'openai_chat') return 'OpenAI Chat'
  if (protocol === 'openai_responses') return 'OpenAI Responses'
  if (protocol === 'anthropic_messages') return 'Anthropic Messages'
  return '未设置协议'
}

function presetProtocolLabel(preset: ModelPreset) {
  return preset.modelKind === 'language' ? languageProtocolLabel(preset.languageProtocol) : adapterLabel(preset.adapter)
}

function credentialProtocolLabel(adapter: ModelAdapter) {
  if (selectedPreset.value?.modelKind === 'language') {
    return selectedPreset.value.adapter === adapter ? languageProtocolLabel(selectedPreset.value.languageProtocol) : adapterLabel(adapter)
  }
  return adapterLabel(adapter)
}

function presetKindLabel(preset?: ModelPreset | null) {
  if (preset?.modelKind === 'language') return '语言模型'
  if (preset?.modelKind === 'video') return '视频模型'
  return '图像模型'
}

function reasoningLabel(value?: ReasoningEffort | null) {
  return reasoningEffortOptions.find(option => option.value === value)?.label || '默认'
}

function presetSummary(preset?: ModelPreset | null) {
  if (!preset) return []
  if (preset.modelKind === 'language') {
    return [
      `供应商：${adapterLabel(preset.adapter)}`,
      `模型 ID：${preset.vendorModelId}`,
      `协议：${languageProtocolLabel(preset.languageProtocol)}`,
      `输出上限：${preset.maxOutputTokens || '-'}`,
      `温度：${preset.temperature ?? '-'}`,
    ]
  }
  if (preset.modelKind === 'video') {
    return [
      `供应商：${adapterLabel(preset.providerId || preset.adapter)}`,
      `模型 ID：${preset.vendorModelId}`,
      `时长/比例/分辨率由生成页能力描述动态提供`,
      `最多：${preset.maxCount || 1} 个视频`,
    ]
  }
  return [
    `供应商：${adapterLabel(preset.providerId || preset.adapter)}`,
    `模型 ID：${preset.vendorModelId}`,
    `尺寸：${preset.sizes?.join(' / ') || '-'}`,
    `质量：${preset.qualityOptions?.join(' / ') || '供应商默认'}`,
    `最多：${preset.maxCount || 4} 张`,
  ]
}

function applyCredential(id: string) {
  form.value.providerCredentialId = id
}

function applyPreset(id: string) {
  form.value.presetId = id
  const preset = admin.modelPresets.find((item) => item.id === id)
  if (!preset) return
  form.value.concurrencyLimit = preset.concurrencyLimit
  form.value.watermark = !!preset.watermark
  form.value.providerCredentialId = preset.modelKind === 'language'
    ? languageCredentials.value.find((cred) => cred.adapter === preset.adapter)?.id || ''
    : credentialsForPreset(admin.providerCredentials, preset)[0]?.id || ''
  form.value.reasoningEffort = (preset.reasoningEffort || 'medium') as ReasoningEffort
}

function openCreate() {
  editingModel.value = null
  form.value = {
    presetId: '',
    concurrencyLimit: 1,
    creditsPerImage: 0,
    watermark: false,
    sortOrder: 0,
    providerCredentialId: '',
    reasoningEffort: 'medium',
  }
  showCreateDialog.value = true
}

function findPresetForModel(model: AdminModel): ModelPreset | undefined {
  if (model.pluginId || model.pluginVersion) {
    return admin.modelPresets.find(preset =>
      preset.pluginId === model.pluginId
      && preset.pluginVersion === model.pluginVersion
      && preset.vendorModelId === model.vendorModelId)
  }
  return admin.modelPresets.find(preset => preset.id === model.presetId)
    || admin.modelPresets.find(preset =>
      preset.providerId === model.providerId
      && preset.vendorModelId === model.vendorModelId)
    || admin.modelPresets.find(preset =>
      preset.adapter === model.adapter
      && preset.vendorModelId === model.vendorModelId)
}

function openEdit(model: AdminModel) {
  editingModel.value = model
  const preset = findPresetForModel(model)
  form.value = {
    presetId: preset?.id || '',
    concurrencyLimit: model.concurrencyLimit,
    creditsPerImage: model.creditsPerImage ?? 0,
    watermark: model.watermark || false,
    sortOrder: model.sortOrder,
    providerCredentialId: model.providerCredentialId || '',
    reasoningEffort: model.reasoningEffort || preset?.reasoningEffort || 'medium',
  }
  showCreateDialog.value = true
}


async function handleSave() {
  if (!canSave.value) return
  if (selectedPreset.value?.modelKind === 'image') {
    const rawCredits = form.value.creditsPerImage
    const credits = Number(rawCredits)
    if (rawCredits === null || rawCredits === undefined || (rawCredits as unknown) === '' || !Number.isSafeInteger(credits) || credits < 0) {
      toast('积分单价必须是非负整数', 'error')
      return
    }
  }
  const data: Partial<AdminModel> & { presetId?: string } = {
    concurrencyLimit: form.value.concurrencyLimit,
    creditsPerImage: Number(form.value.creditsPerImage ?? 0),
    sortOrder: form.value.sortOrder,
    providerCredentialId: form.value.providerCredentialId || '',
  }
  if (form.value.presetId) data.presetId = form.value.presetId
  if (selectedPreset.value?.modelKind === 'image') {
    data.watermark = form.value.watermark
  } else if (selectedPreset.value?.modelKind === 'language') {
    data.reasoningEffort = form.value.reasoningEffort
  }
  const res = editingModel.value
    ? await admin.updateModel(editingModel.value.id, data)
    : await admin.createModel(data)

  if (res.success) {
    toast(editingModel.value ? '模型已更新' : '模型已添加', 'success')
    showCreateDialog.value = false
  } else {
    toast(res.error?.message || (editingModel.value ? '保存模型失败' : '添加模型失败'), 'error')
  }
}

function handleToggleEnabled(model: AdminModel) {
  admin.updateModel(model.id, { enabled: !model.enabled })
}

function requestDelete(model: AdminModel) {
  deleteTarget.value = model
  deleteDialogOpen.value = true
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  const target = deleteTarget.value
  const result = await admin.deleteModel(target.id)
  toast(result.success ? '模型已删除' : result.error?.message || '删除失败', result.success ? 'success' : 'error')
  if (result.success && promptLanguageModelId.value === target.id) {
    promptLanguageModelId.value = ''
    promptEnabled.value = false
  }
  deleteTarget.value = null
}

function syncPromptSettings(settings: PromptOptimizationSettings) {
  promptEnabled.value = settings.enabled
  promptAllowRead.value = settings.allowUserReadFinalPrompt
  promptLanguageModelId.value = settings.languageModelConfigId || ''
}

async function savePromptSettings(patch: Partial<Pick<PromptOptimizationSettings, 'enabled' | 'allowUserReadFinalPrompt' | 'languageModelConfigId'>>) {
  promptSettingsSaving.value = true
  const result = await admin.updatePromptOptimizationSettings(patch)
  promptSettingsSaving.value = false
  if (result.success && result.data) {
    syncPromptSettings(result.data)
    return
  }
  if (admin.promptOptimizationSettings) syncPromptSettings(admin.promptOptimizationSettings)
  toast(result.error?.message || '保存失败', 'error')
}

function handlePromptLanguageModelChange(value: string) {
  if (value === promptLanguageModelId.value || promptSettingsSaving.value) return
  promptLanguageModelId.value = value
  void savePromptSettings({ languageModelConfigId: value || null })
}
function handlePromptEnabledChange(value: boolean) {
  if (value === promptEnabled.value || promptSettingsSaving.value) return
  promptEnabled.value = value
  void savePromptSettings({ enabled: value })
}

function handlePromptAllowReadChange(value: boolean) {
  if (value === promptAllowRead.value || promptSettingsSaving.value) return
  promptAllowRead.value = value
  void savePromptSettings({ allowUserReadFinalPrompt: value })
}

const modelColumns: Column<AdminModel>[] = [
  { key: 'displayName', label: '模型名称' },
  { key: 'modelKind', label: '用途', render: row => row.modelKind === 'language' ? '语言模型' : row.modelKind === 'video' ? '视频模型' : '图像模型' },
  {
    key: 'adapter',
    label: '供应商',
    render: (row) => adapterLabel(row.providerId || row.adapter),
  },
  { key: 'pluginVersion', label: '插件版本', render: row => row.pluginId ? `${row.pluginId}@${row.pluginVersion || '—'}` : '-' },
  { key: 'languageProtocol', label: '协议/推理', render: row => row.modelKind === 'language' ? `${languageProtocolLabel(row.languageProtocol)} · ${reasoningLabel(row.reasoningEffort)}` : '-' },
  {
    key: 'enabled',
    label: '状态',
    render: (row) => row.enabled ? '已启用' : '已禁用',
  },
  {
    key: 'creditsPerImage',
    label: '积分单价',
    render: (row) => {
      if (row.modelKind === 'language') return '-'
      const pricing = (row as AdminModel & { pricing?: { scheme?: string; creditsPerSecond?: number } }).pricing
      if (pricing?.scheme === 'per_second_v1') return `${pricing.creditsPerSecond ?? 0} 积分/秒`
      return `${row.creditsPerImage ?? 0} 积分/${row.modelKind === 'video' ? '次' : '张'}`
    },
  },
  { key: 'concurrencyLimit', label: '并发上限' },
  { key: 'providerCredentialName', label: '凭据', render: (row) => row.providerCredentialName || '未关联' },
]
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="模型管理">
      <template #actions>
        <BaseButton size="sm" @click="openCreate">
          添加模型
        </BaseButton>
      </template>
    </PageHeader>

    <DataTable
      :columns="modelColumns"
      :data="admin.models"
      :row-key="(row: AdminModel) => row.id"
      empty-text="暂无模型配置"
    >
      <template #cell-enabled="{ row }">
        <PillToggle :model-value="row.enabled" @update:model-value="() => handleToggleEnabled(row)" />
      </template>

      <template #actions="{ row }">
        <div class="flex items-center justify-end gap-3">
          <button
            class="text-xs text-foreground hover:underline"
            @click="openEdit(row)"
          >
            编辑
          </button>
          <button
            class="text-xs text-danger hover:underline"
            @click="requestDelete(row)"
          >
            删除
          </button>
        </div>
      </template>
    </DataTable>

    <AppModal
      v-model:open="showCreateDialog"
      :title="editingModel ? '编辑模型' : '添加模型'"
      size="lg"
    >
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="lg:col-span-2">
          <label class="mb-1 block text-xs font-medium text-foreground">模型预设</label>
          <BaseDropdown :model-value="form.presetId" :options="presetOptions" @update:model-value="applyPreset" />
        </div>

        <div v-if="selectedPreset" class="rounded-[var(--radius-card)] bg-surface-subtle px-3 py-2 lg:row-span-2">
          <div class="mb-2 flex items-center justify-between gap-3">
            <span class="text-sm font-medium text-foreground">{{ selectedPreset.displayName }}</span>
            <span class="shrink-0 text-xs text-muted-foreground">{{ presetKindLabel(selectedPreset) }}</span>
          </div>
          <div class="space-y-1 text-xs text-muted-foreground">
            <p v-for="item in presetSummary(selectedPreset)" :key="item" class="truncate">{{ item }}</p>
          </div>
        </div>

        <div v-if="selectedPreset?.modelKind === 'language'">
          <label class="mb-1 block text-xs font-medium text-foreground">供应商凭据</label>
          <BaseDropdown
            :model-value="form.providerCredentialId"
            :options="languageCredentialOptions"
            @update:model-value="applyCredential"
          />
          <p class="mt-1 text-xs text-muted-foreground">
            OpenAI Chat 与 OpenAI Responses 使用不同请求格式；此处仅列出与当前模型协议供应商匹配、已启用且已配置 API Key 的凭据。
            <RouterLink to="/admin/providers" class="text-primary hover:underline">前往配置凭据</RouterLink>
          </p>
        </div>

        <div v-if="selectedPreset?.modelKind === 'image'">
          <label class="mb-1 block text-xs font-medium text-foreground">供应商凭据（API Key）</label>
          <BaseDropdown v-model="form.providerCredentialId" :options="imageCredentialOptions" />
          <p class="mt-1 text-xs text-muted-foreground">
            仅列出与当前预设供应商匹配且已启用的凭据。
            <RouterLink to="/admin/providers" class="text-primary hover:underline">前往配置凭据</RouterLink>
          </p>
        </div>

        <div v-if="selectedPreset?.modelKind === 'video'">
          <label class="mb-1 block text-xs font-medium text-foreground">供应商凭据（插件密钥）</label>
          <BaseDropdown v-model="form.providerCredentialId" :options="imageCredentialOptions" />
          <p class="mt-1 text-xs text-muted-foreground">
            视频模型通过插件调用供应商（如 Veo / Seedance），凭据密钥仅写入不可回读。
            <RouterLink to="/admin/providers" class="text-primary hover:underline">前往配置凭据</RouterLink>
          </p>
        </div>

        <div v-if="selectedPreset?.modelKind === 'language'">
          <label class="mb-1 block text-xs font-medium text-foreground">思考等级</label>
          <BaseDropdown v-model="form.reasoningEffort" :options="reasoningEffortOptions" />
        </div>

        <p v-if="selectedPreset?.modelKind === 'image'" class="rounded-[var(--radius-card)] bg-surface-subtle px-3 py-2 text-xs text-muted-foreground lg:col-span-2">尺寸、质量和生成张数由生成页统一提供常用预设，也支持用户自定义安全尺寸。</p>
        <p v-if="selectedPreset?.modelKind === 'video'" class="rounded-[var(--radius-card)] bg-surface-subtle px-3 py-2 text-xs text-muted-foreground lg:col-span-2">时长、比例、分辨率与音频由插件能力描述驱动，生成页会自动渲染可用选项。</p>

        <p v-if="selectedPreset && selectedPreset.modelKind !== 'language'" class="rounded-[var(--radius-card)] bg-surface-subtle px-3 py-2 text-xs text-muted-foreground lg:col-span-2">内置媒体插件的能力描述、计费与默认参数由服务端按插件版本派生，无需填写自定义覆盖。</p>

        <div class="grid gap-4 lg:col-span-2" :class="selectedPreset?.modelKind === 'image' ? 'grid-cols-3' : 'grid-cols-2'">
          <Field v-if="selectedPreset?.modelKind === 'image'" label="积分单价 (张)">
            <input
              v-model.number="form.creditsPerImage"
              type="number"
              min="0"
              class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </Field>
          <Field label="并发上限">
            <input
              v-model.number="form.concurrencyLimit"
              type="number"
              min="1"
              max="50"
              class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </Field>
          <Field label="排序">
            <input v-model.number="form.sortOrder" type="number" class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none" />
          </Field>
        </div>

        <div v-if="selectedPreset?.modelKind === 'image' && selectedPreset.adapter === 'seedream'" class="flex items-center gap-2 pt-1">
          <PillToggle v-model="form.watermark" />
          <span class="text-xs font-medium text-foreground">启用供应商水印</span>
        </div>
      </div>
      <template #footer="{ close }">
        <BaseButton variant="secondary" @click="close">
          取消
        </BaseButton>
        <BaseButton variant="primary" :disabled="!canSave" @click="handleSave">
          {{ editingModel ? '保存' : '添加' }}
        </BaseButton>
      </template>
    </AppModal>

    <div class="space-y-3">
      <div>
        <h2 class="text-sm font-medium text-foreground">提示词前处理</h2>
        <p class="text-xs text-muted-foreground">文本模型会接收用户提示词并处理后传递给生图模型，请确保供应商满足隐私与数据处理要求。</p>
      </div>
      <div class="space-y-3">
        <div>
          <label class="mb-1 block text-xs font-medium text-foreground">语言模型</label>
          <BaseDropdown
            :model-value="promptLanguageModelId"
            :options="promptLanguageModelOptions"
            :disabled="promptSettingsSaving"
            @update:model-value="handlePromptLanguageModelChange"
          />
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <div class="flex items-center gap-2">
            <PillToggle
              :model-value="promptEnabled"
              :disabled="promptSettingsSaving"
              @update:model-value="handlePromptEnabledChange"
            />
            <span class="text-sm text-foreground">启用提示词前处理</span>
          </div>
          <div class="flex items-center gap-2">
            <PillToggle
              :model-value="promptAllowRead"
              :disabled="promptSettingsSaving"
              @update:model-value="handlePromptAllowReadChange"
            />
            <span class="text-sm text-foreground">允许用户读取最终提示词</span>
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-model:open="deleteDialogOpen"
      title="删除模型"
      :description="`确定删除「${deleteTarget?.displayName || '该模型'}」吗？已有任务记录会保留，但该模型将不再可用于新任务。`"
      confirm-text="删除"
      variant="danger"
      @confirm="confirmDelete"
    />
  </div>
</template>
