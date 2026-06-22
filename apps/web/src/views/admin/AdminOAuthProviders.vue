<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { AlertCircle, CheckCircle, Github, ShieldCheck } from 'lucide-vue-next'
import { useAdminStore } from '@/stores/admin'
import type { AdminOAuthProvider } from '@/types'

const admin = useAdminStore()
const loading = ref(true)
const loadError = ref('')
const saving = ref<string | null>(null)
const alert = ref<{ kind: 'success' | 'error'; text: string } | null>(null)
let alertTimer: ReturnType<typeof setTimeout> | undefined

const forms = ref<Record<string, { clientId: string; clientSecret: string; enabled: boolean }>>({})

const providers = computed(() => admin.oauthProviders)

function showAlert(kind: 'success' | 'error', text: string) {
  alert.value = { kind, text }
  if (alertTimer) clearTimeout(alertTimer)
  alertTimer = setTimeout(() => (alert.value = null), 5000)
}

function syncForms(items: AdminOAuthProvider[]) {
  forms.value = Object.fromEntries(items.map((item) => [item.provider, {
    clientId: item.clientId || '',
    clientSecret: '',
    enabled: item.configuredInDatabase || item.enabled,
  }]))
}

onMounted(async () => {
  loading.value = true
  loadError.value = ''
  try {
    const res = await admin.fetchOAuthProviders()
    if (res.success) syncForms(admin.oauthProviders)
    else loadError.value = res.error?.message || '加载 OAuth 配置失败'
  } catch {
    loadError.value = '加载 OAuth 配置失败'
  } finally {
    loading.value = false
  }
})

async function saveProvider(provider: AdminOAuthProvider) {
  const form = forms.value[provider.provider]
  if (!form) return
  saving.value = provider.provider
  const res = await admin.updateOAuthProvider(provider.provider, {
    clientId: form.clientId.trim(),
    clientSecret: form.clientSecret.trim() || undefined,
    enabled: form.enabled,
  })
  saving.value = null
  if (res.success) {
    syncForms(admin.oauthProviders)
    showAlert('success', `${provider.label} 配置已保存`)
  } else {
    showAlert('error', res.error?.message || '保存失败')
  }
}

function sourceLabel(source: AdminOAuthProvider['source']) {
  if (source === 'database') return '管理员配置'
  if (source === 'environment') return '环境变量'
  return '未配置'
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-sm font-semibold text-neutral-900">OAuth 登录</h1>
      <p class="mt-1 text-xs text-neutral-500">配置 GitHub 与 Google 登录应用。Client Secret 仅加密写入，保存后不可回读。</p>
    </div>

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

    <div v-if="loading" class="rounded-xl border border-neutral-200 p-12 text-center text-xs text-neutral-400">
      加载中...
    </div>

    <div v-else-if="loadError" class="rounded-xl border border-red-200 bg-red-50 p-8 text-center">
      <p class="text-xs text-red-700">{{ loadError }}</p>
      <button class="mt-3 text-xs font-medium text-primary hover:underline" @click="admin.fetchOAuthProviders">
        重试
      </button>
    </div>

    <div v-else class="grid gap-4 xl:grid-cols-2">
      <section
        v-for="provider in providers"
        :key="provider.provider"
        class="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="flex items-center gap-3">
            <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-100 text-neutral-700">
              <Github v-if="provider.provider === 'github'" class="h-5 w-5" />
              <ShieldCheck v-else class="h-5 w-5" />
            </span>
            <div>
              <h2 class="text-sm font-semibold text-neutral-900">{{ provider.label }}</h2>
              <p class="mt-1 text-xs text-neutral-400">{{ sourceLabel(provider.source) }}</p>
            </div>
          </div>
          <span
            :class="[
              'rounded-full px-2 py-0.5 text-xs font-medium',
              provider.enabled ? 'bg-green-50 text-green-700' : 'bg-neutral-100 text-neutral-500',
            ]"
          >
            {{ provider.enabled ? '可用' : '未启用' }}
          </span>
        </div>

        <div v-if="forms[provider.provider]" class="mt-5 space-y-3">
          <div>
            <label class="mb-1 block text-xs font-medium text-neutral-700">回调地址</label>
            <input
              :value="provider.redirectUri"
              readonly
              class="h-9 w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 text-xs text-neutral-600 focus:outline-none"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium text-neutral-700">Client ID</label>
            <input
              v-model="forms[provider.provider].clientId"
              type="text"
              autocomplete="off"
              class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium text-neutral-700">Client Secret</label>
            <input
              v-model="forms[provider.provider].clientSecret"
              type="password"
              autocomplete="off"
              :placeholder="provider.hasClientSecret ? '已配置（留空保持不变）' : '输入 Client Secret'"
              class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <label class="flex items-center gap-2 text-xs font-medium text-neutral-700">
            <input v-model="forms[provider.provider].enabled" type="checkbox" class="h-4 w-4 rounded border-neutral-300" />
            启用该登录方式
          </label>
          <button
            :disabled="saving === provider.provider"
            class="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
            @click="saveProvider(provider)"
          >
            {{ saving === provider.provider ? '保存中...' : '保存配置' }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
