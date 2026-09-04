<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSetupStore } from '../stores/setup'
import { RUNTIME_SETTINGS_DEFAULTS } from '@/shared/types'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
import Field from '@/shared/components/ui/Field.vue'
import AppAlert from '@/shared/components/ui/AppAlert.vue'

const setup = useSetupStore()

interface RuntimeField {
  key: 'uploadTtlSeconds' | 'signedUrlTtlSeconds' | 'maxImageBytes' | 'maxTotalBytes' | 'maxInputs' | 'providerTimeoutMs' | 'maxOutputBytes' | 'jobLeaseMs'
  label: string
  hint: string
}

const FIELDS: RuntimeField[] = [
  { key: 'uploadTtlSeconds', label: '上传凭证有效期（秒）', hint: `服务端默认 ${RUNTIME_SETTINGS_DEFAULTS.uploadTtlSeconds}` },
  { key: 'signedUrlTtlSeconds', label: '签名 URL 有效期（秒）', hint: `服务端默认 ${RUNTIME_SETTINGS_DEFAULTS.signedUrlTtlSeconds}` },
  { key: 'maxImageBytes', label: '单图最大字节数', hint: `服务端默认 ${RUNTIME_SETTINGS_DEFAULTS.maxImageBytes}` },
  { key: 'maxTotalBytes', label: '单次请求最大字节数', hint: `服务端默认 ${RUNTIME_SETTINGS_DEFAULTS.maxTotalBytes}` },
  { key: 'maxInputs', label: '单次最大输入数', hint: `服务端默认 ${RUNTIME_SETTINGS_DEFAULTS.maxInputs}` },
  { key: 'providerTimeoutMs', label: '供应商超时（毫秒）', hint: `服务端默认 ${RUNTIME_SETTINGS_DEFAULTS.providerTimeoutMs}` },
  { key: 'maxOutputBytes', label: '单次输出最大字节数', hint: `服务端默认 ${RUNTIME_SETTINGS_DEFAULTS.maxOutputBytes}` },
  { key: 'jobLeaseMs', label: '任务租约（毫秒）', hint: `服务端默认 ${RUNTIME_SETTINGS_DEFAULTS.jobLeaseMs}` },
]

const values = ref<Record<RuntimeField['key'], string>>({
  uploadTtlSeconds: '',
  signedUrlTtlSeconds: '',
  maxImageBytes: '',
  maxTotalBytes: '',
  maxInputs: '',
  providerTimeoutMs: '',
  maxOutputBytes: '',
  jobLeaseMs: '',
})
const fieldErrors = ref<Partial<Record<RuntimeField['key'], string>>>({})
let hydrated = false

function hydrate() {
  const runtime = setup.config?.runtime
  if (hydrated) return
  const source = runtime ?? RUNTIME_SETTINGS_DEFAULTS
  values.value = {
    uploadTtlSeconds: String(source.uploadTtlSeconds),
    signedUrlTtlSeconds: String(source.signedUrlTtlSeconds),
    maxImageBytes: String(source.maxImageBytes),
    maxTotalBytes: String(source.maxTotalBytes),
    maxInputs: String(source.maxInputs),
    providerTimeoutMs: String(source.providerTimeoutMs),
    maxOutputBytes: String(source.maxOutputBytes),
    jobLeaseMs: String(source.jobLeaseMs),
  }
  hydrated = true
}

watch(() => setup.config?.runtime, hydrate, { immediate: true })

const saved = computed(() => setup.config?.runtime ?? null)
const done = computed(() => setup.isSectionComplete('runtime'))

function validate(): boolean {
  const next: Partial<Record<RuntimeField['key'], string>> = {}
  for (const field of FIELDS) {
    const raw = values.value[field.key].trim()
    if (raw === '' || !Number.isInteger(Number(raw)) || Number(raw) <= 0) {
      next[field.key] = '必须为正整数'
    }
  }
  fieldErrors.value = next
  return Object.keys(next).length === 0
}

async function handleSave() {
  if (!validate()) return
  const res = await setup.saveRuntime({
    uploadTtlSeconds: Number(values.value.uploadTtlSeconds),
    signedUrlTtlSeconds: Number(values.value.signedUrlTtlSeconds),
    maxImageBytes: Number(values.value.maxImageBytes),
    maxTotalBytes: Number(values.value.maxTotalBytes),
    maxInputs: Number(values.value.maxInputs),
    providerTimeoutMs: Number(values.value.providerTimeoutMs),
    maxOutputBytes: Number(values.value.maxOutputBytes),
    jobLeaseMs: Number(values.value.jobLeaseMs),
  })
  if (!res.success) return
  await setup.fetchConfig().catch(() => {})
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h3 class="mb-1 text-lg font-semibold text-foreground">高级运行时设置</h3>
      <p class="text-sm text-muted-foreground">表单已按服务端当前值（缺省时为服务端默认值）预填，均为正整数。保存后标记本节完成。</p>
    </div>

    <AppAlert v-if="done" type="success" message="运行时设置已完成。" />

    <div class="grid gap-4 sm:grid-cols-2">
      <Field
        v-for="field in FIELDS"
        :key="field.key"
        :label="field.label"
        :hint="field.hint"
        :error="fieldErrors[field.key] || undefined"
      >
        <TextInput
          v-model="values[field.key]"
          type="text"
          inputmode="numeric"
          :invalid="!!fieldErrors[field.key]"
        />
      </Field>
    </div>

    <AppAlert v-if="setup.sectionError('runtime')" type="error" title="保存失败" :message="setup.sectionError('runtime')" />

    <div v-if="saved" class="rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3 py-2 text-xs text-muted-foreground">
      已保存版本 rev {{ saved.revision }} · 更新于 {{ new Date(saved.updatedAt).toLocaleString('zh-CN') }}
    </div>

    <BaseButton class="w-full sm:w-auto" :loading="setup.isBusy('runtime')" @click="handleSave">
      {{ setup.isBusy('runtime') ? '保存中...' : '保存运行时设置' }}
    </BaseButton>
  </div>
</template>
