<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import { Github, Copy } from 'lucide-vue-next'
import { toast } from '@/shared/composables/useToast'
import PillToggle from '@/shared/components/ui/PillToggle.vue'
import GoogleIcon from '@/shared/components/ui/GoogleIcon.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
import Field from '@/shared/components/ui/Field.vue'
import Badge from '@/shared/components/ui/Badge.vue'
import type { AdminOAuthProvider } from '@/shared/types'

const admin = useAdminStore()
const loading = ref(true)
const loadError = ref('')
const saving = ref<string | null>(null)

const forms = ref<Record<string, { clientId: string; clientSecret: string; enabled: boolean }>>({})

const providers = computed(() => admin.oauthProviders)

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
    toast(`${provider.label} 配置已保存`, 'success')
  } else {
    toast(res.error?.message || '保存失败', 'error')
  }
}

function sourceLabel(source: AdminOAuthProvider['source']) {
  if (source === 'database') return '管理员配置'
  if (source === 'environment') return '环境变量'
  return '未配置'
}

function copyRedirectUri(uri: string) {
  navigator.clipboard.writeText(uri).then(() => toast('已复制 Redirect URI', 'success'))
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="OAuth 配置"
      description="配置 GitHub 与 Google 登录应用。Client Secret 仅加密写入，保存后不可回读。"
    />

    <div v-if="loading" class="py-12 text-center text-xs text-muted-foreground">
      加载中...
    </div>

    <div v-else-if="loadError" class="py-8 text-center">
      <p class="text-xs text-danger">{{ loadError }}</p>
      <button class="mt-3 text-xs font-medium text-primary hover:underline" @click="admin.fetchOAuthProviders">
        重试
      </button>
    </div>

    <div v-else class="space-y-8">
      <div v-for="provider in providers" :key="provider.provider" class="space-y-4">
        <div class="flex items-start justify-between gap-4">
          <div class="flex items-center gap-3">
            <span class="flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] bg-surface-subtle text-foreground">
              <Github v-if="provider.provider === 'github'" class="h-5 w-5" />
              <GoogleIcon v-else class="h-5 w-5" />
            </span>
            <div>
              <h2 class="text-sm font-semibold text-foreground">{{ provider.label }}</h2>
              <p class="mt-1 text-xs text-muted-foreground">{{ sourceLabel(provider.source) }}</p>
            </div>
          </div>
          <Badge :tone="provider.enabled ? 'success' : 'neutral'">
            {{ provider.enabled ? '可用' : '未启用' }}
          </Badge>
        </div>

        <div v-if="forms[provider.provider]" class="space-y-3">
          <Field label="回调地址">
            <div class="flex gap-2">
              <TextInput
                :model-value="provider.redirectUri"
                type="text"
                readonly
                class="flex-1 text-xs"
              />
              <BaseButton
                variant="secondary"
                @click="copyRedirectUri(provider.redirectUri)"
                aria-label="复制 Redirect URI"
              >
                <template #icon>
                  <Copy class="h-4 w-4" />
                </template>
              </BaseButton>
            </div>
          </Field>
          <Field label="Client ID">
            <TextInput
              v-model="forms[provider.provider].clientId"
              type="text"
              autocomplete="off"
            />
          </Field>
          <Field label="Client Secret">
            <TextInput
              v-model="forms[provider.provider].clientSecret"
              type="password"
              autocomplete="off"
              :placeholder="provider.hasClientSecret ? '已配置（留空保持不变）' : '输入 Client Secret'"
            />
          </Field>
          <div class="flex items-center gap-2">
            <PillToggle v-model="forms[provider.provider].enabled" />
            <span class="text-xs font-medium text-foreground">启用该登录方式</span>
          </div>
          <BaseButton
            :disabled="saving === provider.provider"
            :loading="saving === provider.provider"
            @click="saveProvider(provider)"
          >
            {{ saving === provider.provider ? '保存中...' : '保存配置' }}
          </BaseButton>
        </div>
      </div>
    </div>
  </div>
</template>
