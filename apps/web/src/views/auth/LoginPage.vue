<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { Github } from 'lucide-vue-next'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

type Step = 'email' | 'invitation' | 'otp' | 'oauth_invitation'
const step = ref<Step>('email')
const email = ref('')
const otpCode = ref('')
const invitationCode = ref('')
const loading = ref(false)
const error = ref('')

// OAuth invitation challenge (invite-only registration via a third-party login).
const oauthChallengeId = ref('')
const oauthProvider = ref('')

// Maps server error codes (?error=) to user-facing Chinese copy.
const OAUTH_ERROR_LABELS: Record<string, string> = {
  OAUTH_PROVIDER_DISABLED: '该第三方登录未启用',
  OAUTH_DENIED: '已取消第三方授权',
  OAUTH_INVALID_CALLBACK: '第三方登录回调无效，请重试',
  OAUTH_STATE_EXPIRED: '登录会话已过期，请重试',
  OAUTH_STATE_FAILED: '登录服务暂时不可用，请稍后再试',
  OAUTH_EXCHANGE_FAILED: '第三方登录失败，请重试',
  OAUTH_PROFILE_FAILED: '无法获取第三方账户信息，请重试',
  OAUTH_EMAIL_UNAVAILABLE: '第三方账户缺少可用邮箱',
  OAUTH_EMAIL_UNVERIFIED: '第三方账户邮箱未验证，无法登录',
  OAUTH_ACCOUNT_UNAVAILABLE: '账户当前不可用',
  OAUTH_IDENTITY_CONFLICT: '该第三方账户已绑定其他用户',
}

function oauthEnabled(provider: 'github' | 'google') {
  return auth.oauthProviders.some((p) => p.provider === provider && p.enabled)
}

onMounted(async () => {
  await auth.fetchOAuthProviders()
  const errCode = typeof route.query.error === 'string' ? route.query.error : ''
  if (errCode) error.value = OAUTH_ERROR_LABELS[errCode] || '登录失败，请重试'
  // Invite-only third-party registration: collect an invitation code for the
  // already-verified third-party email.
  const challenge = typeof route.query.oauth_challenge === 'string' ? route.query.oauth_challenge : ''
  if (challenge) {
    oauthChallengeId.value = challenge
    email.value = typeof route.query.email === 'string' ? route.query.email : ''
    oauthProvider.value = typeof route.query.provider === 'string' ? route.query.provider : ''
    step.value = 'oauth_invitation'
  }
})

async function handleOAuthInvitation() {
  if (!invitationCode.value.trim()) {
    error.value = '请输入邀请码'
    return
  }
  error.value = ''
  loading.value = true
  const res = await auth.completeOAuthInvitation(oauthChallengeId.value, invitationCode.value.trim())
  loading.value = false
  if (res.success) {
    router.push(auth.isAdmin ? '/admin' : '/generate')
  } else {
    error.value = res.error?.message || '注册失败，请重试'
  }
}

async function handleSendOtp() {
  if (!email.value.trim()) return
  error.value = ''
  loading.value = true

  const res = await auth.requestOtp(email.value.trim())
  loading.value = false

  if (res.success && res.data) {
    step.value = res.data.nextStep
  } else {
    error.value = res.error?.message || '发送失败，请重试'
  }
}

async function handleInvitationOtp() {
  if (!invitationCode.value.trim()) {
    error.value = '请输入邀请码'
    return
  }
  error.value = ''
  loading.value = true
  const res = await auth.requestOtp(email.value.trim(), invitationCode.value.trim())
  loading.value = false
  if (res.success && res.data?.nextStep === 'otp') {
    step.value = 'otp'
  } else {
    error.value = res.error?.message || '发送失败，请重试'
  }
}

function backToEmail() {
  step.value = 'email'
  otpCode.value = ''
  invitationCode.value = ''
  error.value = ''
}

async function handleVerify() {
  if (!otpCode.value.trim()) return
  error.value = ''
  loading.value = true

  const res = await auth.verifyOtp(email.value.trim(), otpCode.value.trim(), invitationCode.value || undefined)
  loading.value = false

  if (res.success) {
    router.push(auth.isAdmin ? '/admin' : '/generate')
  } else {
    error.value = res.error?.message || '验证失败，请重试'
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
    <div class="w-full max-w-sm">
      <!-- Brand -->
      <div class="mb-8 text-center">
        <h1 class="text-lg font-semibold text-neutral-900">MuseCanvas</h1>
        <p class="mt-1 text-sm text-neutral-500">AI 图像生成平台</p>
      </div>

      <!-- Form card -->
      <div class="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
        <!-- Step: Email -->
        <template v-if="step === 'email'">
          <div class="mb-4">
            <label class="mb-1.5 block text-xs font-medium text-neutral-700">邮箱地址</label>
            <input
              v-model="email"
              type="email"
              placeholder="your@email.com"
              class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              @keydown.enter="handleSendOtp"
            />
          </div>

          <div v-if="error" class="mb-3 text-xs text-danger">{{ error }}</div>

          <button
            :disabled="loading || !email.trim()"
            class="flex h-10 w-full items-center justify-center rounded-lg bg-primary text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            @click="handleSendOtp"
          >
            {{ loading ? '处理中...' : '继续' }}
          </button>

          <!-- Third-party login (hidden when no provider is configured) -->
          <template v-if="oauthEnabled('github') || oauthEnabled('google')">
            <div class="my-4 flex items-center gap-3">
              <div class="h-px flex-1 bg-neutral-200" />
              <span class="text-xs text-neutral-400">或</span>
              <div class="h-px flex-1 bg-neutral-200" />
            </div>
            <div class="space-y-2">
              <button
                v-if="oauthEnabled('github')"
                type="button"
                class="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-neutral-200 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                @click="auth.startOAuth('github')"
              >
                <Github class="h-4 w-4" />
                使用 GitHub 继续
              </button>
              <button
                v-if="oauthEnabled('google')"
                type="button"
                class="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-neutral-200 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                @click="auth.startOAuth('google')"
              >
                <svg class="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"/></svg>
                使用 Google 继续
              </button>
            </div>
          </template>
        </template>

        <!-- Step: OAuth invitation (invite-only third-party registration) -->
        <template v-else-if="step === 'oauth_invitation'">
          <div class="mb-4">
            <p class="text-sm font-medium text-neutral-900">完成注册</p>
            <p class="mt-1 text-xs text-neutral-500">
              已通过{{ oauthProvider === 'github' ? ' GitHub ' : oauthProvider === 'google' ? ' Google ' : '第三方' }}验证邮箱
              <span class="font-medium text-neutral-700">{{ email }}</span>，当前为邀请注册模式，请输入邀请码。
            </p>
          </div>
          <div class="mb-4">
            <label class="mb-1.5 block text-xs font-medium text-neutral-700">邀请码</label>
            <input
              v-model="invitationCode"
              type="text"
              placeholder="输入与邮箱绑定的邀请码"
              class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              @keydown.enter="handleOAuthInvitation"
            />
          </div>
          <div v-if="error" class="mb-3 text-xs text-danger">{{ error }}</div>
          <button
            :disabled="loading || !invitationCode.trim()"
            class="flex h-10 w-full items-center justify-center rounded-lg bg-primary text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            @click="handleOAuthInvitation"
          >
            {{ loading ? '注册中...' : '完成注册并登录' }}
          </button>
          <button class="mt-3 w-full text-center text-xs text-neutral-500 hover:text-neutral-700" @click="backToEmail">
            使用邮箱登录
          </button>
        </template>

        <!-- Step: Invitation -->
        <template v-else-if="step === 'invitation'">
          <div class="mb-4">
            <p class="text-sm font-medium text-neutral-900">新用户注册</p>
            <p class="mt-1 text-xs text-neutral-500">
              <span class="font-medium text-neutral-700">{{ email }}</span> 尚未注册，请先填写邀请码。
            </p>
          </div>

          <div class="mb-4">
            <label class="mb-1.5 block text-xs font-medium text-neutral-700">邀请码</label>
            <input
              v-model="invitationCode"
              type="text"
              placeholder="输入与邮箱绑定的邀请码"
              class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              @keydown.enter="handleInvitationOtp"
            />
          </div>

          <div v-if="error" class="mb-3 text-xs text-danger">{{ error }}</div>

          <button
            :disabled="loading || !invitationCode.trim()"
            class="flex h-10 w-full items-center justify-center rounded-lg bg-primary text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            @click="handleInvitationOtp"
          >
            {{ loading ? '发送中...' : '验证邀请码并发送验证码' }}
          </button>

          <button class="mt-3 w-full text-center text-xs text-neutral-500 hover:text-neutral-700" @click="backToEmail">
            返回修改邮箱
          </button>
        </template>

        <!-- Step: OTP -->
        <template v-else>
          <div class="mb-1 text-xs text-neutral-500">
            验证码已发送至 <span class="font-medium text-neutral-700">{{ email }}</span>
          </div>

          <div class="mb-4 mt-3">
            <label class="mb-1.5 block text-xs font-medium text-neutral-700">验证码</label>
            <input
              v-model="otpCode"
              type="text"
              inputmode="numeric"
              maxlength="6"
              placeholder="6 位验证码"
              class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-center text-sm tracking-widest text-neutral-900 placeholder:text-neutral-400 transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              @keydown.enter="handleVerify"
            />
          </div>

          <div v-if="error" class="mb-3 text-xs text-danger">{{ error }}</div>

          <button
            :disabled="loading || otpCode.trim().length < 4"
            class="flex h-10 w-full items-center justify-center rounded-lg bg-primary text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            @click="handleVerify"
          >
            {{ loading ? '验证中...' : '登录 / 注册' }}
          </button>

          <button
            class="mt-3 w-full text-center text-xs text-neutral-500 hover:text-neutral-700"
            @click="backToEmail"
          >
            返回修改邮箱
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
