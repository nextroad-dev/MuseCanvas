<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import { useSetupStore } from '../stores/setup'
import { parseTemplateImportFile } from '../lib/templateImport'
import type { AdminOAuthProvider } from '@/shared/types'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
import Field from '@/shared/components/ui/Field.vue'
import AppAlert from '@/shared/components/ui/AppAlert.vue'
import PillToggle from '@/shared/components/ui/PillToggle.vue'

const admin = useAdminStore()
const setup = useSetupStore()

// ---- OAuth (optional) ----
const oauthLoading = ref(true)
const oauthLoadError = ref('')
const oauthForms = ref<Record<string, { clientId: string; clientSecret: string; enabled: boolean }>>({})
const oauthSaving = ref<string | null>(null)
const oauthErrors = ref<Record<string, string>>({})
const oauthNotes = ref<Record<string, string>>({})

function syncOauthForms(items: AdminOAuthProvider[]) {
  oauthForms.value = Object.fromEntries(items.map((item) => [item.provider, {
    clientId: item.clientId || '',
    clientSecret: '',
    enabled: item.configuredInDatabase || item.enabled,
  }]))
}

onMounted(async () => {
  oauthLoading.value = true
  oauthLoadError.value = ''
  try {
    const res = await admin.fetchOAuthProviders()
    if (res.success) syncOauthForms(admin.oauthProviders)
    else oauthLoadError.value = res.error?.message || '加载 OAuth 配置失败'
  } catch {
    oauthLoadError.value = '加载 OAuth 配置失败'
  } finally {
    oauthLoading.value = false
  }
})

async function handleSaveOAuth(provider: AdminOAuthProvider) {
  const form = oauthForms.value[provider.provider]
  if (!form) return
  oauthSaving.value = provider.provider
  oauthErrors.value = { ...oauthErrors.value, [provider.provider]: '' }
  const res = await admin.updateOAuthProvider(provider.provider, {
    clientId: form.clientId.trim(),
    clientSecret: form.clientSecret.trim() || undefined,
    enabled: form.enabled,
  })
  oauthSaving.value = null
  if (res.success) {
    syncOauthForms(admin.oauthProviders)
    oauthNotes.value = { ...oauthNotes.value, [provider.provider]: `${provider.label} 配置已保存` }
  } else {
    // Never advance past a failed save: keep the error on the item.
    oauthErrors.value = { ...oauthErrors.value, [provider.provider]: res.error?.message || '保存失败' }
  }
}

// ---- Prompt template import (optional) ----
const fileInput = ref<HTMLInputElement | null>(null)
const parsedNames = ref<string[]>([])
const parsedCount = ref(0)
const parseError = ref('')
const parseItemErrors = ref<string[]>([])
const parseWarnings = ref<string[]>([])
const importing = ref(false)
const importNote = ref('')
let stagedTemplates: Array<{ name: string; description: string; instruction: string }> = []

const currentTemplates = computed(() => setup.config?.templates ?? null)

function resetImportState() {
  stagedTemplates = []
  parsedNames.value = []
  parsedCount.value = 0
  parseError.value = ''
  parseItemErrors.value = []
  parseWarnings.value = []
  importNote.value = ''
}

async function handleFileChange(event: Event) {
  resetImportState()
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const raw = await file.text()
  const parsed = parseTemplateImportFile(raw)
  if (!parsed.ok) {
    parseError.value = parsed.error
    parseItemErrors.value = parsed.itemErrors.map((e) => e.message)
    return
  }
  stagedTemplates = parsed.result.entries.map(({ name, description, instruction }) => ({ name, description, instruction }))
  parsedNames.value = parsed.result.entries.map((e) => e.name)
  parsedCount.value = parsed.result.entries.length
  parseWarnings.value = parsed.result.warnings
}

async function handleImport() {
  parseError.value = ''
  importNote.value = ''
  if (stagedTemplates.length === 0) {
    parseError.value = '请先选择包含模板索引 JSON 的文件并通过解析'
    return
  }
  importing.value = true
  const res = await setup.importTemplates({ templates: stagedTemplates })
  importing.value = false
  if (res.success && res.data) {
    importNote.value = `已导入 ${res.data.entryCount} 条模板（版本 v${res.data.version}）`
    resetFileInput()
  }
}

function resetFileInput() {
  if (fileInput.value) fileInput.value.value = ''
  stagedTemplates = []
  parsedNames.value = []
  parsedCount.value = 0
}
</script>

<template>
  <div class="space-y-8">
    <div>
      <h3 class="mb-1 text-lg font-semibold text-foreground">第三方登录与提示词模板 <span class="text-sm font-normal text-muted-foreground">（可选，可跳过）</span></h3>
      <p class="text-sm text-muted-foreground">配置 GitHub / Google 登录，并可导入提示词模板索引 JSON。</p>
    </div>

    <section aria-label="OAuth 登录" class="space-y-4">
      <h4 class="text-sm font-medium text-foreground">第三方登录</h4>
      <div v-if="oauthLoading" class="py-4 text-center text-sm text-muted-foreground">加载中...</div>
      <AppAlert v-else-if="oauthLoadError" type="error" title="加载失败" :message="oauthLoadError" />
      <div
        v-for="provider in admin.oauthProviders"
        v-else
        :key="provider.provider"
        class="space-y-3 rounded-[var(--radius-card)] border border-border bg-surface-subtle p-4"
      >
        <div class="flex items-center justify-between gap-3">
          <p class="font-medium text-foreground">{{ provider.label }}</p>
          <label class="flex items-center gap-2 text-xs text-muted-foreground">
            启用
            <PillToggle
              :model-value="oauthForms[provider.provider]?.enabled ?? false"
              @update:model-value="(v: boolean) => { if (oauthForms[provider.provider]) oauthForms[provider.provider].enabled = v }"
            />
          </label>
        </div>
        <div class="rounded-[var(--radius-control)] border border-border bg-background p-2.5">
          <p class="mb-1 text-xs text-muted-foreground">回调地址（需在开发者控制台配置）</p>
          <code class="break-all text-xs text-primary">{{ provider.redirectUri || '加载中...' }}</code>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <Field label="Client ID">
            <TextInput
              :model-value="oauthForms[provider.provider]?.clientId || ''"
              placeholder="Client ID"
              @update:model-value="(v: string) => { if (oauthForms[provider.provider]) oauthForms[provider.provider].clientId = v }"
            />
          </Field>
          <Field label="Client Secret" hint="留空不修改">
            <TextInput
              :model-value="oauthForms[provider.provider]?.clientSecret || ''"
              type="password"
              placeholder="Client Secret（留空不修改）"
              autocomplete="new-password"
              @update:model-value="(v: string) => { if (oauthForms[provider.provider]) oauthForms[provider.provider].clientSecret = v }"
            />
          </Field>
        </div>
        <AppAlert v-if="oauthErrors[provider.provider]" type="error" :message="oauthErrors[provider.provider]" />
        <AppAlert v-if="oauthNotes[provider.provider]" type="success" :message="oauthNotes[provider.provider]" />
        <BaseButton size="sm" :loading="oauthSaving === provider.provider" @click="handleSaveOAuth(provider)">
          {{ oauthSaving === provider.provider ? '保存中...' : `保存${provider.label}` }}
        </BaseButton>
      </div>
    </section>

    <section aria-label="提示词模板导入" class="space-y-3">
      <h4 class="text-sm font-medium text-foreground">提示词模板导入</h4>
      <p class="text-xs text-muted-foreground">
        选择索引 JSON 文件（顶层数组或包含 templates/entries 的对象；每条含 name/description/path/instruction）。
        文件在浏览器本地解析后以 JSON 提交，不经过本地存储。
      </p>
      <div v-if="currentTemplates" class="text-xs text-muted-foreground">
        当前模板：{{ currentTemplates.active ? `${currentTemplates.active.name} v${currentTemplates.active.version} · ${currentTemplates.active.entryCount} 条` : '未导入' }}
        · 索引 {{ currentTemplates.entries.length }} 条
      </div>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        aria-label="选择模板索引 JSON 文件"
        class="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-[var(--radius-control)] file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-foreground"
        @change="handleFileChange"
      />
      <div v-if="parsedCount > 0" class="rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3 py-2">
        <p class="text-xs font-medium text-foreground">已解析 {{ parsedCount }} 条：{{ parsedNames.slice(0, 5).join('、') }}{{ parsedCount > 5 ? '…' : '' }}</p>
      </div>
      <AppAlert v-if="parseError" type="error" title="解析失败" :message="parseError" />
      <ul v-if="parseItemErrors.length > 0" class="space-y-1">
        <li v-for="(message, i) in parseItemErrors" :key="i" class="text-xs text-danger" role="alert">{{ message }}</li>
      </ul>
      <div v-if="parseWarnings.length > 0" class="space-y-1">
        <AppAlert v-for="(warning, i) in parseWarnings" :key="i" type="warning" :message="warning" />
      </div>
      <AppAlert v-if="setup.sectionError('templates')" type="error" title="导入失败" :message="setup.sectionError('templates')" />
      <AppAlert v-if="importNote" type="success" :message="importNote" />
      <BaseButton :loading="importing" :disabled="stagedTemplates.length === 0" @click="handleImport">
        {{ importing ? '导入中...' : `导入${parsedCount > 0 ? ` ${parsedCount} 条` : ''}模板` }}
      </BaseButton>
    </section>
  </div>
</template>
