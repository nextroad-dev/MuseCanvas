<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useAdminStore } from '@/stores/admin'
import DataTable from '@/components/ui/DataTable.vue'
import type { AdminModel } from '@/types'
import type { Column } from '@/components/ui/DataTable.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'

const admin = useAdminStore()
const showCreateDialog = ref(false)
const editingModel = ref<AdminModel | null>(null)
const selectedPresetId = ref('')

const form = ref({
  displayName: '',
  adapter: 'openai' as 'openai' | 'seedream',
  vendorModelId: '',
  sizes: '1024x1024',
  qualityOptions: '',
  maxCount: 4,
  concurrencyLimit: 1,
  watermark: false,
  sortOrder: 0,
  providerCredentialId: '',
})

onMounted(() => {
  admin.fetchModels()
  admin.fetchModelPresets()
  admin.fetchProviderCredentials()
})

// Credentials selectable for the current adapter (must match adapter & be enabled).
const availableCredentials = computed(() =>
  admin.providerCredentials.filter((c) => c.adapter === form.value.adapter && c.enabled),
)

function applyPreset(id: string) {
  selectedPresetId.value = id
  const preset = admin.modelPresets.find((item) => item.id === id)
  if (!preset) return
  form.value = {
    displayName: preset.displayName, adapter: preset.adapter, vendorModelId: preset.vendorModelId,
    sizes: preset.sizes.join(', '), qualityOptions: preset.qualityOptions.join(', '), maxCount: preset.maxCount,
    concurrencyLimit: preset.concurrencyLimit, watermark: preset.watermark, sortOrder: form.value.sortOrder,
    providerCredentialId: '',
  }
}

function openCreate() {
  editingModel.value = null
  selectedPresetId.value = ''
  form.value = {
    displayName: '',
    adapter: 'openai',
    vendorModelId: '',
    sizes: '1024x1024',
    qualityOptions: '',
    maxCount: 4,
    concurrencyLimit: 1,
    watermark: false,
    sortOrder: 0,
    providerCredentialId: '',
  }
  showCreateDialog.value = true
}

function openEdit(model: AdminModel) {
  editingModel.value = model
  selectedPresetId.value = ''
  form.value = {
    displayName: model.displayName,
    adapter: model.adapter,
    vendorModelId: model.vendorModelId,
    sizes: model.sizes.join(', '),
    qualityOptions: model.qualityOptions?.join(', ') || '',
    maxCount: model.maxCount,
    concurrencyLimit: model.concurrencyLimit,
    watermark: model.watermark || false,
    sortOrder: model.sortOrder,
    providerCredentialId: model.providerCredentialId || '',
  }
  showCreateDialog.value = true
}

async function handleSave() {
  const data: Partial<AdminModel> = {
    displayName: form.value.displayName,
    adapter: form.value.adapter,
    vendorModelId: form.value.vendorModelId,
    sizes: form.value.sizes.split(',').map((s) => s.trim()).filter(Boolean),
    maxCount: form.value.maxCount,
    concurrencyLimit: form.value.concurrencyLimit,
    watermark: form.value.watermark,
    sortOrder: form.value.sortOrder,
  }
  if (form.value.qualityOptions) {
    data.qualityOptions = form.value.qualityOptions.split(',').map((s) => s.trim()).filter(Boolean) as AdminModel['qualityOptions']
  }
  // Empty string clears the association server-side (COALESCE treats '' as null).
  data.providerCredentialId = form.value.providerCredentialId || ''

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

const modelColumns: Column<AdminModel>[] = [
  { key: 'displayName', label: '模型名称' },
  {
    key: 'adapter',
    label: '供应商',
    render: (row) => row.adapter === 'openai' ? 'OpenAI' : 'Seedream',
  },
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
    <div class="flex items-center justify-between">
      <h1 class="text-sm font-semibold text-neutral-900">模型管理</h1>
      <button
        class="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
        @click="openCreate"
      >
        添加模型
      </button>
    </div>

    <DataTable
      :columns="modelColumns"
      :data="admin.models"
      :row-key="(row: AdminModel) => row.id"
      empty-text="暂无模型配置"
    >
      <template #cell-enabled="{ row }">
        <button
          :class="[
            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
            row.enabled ? 'bg-primary' : 'bg-neutral-300',
          ]"
          @click="handleToggleEnabled(row)"
        >
          <span
            :class="[
              'inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
              row.enabled ? 'translate-x-[18px]' : 'translate-x-0.5',
            ]"
          />
        </button>
      </template>

      <template #actions="{ row }">
        <button
          class="text-xs text-neutral-600 hover:underline"
          @click="openEdit(row)"
        >
          编辑
        </button>
      </template>
    </DataTable>

    <!-- Create/Edit dialog -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="showCreateDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div class="relative z-10 w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 shadow-xl">
            <h3 class="mb-4 text-sm font-semibold text-neutral-900">
              {{ editingModel ? '编辑模型' : '添加模型' }}
            </h3>
            <div class="space-y-3">
              <div v-if="!editingModel">
                <label class="mb-1 block text-xs font-medium text-neutral-700">快速预设</label>
                <BaseSelect :model-value="selectedPresetId" @update:model-value="applyPreset">
                  <option value="">自定义配置</option>
                  <option v-for="preset in admin.modelPresets" :key="preset.id" :value="preset.id">{{ preset.displayName }}</option>
                </BaseSelect>
                <p class="mt-1 text-xs text-neutral-400">预设只填充参数，不会自动启用模型。</p>
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-700">显示名称</label>
                <input
                  v-model="form.displayName"
                  type="text"
                  class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-700">供应商类型</label>
                <BaseSelect
                  v-model="form.adapter"
                >
                  <option value="openai">OpenAI (GPT Image)</option>
                  <option value="seedream">Seedream (火山引擎)</option>
                </BaseSelect>
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-700">供应商模型 ID</label>
                <input
                  v-model="form.vendorModelId"
                  type="text"
                  class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-700">供应商凭据（API Key）</label>
                <BaseSelect v-model="form.providerCredentialId">
                  <option value="">未关联（任务将因缺少凭据失败）</option>
                  <option v-for="cred in availableCredentials" :key="cred.id" :value="cred.id">{{ cred.displayName }}</option>
                </BaseSelect>
                <p class="mt-1 text-xs text-neutral-400">
                  仅列出与当前供应商类型匹配且已启用的凭据。
                  <RouterLink to="/admin/providers" class="text-primary hover:underline">前往配置凭据</RouterLink>
                </p>
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-700">支持尺寸 (逗号分隔)</label>
                <input
                  v-model="form.sizes"
                  type="text"
                  placeholder="1024x1024, 1536x1024"
                  class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div v-if="form.adapter === 'openai'">
                <label class="mb-1 block text-xs font-medium text-neutral-700">质量选项 (逗号分隔)</label>
                <input
                  v-model="form.qualityOptions"
                  type="text"
                  placeholder="low, medium, high, auto"
                  class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="mb-1 block text-xs font-medium text-neutral-700">最大张数</label>
                  <input
                    v-model.number="form.maxCount"
                    type="number"
                    min="1"
                    max="10"
                    class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label class="mb-1 block text-xs font-medium text-neutral-700">并发上限</label>
                  <input
                    v-model.number="form.concurrencyLimit"
                    type="number"
                    min="1"
                    max="50"
                    class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="mb-1 block text-xs font-medium text-neutral-700">排序</label>
                  <input v-model.number="form.sortOrder" type="number" class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-primary focus:outline-none" />
                </div>
                <label v-if="form.adapter === 'seedream'" class="flex items-end gap-2 pb-2 text-xs font-medium text-neutral-700">
                  <input v-model="form.watermark" type="checkbox" class="h-4 w-4 rounded border-neutral-300" />
                  启用供应商水印
                </label>
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
                :disabled="!form.displayName || !form.vendorModelId"
                class="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
                @click="handleSave"
              >
                {{ editingModel ? '保存' : '添加' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
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
