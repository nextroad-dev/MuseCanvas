<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useAdminStore } from '@/features/admin/stores/admin'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import DataTable from '@/shared/components/ui/DataTable.vue'
import BaseDropdown from '@/shared/components/ui/BaseDropdown.vue'
import PillToggle from '@/shared/components/ui/PillToggle.vue'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import { toast } from '@/shared/composables/useToast'
import type { AdminModel, LanguageProtocol, ModelAdapter, ModelPreset, ReasoningEffort } from '@/shared/types'
import type { Column } from '@/shared/components/ui/DataTable.vue'
import AppModal from '@/shared/components/ui/AppModal.vue'

const admin = useAdminStore()
const showCreateDialog = ref(false)
const editingModel = ref<AdminModel | null>(null)
const deleteTarget = ref<AdminModel | null>(null)
const deleteDialogOpen = ref(false)

const promptEnabled = ref(false)
const promptAllowRead = ref(false)
const promptLanguageModelId = ref('')
const promptTimeoutMs = ref(60000)

const promptLanguageModelOptions = computed(() => [
  { value: '', label: '请选择语言模型' },
  ...admin.models
    .filter(m => m.modelKind === 'language' && m.enabled)
    .map(m => ({ value: m.id, label: `${m.displayName} · ${languageProtocolLabel(m.languageProtocol)} · ${reasoningLabel(m.reasoningEffort)}` })),
])

const form = ref({
  presetId: '',
  concurrencyLimit: 1,
  watermark: false,
  sortOrder: 0,
  providerCredentialId: '',
  reasoningEffort: 'medium' as ReasoningEffort,
})

const presetOptions = computed(() => [
  { value: '', label: '请选择模型预设' },
  ...admin.modelPresets.map(p => ({ value: p.id, label: `${p.displayName} · ${p.modelKind === 'language' ? '语言模型' : '图像模型'} · ${presetProtocolLabel(p)}` })),
])

const selectedPreset = computed(() => admin.modelPresets.find((item) => item.id === form.value.presetId) || null)

const imageCredentialOptions = computed(() => [
  { value: '', label: '未关联（任务将因缺少凭据失败）' },
  ...availableCredentials.value.map(c => ({ value: c.id, label: c.displayName })),
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

const canSave = computed(() =>
  !!selectedPreset.value
  && (selectedPreset.value.modelKind === 'image' || !!form.value.providerCredentialId),
)

onMounted(async () => {
  await Promise.all([admin.fetchModels(), admin.fetchModelPresets(), admin.fetchProviderCredentials(), admin.fetchPromptOptimizationSettings()])
  const settings = admin.promptOptimizationSettings
  if (settings) {
    promptEnabled.value = settings.enabled
    promptAllowRead.value = settings.allowUserReadFinalPrompt
    promptLanguageModelId.value = settings.languageModelConfigId || ''
    promptTimeoutMs.value = settings.timeoutMs
  }
})

// Credentials selectable for the current adapter (must match adapter & be enabled).
const availableCredentials = computed(() =>
  admin.providerCredentials.filter((c) => c.adapter === selectedPreset.value?.adapter && c.enabled),
)

function adapterLabel(adapter: ModelAdapter) {
  return adapter === 'openai' ? 'OpenAI 兼容' : adapter === 'anthropic' ? 'Anthropic' : 'Seedream'
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
  return preset?.modelKind === 'language' ? '语言模型' : '图像模型'
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
  return [
    `供应商：${adapterLabel(preset.adapter)}`,
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
    : availableCredentials.value.find((cred) => cred.adapter === preset.adapter)?.id || ''
  form.value.reasoningEffort = (preset.reasoningEffort || 'medium') as ReasoningEffort
}

function findPresetForModel(model: AdminModel): ModelPreset | undefined {
  return admin.modelPresets.find(preset => preset.id === model.presetId)
    || admin.modelPresets.find(preset => preset.modelKind === (model.modelKind || 'image') && preset.adapter === model.adapter && preset.vendorModelId === model.vendorModelId)
}

function openCreate() {
  editingModel.value = null
  form.value = {
    presetId: '',
    concurrencyLimit: 1,
    watermark: false,
    sortOrder: 0,
    providerCredentialId: '',
    reasoningEffort: 'medium',
  }
  showCreateDialog.value = true
}

function openEdit(model: AdminModel) {
  editingModel.value = model
  const preset = findPresetForModel(model)
  form.value = {
    presetId: preset?.id || '',
    concurrencyLimit: model.concurrencyLimit,
    watermark: model.watermark || false,
    sortOrder: model.sortOrder,
    providerCredentialId: model.providerCredentialId || '',
    reasoningEffort: model.reasoningEffort || preset?.reasoningEffort || 'medium',
  }
  showCreateDialog.value = true
}

async function handleSave() {
  if (!canSave.value) return
  const data: Partial<AdminModel> & { presetId?: string } = {
    presetId: form.value.presetId,
    concurrencyLimit: form.value.concurrencyLimit,
    sortOrder: form.value.sortOrder,
    providerCredentialId: form.value.providerCredentialId || '',
  }
  if (selectedPreset.value?.modelKind === 'image') {
    data.watermark = form.value.watermark
  } else {
    data.reasoningEffort = form.value.reasoningEffort
  }

  if (editingModel.value) {
    await admin.updateModel(editingModel.value.id, data)
  } else {
    await admin.createModel(data)
  }
  showCreateDialog.value = false
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

async function savePromptSettings() {
  const result = await admin.updatePromptOptimizationSettings({
    enabled: promptEnabled.value,
    allowUserReadFinalPrompt: promptAllowRead.value,
    languageModelConfigId: promptLanguageModelId.value || null,
    timeoutMs: promptTimeoutMs.value,
  })
  toast(result.success ? '前处理设置已保存' : result.error?.message || '保存失败', result.success ? 'success' : 'error')
}

const modelColumns: Column<AdminModel>[] = [
  { key: 'displayName', label: '模型名称' },
  { key: 'modelKind', label: '用途', render: row => row.modelKind === 'language' ? '语言模型' : '图像模型' },
  {
    key: 'adapter',
    label: '供应商',
    render: (row) => adapterLabel(row.adapter),
  },
  { key: 'languageProtocol', label: '协议/推理', render: row => row.modelKind === 'language' ? `${languageProtocolLabel(row.languageProtocol)} · ${reasoningLabel(row.reasoningEffort)}` : '-' },
  {
    key: 'enabled',
    label: '状态',
    render: (row) => row.enabled ? '已启用' : '已禁用',
  },
  { key: 'concurrencyLimit', label: '并发上限' },
  { key: 'providerCredentialName', label: '凭据', render: (row) => row.providerCredentialName || '未关联' },
]
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="模型管理">
      <template #actions>
        <button
          class="inline-flex h-8 items-center rounded-[var(--radius-control)] bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
          @click="openCreate"
        >
          添加模型
        </button>
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

    <AppModal v-model:open="showCreateDialog" :title="editingModel ? '编辑模型' : '添加模型'" size="lg">
      <div class="space-y-3">
        <div>
          <label class="mb-1 block text-xs font-medium text-foreground">模型预设</label>
          <BaseDropdown :model-value="form.presetId" :options="presetOptions" @update:model-value="applyPreset" />
        </div>

        <div v-if="selectedPreset" class="rounded-[var(--radius-card)] bg-surface-subtle px-3 py-2">
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

        <div v-if="selectedPreset?.modelKind === 'language'">
          <label class="mb-1 block text-xs font-medium text-foreground">思考等级</label>
          <BaseDropdown v-model="form.reasoningEffort" :options="reasoningEffortOptions" />
        </div>

        <p v-if="selectedPreset?.modelKind === 'image'" class="rounded-[var(--radius-card)] bg-surface-subtle px-3 py-2 text-xs text-muted-foreground">尺寸、质量和生成张数由生成页统一提供常用预设，也支持用户自定义安全尺寸。</p>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="mb-1 block text-xs font-medium text-foreground">并发上限</label>
            <input
              v-model.number="form.concurrencyLimit"
              type="number"
              min="1"
              max="50"
              class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium text-foreground">排序</label>
            <input v-model.number="form.sortOrder" type="number" class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none" />
          </div>
        </div>

        <div v-if="selectedPreset?.modelKind === 'image' && selectedPreset.adapter === 'seedream'" class="flex items-center gap-2 pt-1">
          <PillToggle v-model="form.watermark" />
          <span class="text-xs font-medium text-foreground">启用供应商水印</span>
        </div>
      </div>
      <template #footer="{ close }">
        <button
          class="inline-flex h-9 items-center rounded-[var(--radius-control)] border border-border px-4 text-sm font-medium text-foreground hover:bg-surface-subtle"
          @click="close"
        >
          取消
        </button>
        <button
          :disabled="!canSave"
          class="inline-flex h-9 items-center rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          @click="handleSave"
        >
          {{ editingModel ? '保存' : '添加' }}
        </button>
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
          <BaseDropdown v-model="promptLanguageModelId" :options="promptLanguageModelOptions" />
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <div class="flex items-center gap-2">
            <PillToggle v-model="promptEnabled" />
            <span class="text-sm text-foreground">启用提示词前处理</span>
          </div>
          <div class="flex items-center gap-2">
            <PillToggle v-model="promptAllowRead" />
            <span class="text-sm text-foreground">允许用户读取最终提示词</span>
          </div>
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <label class="text-xs font-medium text-foreground">超时（毫秒）<input v-model.number="promptTimeoutMs" type="number" min="1000" max="300000" class="mt-1 h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm" /></label>
        </div>
        <div class="flex gap-2">
          <button class="inline-flex h-9 items-center rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-white hover:bg-primary-hover" @click="savePromptSettings">保存前处理</button>
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
