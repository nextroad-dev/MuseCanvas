<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useAccountStore } from '@/stores/account'
import { LogOut, Github, Link2, Unlink, CheckCircle, AlertCircle } from 'lucide-vue-next'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'

const auth = useAuthStore()
const account = useAccountStore()
const router = useRouter()
const route = useRoute()

const user = computed(() => auth.user)
const unlinkTarget = ref<'github' | 'google' | null>(null)
const alert = ref<{ kind: 'success' | 'error'; text: string } | null>(null)
let alertTimer: ReturnType<typeof setTimeout> | undefined

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

function showAlert(kind: 'success' | 'error', text: string) {
  alert.value = { kind, text }
  if (alertTimer) clearTimeout(alertTimer)
  alertTimer = setTimeout(() => (alert.value = null), 5000)
}

function isLinked(provider: 'github' | 'google') {
  return account.oauthIdentities.some((i) => i.provider === provider)
}
function providerEnabled(provider: 'github' | 'google') {
  return auth.oauthProviders.some((p) => p.provider === provider && p.enabled)
}

onMounted(async () => {
  await Promise.all([account.fetchOAuthIdentities(), auth.fetchOAuthProviders()])
  // The link callback redirects here with ?linked=1 or ?error=CODE.
  if (route.query.linked) {
    showAlert('success', '第三方账户已绑定')
    router.replace({ query: {} })
  } else if (typeof route.query.error === 'string') {
    showAlert('error', OAUTH_ERROR_LABELS[route.query.error] || '绑定失败，请重试')
    router.replace({ query: {} })
  }
})

async function confirmUnlink() {
  const provider = unlinkTarget.value
  if (!provider) return
  const res = await account.unlinkOAuth(provider)
  unlinkTarget.value = null
  if (res.success) showAlert('success', '已解除绑定')
  else showAlert('error', res.error?.message || '解除绑定失败')
}

async function handleLogout() {
  await auth.logout()
  router.push('/login')
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}
</script>

<template>
  <div class="flex h-full w-full justify-center overflow-auto p-6">
    <div class="w-full max-w-md">
      <h2 class="mb-6 text-sm font-semibold text-neutral-900">账户信息</h2>

      <!-- Inline alert -->
      <div
        v-if="alert"
        :class="[
          'mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
          alert.kind === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700',
        ]"
        role="status"
      >
        <CheckCircle v-if="alert.kind === 'success'" class="h-4 w-4 shrink-0" />
        <AlertCircle v-else class="h-4 w-4 shrink-0" />
        {{ alert.text }}
      </div>

      <div class="space-y-4">
        <div>
          <label class="mb-1 block text-xs text-neutral-500">邮箱</label>
          <p class="text-sm font-medium text-neutral-900">{{ user?.email }}</p>
        </div>

        <div>
          <label class="mb-1 block text-xs text-neutral-500">角色</label>
          <p class="text-sm font-medium text-neutral-900">{{ user?.role === 'admin' ? '管理员' : '用户' }}</p>
        </div>

        <div>
          <label class="mb-1 block text-xs text-neutral-500">注册时间</label>
          <p class="text-sm text-neutral-700">{{ user?.createdAt ? formatDate(user.createdAt) : '-' }}</p>
        </div>

        <!-- Third-party accounts -->
        <div class="pt-4 border-t border-neutral-200">
          <h3 class="mb-1 text-xs font-medium text-neutral-700">第三方账户</h3>
          <p class="mb-3 text-xs text-neutral-400">绑定后可使用第三方账户快速登录；仅可绑定与当前邮箱一致的账户。</p>

          <div class="space-y-2">
            <div
              v-for="p in PROVIDERS"
              :key="p.provider"
              class="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2.5"
            >
              <div class="flex items-center gap-2.5">
                <Github v-if="p.provider === 'github'" class="h-4 w-4 text-neutral-700" />
                <svg v-else class="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"/></svg>
                <div>
                  <p class="text-sm font-medium text-neutral-900">{{ p.label }}</p>
                  <p class="text-xs text-neutral-400">{{ isLinked(p.provider) ? '已绑定' : providerEnabled(p.provider) ? '未绑定' : '未启用' }}</p>
                </div>
              </div>

              <button
                v-if="isLinked(p.provider)"
                class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 px-3 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50"
                @click="unlinkTarget = p.provider"
              >
                <Unlink class="h-3.5 w-3.5" />
                解绑
              </button>
              <button
                v-else
                :disabled="!providerEnabled(p.provider)"
                class="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
                @click="account.linkOAuth(p.provider)"
              >
                <Link2 class="h-3.5 w-3.5" />
                绑定
              </button>
            </div>
          </div>
        </div>

        <div class="pt-4 border-t border-neutral-200">
          <button
            class="inline-flex h-9 items-center gap-2 rounded-lg border border-red-200 px-4 text-sm font-medium text-danger transition-colors hover:bg-red-50"
            @click="handleLogout"
          >
            <LogOut class="h-4 w-4" />
            退出登录
          </button>
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
