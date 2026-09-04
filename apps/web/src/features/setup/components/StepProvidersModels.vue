<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import { useSetupStore } from '../stores/setup'
import {
  buildTemplateCredentialInput,
  credentialsForPreset,
  parseServiceAccountJson,
  presetPluginKey,
  templateConfiguredCount,
} from '@/features/admin/lib/provider-templates'
import type { BuiltinProviderTemplate, ModelAdapter } from '@/shared/types'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
import Textarea from '@/shared/components/ui/Textarea.vue'
import Field from '@/shared/components/ui/Field.vue'
import AppAlert from '@/shared/components/ui/AppAlert.vue'

const admin = useAdminStore()
const setup = useSetupStore()

const loading = ref(true)
const loadError = ref('')

const templateForms = ref<Record<string, { displayName: string; secret: string; serviceAccountJson: string }>>({})
const templateErrors = ref<Record<string, string>>({})
const templateSaving = ref<Record<string, boolean>>({})

const credTesting = ref<string | null>(null)
const credTestNotes = ref<Record<string, string>>({})

const selectedPresetId = ref('')
const selectedCredentialId = ref('')
const modelSaving = ref(false)
const modelError = ref('')
const modelNote = ref('')

const SERVICE_ACCOUNT_PLACEHOLDER = '{"type":"service_account","project_id":"...","client_email":"...","private_key":"..."}'

onMounted(async () => {
  loading.value = true
  loadError.value = ''
  // Each fetch reports its own failure inline; a failure here never blocks
  // the optional step, it just surfaces a retryable message.
  const results = await Promise.all([
    admin.fetchProviderTemplates(),
    admin.fetchProviderCredentials(),
    admin.fetchModelPresets(),
    admin.fetchModels(),
  ])
  const failed = results.find((r) => r && typeof r === 'object' && 'success' in r && !r.success)
  if (failed && !failed.success) {
    loadError.value = failed.error?.message || '加载供应商数据失败'
  }
  loading.value = false
})

function formFor(template: BuiltinProviderTemplate) {
  let form = templateForms.value[template.key]
  if (!form) {
    form = { displayName: template.displayName, secret: '', serviceAccountJson: '' }
    templateForms.value = { ...templateForms.value, [template.key]: form }
  }
  return form
}

function configuredCount(template: BuiltinProviderTemplate) {
  return templateConfiguredCount(admin.providerCredentials, template)
}

function pluginLabel(template: BuiltinProviderTemplate) {
  return `${template.pluginId}@${template.pluginVersion}`
}

async function handleTemplateSave(template: BuiltinProviderTemplate) {
  const form = formFor(template)
  if (!form.displayName.trim()) {
    templateErrors.value = { ...templateErrors.value, [template.key]: '请填写凭据名称' }
    return
  }
  let secret: string | Record<string, unknown>
  if (template.credential.kind === 'google_service_account') {
    const parsed = parseServiceAccountJson(form.serviceAccountJson)
    if (!parsed.ok) {
      templateErrors.value = { ...templateErrors.value, [template.key]: parsed.error }
      return
    }
    secret = parsed.value
  } else if (!form.secret.trim()) {
    templateErrors.value = { ...templateErrors.value, [template.key]: '请输入 API Key' }
    return
  } else {
    secret = form.secret.trim()
  }
  templateSaving.value = { ...templateSaving.value, [template.key]: true }
  templateErrors.value = { ...templateErrors.value, [template.key]: '' }
  const res = await admin.createProviderCredential(buildTemplateCredentialInput(template, secret, form.displayName))
  templateSaving.value = { ...templateSaving.value, [template.key]: false }
  if (res.success) {
    // Secrets are write-only: clear the in-memory secret after a good save.
    form.secret = ''
    form.serviceAccountJson = ''
    templateErrors.value = { ...templateErrors.value, [template.key]: '' }
  } else {
    // Never advance past a failed save: the error stays on the item and the
    // wizard does not auto-advance (navigation is separate from saving).
    templateErrors.value = { ...templateErrors.value, [template.key]: res.error?.message || '保存失败' }
  }
}

async function handleTestCredential(id: string, displayName: string) {
  credTesting.value = id
  const res = await admin.testProviderCredential(id)
  credTesting.value = null
  credTestNotes.value = {
    ...credTestNotes.value,
    [id]: res.success ? `「${displayName}」连接测试通过` : res.error?.message || '测试失败',
  }
}

function adapterLabel(adapter: ModelAdapter | string) {
  if (adapter === 'openai') return 'OpenAI 兼容'
  if (adapter === 'anthropic') return 'Anthropic'
  if (adapter === 'seedream') return 'Seedream'
  if (adapter === 'veo') return 'Veo (Google 视频)'
  if (adapter === 'volcengine') return '火山引擎视频'
  if (adapter === 'google') return 'Google'
  return String(adapter)
}

const selectedPreset = computed(() => admin.modelPresets.find((p) => p.id === selectedPresetId.value))
const credentialOptions = computed(() => credentialsForPreset(admin.providerCredentials, selectedPreset.value))

async function handleCreateModel() {
  modelError.value = ''
  modelNote.value = ''
  if (!selectedPreset.value) {
    modelError.value = '请选择模型预设'
    return
  }
  const preset = selectedPreset.value
  const data: Record<string, unknown> = {
    presetId: preset.id,
    concurrencyLimit: preset.concurrencyLimit,
    sortOrder: 0,
  }
  if (selectedCredentialId.value) data.providerCredentialId = selectedCredentialId.value
  if (preset.modelKind === 'image') data.watermark = preset.watermark ?? false
  else if (preset.modelKind === 'language') data.reasoningEffort = preset.reasoningEffort || 'medium'
  modelSaving.value = true
  const res = await admin.createModel(data)
  modelSaving.value = false
  if (res.success) {
    modelNote.value = `模型「${preset.displayName}」已创建`
  } else {
    modelError.value = `${preset.displayName}：${res.error?.message || '创建失败'}`
  }
}

async function handleRetry() {
  loading.value = true
  loadError.value = ''
  const res = await admin.fetchProviderTemplates()
  await admin.fetchProviderCredentials()
  await admin.fetchModelPresets()
  loading.value = false
  if (!res.success) {
    loadError.value = res.error?.message || '加载供应商数据失败'
  }
  await setup.checkStatus().catch(() => {})
}
</script>

<template>
  <div class="space-y-8">
    <div>
      <h3 class="mb-1 text-lg font-semibold text-foreground">供应商与模型 <span class="text-sm font-normal text-muted-foreground">（可选，可跳过）</span></h3>
      <p class="text-sm text-muted-foreground">按内置插件配置凭据并创建模型。保存失败会停留在本项并显示错误，不会自动进入下一步。</p>
    </div>

    <AppAlert v-if="loadError" type="error" title="加载失败" :message="loadError" />
    <div v-if="loadError">
      <BaseButton variant="secondary" size="sm" :loading="loading" @click="handleRetry">
        {{ loading ? '加载中...' : '重试' }}
      </BaseButton>
    </div>

    <section aria-label="内置插件凭据" class="space-y-3">
      <h4 class="text-sm font-medium text-foreground">内置插件凭据</h4>
      <div v-if="loading" class="py-4 text-center text-sm text-muted-foreground">加载中...</div>
      <div v-else-if="admin.providerTemplates.length === 0" class="py-4 text-center text-sm text-muted-foreground">
        暂无内置插件模板
      </div>
      <div v-else class="grid gap-3 sm:grid-cols-2">
        <div
          v-for="template in admin.providerTemplates"
          :key="template.key"
          class="rounded-[var(--radius-card)] border border-border bg-surface-subtle p-4"
        >
          <p class="font-medium text-foreground">{{ template.displayName }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {{ adapterLabel(template.adapter) }} · {{ pluginLabel(template) }} · 已配置 {{ configuredCount(template) }} 个
          </p>
          <div class="mt-3 space-y-2">
            <Field label="凭据名称">
              <TextInput v-model="formFor(template).displayName" placeholder="凭据名称" />
            </Field>
            <Field
              v-if="template.credential.kind === 'google_service_account'"
              label="服务账号 JSON"
              :error="templateErrors[template.key] || undefined"
            >
              <Textarea
                v-model="formFor(template).serviceAccountJson"
                :placeholder="SERVICE_ACCOUNT_PLACEHOLDER"
                :rows="3"
                :invalid="!!templateErrors[template.key]"
              />
            </Field>
            <Field v-else label="API Key" :error="templateErrors[template.key] || undefined">
              <TextInput
                v-model="formFor(template).secret"
                type="password"
                placeholder="API Key（写入后不可回读）"
                autocomplete="new-password"
                :invalid="!!templateErrors[template.key]"
              />
            </Field>
            <BaseButton
              size="sm"
              class="w-full"
              :loading="!!templateSaving[template.key]"
              @click="handleTemplateSave(template)"
            >
              {{ templateSaving[template.key] ? '保存中...' : '创建凭据' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </section>

    <section aria-label="凭据连接测试" class="space-y-2">
      <h4 class="text-sm font-medium text-foreground">凭据连接测试</h4>
      <div v-if="admin.providerCredentials.length === 0" class="text-sm text-muted-foreground">暂无凭据，先在上方创建。</div>
      <ul v-else class="space-y-2">
        <li
          v-for="cred in admin.providerCredentials"
          :key="cred.id"
          class="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3 py-2"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-foreground">{{ cred.displayName }}</p>
            <p class="text-xs text-muted-foreground">
              {{ adapterLabel(cred.providerId || cred.adapter) }}
              {{ cred.configuredFields?.pluginId ? ` · ${cred.configuredFields.pluginId}@${cred.configuredFields.pluginVersion}` : '' }}
              · 上次测试：{{ cred.lastTestStatus === 'success' ? '通过' : cred.lastTestStatus === 'failed' ? '失败' : '未测试' }}
            </p>
            <p v-if="credTestNotes[cred.id]" class="mt-0.5 text-xs text-muted-foreground">{{ credTestNotes[cred.id] }}</p>
          </div>
          <BaseButton size="sm" variant="secondary" :loading="credTesting === cred.id" @click="handleTestCredential(cred.id, cred.displayName)">
            {{ credTesting === cred.id ? '测试中...' : '测试' }}
          </BaseButton>
        </li>
      </ul>
    </section>

    <section aria-label="创建模型" class="space-y-3">
      <h4 class="text-sm font-medium text-foreground">创建模型</h4>
      <div class="grid gap-3 sm:grid-cols-2">
        <Field label="模型预设">
          <select
            v-model="selectedPresetId"
            class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">请选择模型预设</option>
            <option v-for="preset in admin.modelPresets" :key="preset.id" :value="preset.id">
              {{ preset.displayName }} · {{ presetPluginKey(preset) || adapterLabel(preset.providerId || preset.adapter || '') }}
            </option>
          </select>
        </Field>
        <Field label="供应商凭据" hint="按插件精确匹配，缺插件身份时回退到 providerId">
          <select
            v-model="selectedCredentialId"
            class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">未关联（任务将因缺少凭据失败）</option>
            <option v-for="cred in credentialOptions" :key="cred.id" :value="cred.id">
              {{ cred.displayName }}
            </option>
          </select>
        </Field>
      </div>
      <p v-if="selectedPreset && credentialOptions.length === 0" class="text-xs text-muted-foreground">
        所选预设暂无精确匹配的已启用凭据（{{ presetPluginKey(selectedPreset) || '无插件身份' }}），可先在上方创建对应插件凭据。
      </p>
      <AppAlert v-if="modelError" type="error" title="创建失败" :message="modelError" />
      <AppAlert v-if="modelNote" type="success" :message="modelNote" />
      <BaseButton :loading="modelSaving" :disabled="!selectedPresetId" @click="handleCreateModel">
        {{ modelSaving ? '创建中...' : '创建模型' }}
      </BaseButton>
      <p v-if="admin.models.length > 0" class="text-xs text-muted-foreground">已创建 {{ admin.models.length }} 个模型。</p>
    </section>
  </div>
</template>
