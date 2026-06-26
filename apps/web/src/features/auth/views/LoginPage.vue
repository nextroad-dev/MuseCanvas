<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth'
import { Github } from 'lucide-vue-next'
import SurfaceCard from '@/shared/components/ui/SurfaceCard.vue'
import GoogleIcon from '@/shared/components/ui/GoogleIcon.vue'

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
  <div class="flex min-h-screen items-center justify-center bg-canvas px-4">
    <h1 class="sr-only">登录</h1>
    <div class="w-full max-w-sm">
      <!-- Brand -->
      <div class="mb-8 flex flex-col items-center text-center">
        <img src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/01_primary_logo_transparent_trimmed.png" alt="MuseCanvas" class="h-16 w-auto" />
        <p class="mt-2 text-sm text-muted-foreground">AI 图像生成平台</p>
      </div>

      <!-- Form card -->
      <SurfaceCard>
        <!-- Step: Email -->
        <template v-if="step === 'email'">
          <div class="mb-4">
            <label class="mb-1.5 block text-xs font-medium text-foreground">邮箱地址</label>
            <input
              v-model="email"
              type="email"
              placeholder="your@email.com"
              class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              @keydown.enter="handleSendOtp"
            />
          </div>

          <div v-if="error" class="mb-3 text-xs text-danger">{{ error }}</div>

          <button
            :disabled="loading || !email.trim()"
            class="flex h-10 w-full items-center justify-center rounded-[var(--radius-control)] bg-primary text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            @click="handleSendOtp"
          >
            {{ loading ? '处理中...' : '继续' }}
          </button>

          <p class="mt-3 text-center text-xs text-muted-foreground">
            继续即表示你同意
            <RouterLink to="/terms" class="text-primary underline-offset-2 hover:underline">《用户协议》</RouterLink>
            和
            <RouterLink to="/privacy" class="text-primary underline-offset-2 hover:underline">《隐私政策》</RouterLink>
          </p>

          <!-- Third-party login (hidden when no provider is configured) -->
          <template v-if="oauthEnabled('github') || oauthEnabled('google')">
            <div class="my-4 flex items-center gap-3">
              <div class="h-px flex-1 bg-border" />
              <span class="text-xs text-muted-foreground">或</span>
              <div class="h-px flex-1 bg-border" />
            </div>
            <div class="space-y-2">
              <button
                v-if="oauthEnabled('github')"
                type="button"
                class="flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                @click="auth.startOAuth('github')"
              >
                <Github class="h-4 w-4" />
                使用 GitHub 继续
              </button>
              <button
                v-if="oauthEnabled('google')"
                type="button"
                class="flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                @click="auth.startOAuth('google')"
              >
                <GoogleIcon class="h-4 w-4" />
                使用 Google 继续
              </button>
            </div>
          </template>
        </template>

        <!-- Step: OAuth invitation (invite-only third-party registration) -->
        <template v-else-if="step === 'oauth_invitation'">
          <div class="mb-4">
            <p class="text-sm font-medium text-foreground">完成注册</p>
            <p class="mt-1 text-xs text-muted-foreground">
              已通过{{ oauthProvider === 'github' ? ' GitHub ' : oauthProvider === 'google' ? ' Google ' : '第三方' }}验证邮箱
              <span class="font-medium text-foreground">{{ email }}</span>，当前为邀请注册模式，请输入邀请码。
            </p>
          </div>
          <div class="mb-4">
            <label class="mb-1.5 block text-xs font-medium text-foreground">邀请码</label>
            <input
              v-model="invitationCode"
              type="text"
              placeholder="输入与邮箱绑定的邀请码"
              class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              @keydown.enter="handleOAuthInvitation"
            />
          </div>
          <div v-if="error" class="mb-3 text-xs text-danger">{{ error }}</div>
          <button
            :disabled="loading || !invitationCode.trim()"
            class="flex h-10 w-full items-center justify-center rounded-[var(--radius-control)] bg-primary text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            @click="handleOAuthInvitation"
          >
            {{ loading ? '注册中...' : '完成注册并登录' }}
          </button>
          <button class="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground" @click="backToEmail">
            使用邮箱登录
          </button>
        </template>

        <!-- Step: Invitation -->
        <template v-else-if="step === 'invitation'">
          <div class="mb-4">
            <p class="text-sm font-medium text-foreground">新用户注册</p>
            <p class="mt-1 text-xs text-muted-foreground">
              <span class="font-medium text-foreground">{{ email }}</span> 尚未注册，请先填写邀请码。
            </p>
          </div>

          <div class="mb-4">
            <label class="mb-1.5 block text-xs font-medium text-foreground">邀请码</label>
            <input
              v-model="invitationCode"
              type="text"
              placeholder="输入与邮箱绑定的邀请码"
              class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              @keydown.enter="handleInvitationOtp"
            />
          </div>

          <div v-if="error" class="mb-3 text-xs text-danger">{{ error }}</div>

          <button
            :disabled="loading || !invitationCode.trim()"
            class="flex h-10 w-full items-center justify-center rounded-[var(--radius-control)] bg-primary text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            @click="handleInvitationOtp"
          >
            {{ loading ? '发送中...' : '验证邀请码并发送验证码' }}
          </button>

          <button class="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground" @click="backToEmail">
            返回修改邮箱
          </button>
        </template>

        <!-- Step: OTP -->
        <template v-else>
          <div class="mb-1 text-xs text-muted-foreground">
            验证码已发送至 <span class="font-medium text-foreground">{{ email }}</span>
          </div>

          <div class="mb-4 mt-3">
            <label class="mb-1.5 block text-xs font-medium text-foreground">验证码</label>
            <input
              v-model="otpCode"
              type="text"
              inputmode="numeric"
              maxlength="6"
              placeholder="6 位验证码"
              class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-center text-sm tracking-widest text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              @keydown.enter="handleVerify"
            />
          </div>

          <div v-if="error" class="mb-3 text-xs text-danger">{{ error }}</div>

          <button
            :disabled="loading || otpCode.trim().length < 4"
            class="flex h-10 w-full items-center justify-center rounded-[var(--radius-control)] bg-primary text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            @click="handleVerify"
          >
            {{ loading ? '验证中...' : '登录 / 注册' }}
          </button>

          <button
            class="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground"
            @click="backToEmail"
          >
            返回修改邮箱
          </button>
        </template>
      </SurfaceCard>
    </div>
  </div>
</template>
