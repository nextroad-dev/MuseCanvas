<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSetupStore } from '../stores/setup'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
import Field from '@/shared/components/ui/Field.vue'
import AppAlert from '@/shared/components/ui/AppAlert.vue'

const setup = useSetupStore()

// Secrets stay in memory only and are cleared after successful submit.
const endpoint = ref('')
const publicEndpoint = ref('')
const region = ref('')
const bucket = ref('')
const accessKeyId = ref('')
const secretAccessKey = ref('')
const signedUrlTtlSeconds = ref('')
const localError = ref('')
let hydrated = false

function hydrate() {
  const storage = setup.config?.storage
  if (!storage || hydrated) return
  endpoint.value = storage.endpoint || ''
  publicEndpoint.value = storage.publicEndpoint || ''
  region.value = storage.region || ''
  bucket.value = storage.bucket || ''
  accessKeyId.value = storage.accessKeyId || ''
  signedUrlTtlSeconds.value = storage.signedUrlTtlSeconds != null ? String(storage.signedUrlTtlSeconds) : ''
  hydrated = true
}

watch(() => setup.config?.storage, hydrate, { immediate: true })

const storage = computed(() => setup.config?.storage ?? null)
const done = computed(() => setup.isSectionComplete('storage'))

function buildInput() {
  const ttl = signedUrlTtlSeconds.value.trim()
  const input: Record<string, unknown> = {
    endpoint: endpoint.value.trim() ? endpoint.value.trim() : null,
    publicEndpoint: publicEndpoint.value.trim() ? publicEndpoint.value.trim() : null,
    region: region.value.trim() ? region.value.trim() : null,
    bucket: bucket.value.trim() ? bucket.value.trim() : null,
    accessKeyId: accessKeyId.value.trim() ? accessKeyId.value.trim() : null,
    signedUrlTtlSeconds: ttl === '' ? null : Number(ttl),
  }
  // Blank secret preserves the stored secret server-side.
  if (secretAccessKey.value) input.secretAccessKey = secretAccessKey.value
  return input as Parameters<typeof setup.saveStorage>[0]
}

function validate(): boolean {
  localError.value = ''
  const ttl = signedUrlTtlSeconds.value.trim()
  if (ttl !== '' && (!Number.isInteger(Number(ttl)) || Number(ttl) <= 0)) {
    localError.value = '签名 URL 有效期必须为正整数（秒）'
    return false
  }
  return true
}

async function handleTest() {
  if (!validate()) return
  const isFormEmpty =
    !endpoint.value.trim() && !publicEndpoint.value.trim() && !region.value.trim()
    && !bucket.value.trim() && !accessKeyId.value.trim() && !secretAccessKey.value
    && !signedUrlTtlSeconds.value.trim()
  const res = await setup.testStorage(isFormEmpty ? {} : buildInput())
  if (res.success) secretAccessKey.value = ''
}

async function handleSave() {
  if (!validate()) return
  const res = await setup.saveStorage(buildInput())
  if (res.success) {
    secretAccessKey.value = ''
    await setup.fetchConfig().catch(() => {})
  }
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h3 class="mb-1 text-lg font-semibold text-foreground">对象存储</h3>
      <p class="text-sm text-muted-foreground">S3 兼容对象存储，用于存放生成产物。测试通过（服务端实际读写校验）后才能继续。</p>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <span
        v-if="storage"
        :class="[
          'rounded-full px-2 py-0.5 text-xs',
          storage.status === 'verified'
            ? 'bg-success-soft text-success'
            : storage.status === 'configured'
              ? 'bg-info-soft text-info'
              : storage.status === 'error'
                ? 'bg-danger-soft text-danger'
                : 'bg-surface-subtle text-muted-foreground',
        ]"
      >
        {{
          storage.status === 'verified' ? '已验证' : storage.status === 'configured' ? '已配置未验证' : storage.status === 'error' ? '异常' : '未配置'
        }}
      </span>
      <span v-if="storage?.hasSecret" class="text-xs text-muted-foreground">
        已保存密钥{{ storage.secretFingerprint ? `（指纹 ${storage.secretFingerprint}）` : '' }}，密钥留空即保留
      </span>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <Field label="Endpoint" required hint="例如 https://s3.example.com">
        <TextInput v-model="endpoint" type="url" placeholder="https://s3.example.com" autocomplete="off" />
      </Field>
      <Field label="公网 S3 端点" hint="可选，浏览器可达的 S3 兼容 API 端点，用于签名 GET 直链与 POST 上传；留空则使用 Endpoint">
        <TextInput v-model="publicEndpoint" type="url" placeholder="https://s3-public.example.com" autocomplete="off" />
      </Field>
      <Field label="Region">
        <TextInput v-model="region" type="text" placeholder="us-east-1" autocomplete="off" />
      </Field>
      <Field label="Bucket" required>
        <TextInput v-model="bucket" type="text" placeholder="musecanvas" autocomplete="off" />
      </Field>
      <Field label="AccessKeyId">
        <TextInput v-model="accessKeyId" type="text" placeholder="AKID..." autocomplete="off" />
      </Field>
      <Field label="SecretAccessKey" :hint="storage?.hasSecret ? '留空保留已保存的密钥' : '写入后不可回读'">
        <TextInput v-model="secretAccessKey" type="password" placeholder="SecretAccessKey" autocomplete="new-password" />
      </Field>
      <Field label="签名 URL 有效期（秒）" :error="localError || undefined" class="sm:col-span-2">
        <TextInput
          v-model="signedUrlTtlSeconds"
          type="text"
          inputmode="numeric"
          placeholder="900"
          autocomplete="off"
          :invalid="!!localError"
        />
      </Field>
    </div>

    <AppAlert v-if="setup.sectionError('storageTest')" type="error" title="连接测试失败" :message="setup.sectionError('storageTest')" />
    <AppAlert v-if="setup.sectionError('storage')" type="error" title="保存失败" :message="setup.sectionError('storage')" />
    <AppAlert v-if="done" type="success" message="对象存储已验证通过。" />

    <div class="flex flex-col gap-2 sm:flex-row">
      <BaseButton variant="secondary" class="flex-1" :loading="setup.isBusy('storageTest')" @click="handleTest">
        {{ setup.isBusy('storageTest') ? '测试中...' : '测试连接' }}
      </BaseButton>
      <BaseButton class="flex-1" :loading="setup.isBusy('storage')" @click="handleSave">
        {{ setup.isBusy('storage') ? '保存中...' : '保存对象存储' }}
      </BaseButton>
    </div>
  </div>
</template>
