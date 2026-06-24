<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth'
import { useAccountStore } from '@/features/account/stores/account'
import { Github, Link2, Unlink, ShieldCheck, Calendar, Mail } from 'lucide-vue-next'
import ConfirmDialog from '@/shared/components/ui/ConfirmDialog.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import { toast } from '@/shared/composables/useToast'

const auth = useAuthStore()
const account = useAccountStore()
const router = useRouter()
const route = useRoute()

const user = computed(() => auth.user)
const unlinkTarget = ref<'github' | 'google' | null>(null)

const PROVIDERS: { provider: 'github' | 'google'; label: string }[] = [
  { provider: 'github', label: 'GitHub' },
  { provider: 'google', label: 'Google' },
]

const OAUTH_ERROR_LABELS: Record<string, string> = {
  OAUTH_EMAIL_MISMATCH: '第三方账户邮箱与当前账户不一致，无法绑定',
  OAUTH_IDENTITY_CONFLICT: '该第三方账户已绑定其他用户',
  OAUTH_PROVIDER_DISABLED: '该第三方登录未启用',
  OAUTH_DENIED: '已取消第三方授权',
  OAUTH_STATE_EXPIRED: '绑定会话已过期，请重试',
}

function isLinked(provider: 'github' | 'google') {
  return account.oauthIdentities.some((i) => i.provider === provider)
}
function providerEnabled(provider: 'github' | 'google') {
  return auth.oauthProviders.some((p) => p.provider === provider && p.enabled)
}

onMounted(async () => {
  await Promise.all([account.fetchOAuthIdentities(), auth.fetchOAuthProviders()])
  if (route.query.linked) {
    toast('第三方账户已绑定', 'success')
    router.replace({ query: {} })
  } else if (typeof route.query.error === 'string') {
    toast(OAUTH_ERROR_LABELS[route.query.error] || '绑定失败，请重试', 'error')
    router.replace({ query: {} })
  }
})

async function confirmUnlink() {
  const provider = unlinkTarget.value
  if (!provider) return
  const res = await account.unlinkOAuth(provider)
  unlinkTarget.value = null
  if (res.success) toast('已解除绑定', 'success')
  else toast(res.error?.message || '解除绑定失败', 'error')
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

const initials = computed(() => {
  const email = user.value?.email || ''
  return email.charAt(0).toUpperCase()
})
</script>

<template>
  <div class="flex h-full w-full justify-center overflow-auto p-6">
    <h1 class="sr-only">账户设置</h1>
    <div class="w-full max-w-2xl space-y-6">
      <!-- Profile Card -->
      <div class="rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-sm">
        <div class="flex items-center gap-4">
          <div class="flex h-14 w-14 items-center justify-center rounded-full bg-primary-soft text-lg font-semibold text-primary">
            {{ initials }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-base font-semibold text-foreground">{{ user?.email }}</p>
            <div class="mt-1 flex items-center gap-2">
              <span class="inline-flex items-center rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary">
                {{ user?.role === 'admin' ? '管理员' : '用户' }}
              </span>
            </div>
          </div>
        </div>

        <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="flex items-start gap-3 rounded-[var(--radius-card)] bg-surface-subtle p-4">
            <Mail class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p class="text-xs text-muted-foreground">邮箱</p>
              <p class="mt-0.5 text-sm font-medium text-foreground">{{ user?.email }}</p>
            </div>
          </div>
          <div class="flex items-start gap-3 rounded-[var(--radius-card)] bg-surface-subtle p-4">
            <Calendar class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p class="text-xs text-muted-foreground">注册时间</p>
              <p class="mt-0.5 text-sm font-medium text-foreground">
                {{ user?.createdAt ? formatDate(user.createdAt) : '-' }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- OAuth Card -->
      <div class="rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-sm">
        <h3 class="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
          <ShieldCheck class="h-4 w-4 text-muted-foreground" />
          第三方账户
        </h3>
        <p class="mb-4 text-xs text-muted-foreground">绑定后可使用第三方账户快速登录；仅可绑定与当前邮箱一致的账户。</p>

        <div class="space-y-3">
          <div
            v-for="p in PROVIDERS"
            :key="p.provider"
            class="flex items-center justify-between rounded-[var(--radius-card)] border border-border px-4 py-3 transition-colors hover:bg-surface-subtle"
          >
            <div class="flex items-center gap-3">
              <div class="flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] bg-surface-subtle">
                <Github v-if="p.provider === 'github'" class="h-5 w-5 text-foreground" />
                <svg v-else class="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"/>
                </svg>
              </div>
              <div>
                <p class="text-sm font-medium text-foreground">{{ p.label }}</p>
                <p class="text-xs text-muted-foreground">
                  {{ isLinked(p.provider) ? '已绑定' : providerEnabled(p.provider) ? '未绑定' : '未启用' }}
                </p>
              </div>
            </div>

            <BaseButton
              v-if="isLinked(p.provider)"
              size="sm"
              variant="secondary"
              @click="unlinkTarget = p.provider"
            >
              <template #icon>
                <Unlink class="h-3.5 w-3.5" />
              </template>
              解绑
            </BaseButton>
            <BaseButton
              v-else
              size="sm"
              :disabled="!providerEnabled(p.provider)"
              @click="account.linkOAuth(p.provider)"
            >
              <template #icon>
                <Link2 class="h-3.5 w-3.5" />
              </template>
              绑定
            </BaseButton>
          </div>
        </div>
      </div>

    </div>

    <ConfirmDialog
      :open="!!unlinkTarget"
      title="解除第三方绑定"
      :description="`确认解除 ${unlinkTarget === 'github' ? 'GitHub' : 'Google'} 账户的绑定？解除后将无法使用该账户登录。`"
      confirm-text="解绑"
      variant="danger"
      @update:open="(v: boolean) => { if (!v) unlinkTarget = null }"
      @confirm="confirmUnlink"
    />
  </div>
</template>
