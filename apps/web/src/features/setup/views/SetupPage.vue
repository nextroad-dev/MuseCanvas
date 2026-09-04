<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSetupStore } from '../stores/setup'
import { useAdminStore } from '@/features/admin/stores/admin'
import { useAuthStore } from '@/features/auth/stores/auth'
import type { ModelPreset, ModelAdapter, UserRole } from '@/shared/types'
import { api } from '@/shared/services/api'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
import Field from '@/shared/components/ui/Field.vue'
import SurfaceCard from '@/shared/components/ui/SurfaceCard.vue'

const router = useRouter()
const setup = useSetupStore()
const admin = useAdminStore()
const auth = useAuthStore()

const currentStep = ref(1)
const totalSteps = 5
const stepNames = ['管理员', '凭据', '模型', 'OAuth', '完成']

// Step 1: Admin setup
const adminEmail = ref('')
const adminCode = ref('')
const adminStep = ref<'email' | 'otp'>('email')
const adminError = ref('')
const adminLoading = ref(false)

// Step 2: Provider credentials
const creds = ref<{ displayName: string; adapter: ModelAdapter; apiKey: string; baseUrl: string; enabled: boolean }[]>([])
const newCred = ref({ displayName: '', adapter: 'openai' as ModelAdapter, apiKey: '', baseUrl: '', enabled: true })
const credError = ref('')
const credSaving = ref(false)
const adapterLabels: Record<ModelAdapter, string> = { openai: 'OpenAI 兼容', seedream: '火山引擎 Seedream', anthropic: 'Anthropic' }
const adapterPlaceholders: Record<ModelAdapter, string> = { openai: 'https://api.openai.com', seedream: 'https://ark.cn-beijing.volces.com', anthropic: 'https://api.anthropic.com' }

// Step 3: Models
const presets = ref<ModelPreset[]>([])
const selectedPresets = ref<Set<string>>(new Set())
const modelSaving = ref(false)
const modelError = ref('')

// Step 4: OAuth
const oauthGithub = ref({ clientId: '', clientSecret: '', enabled: false })
const oauthGoogle = ref({ clientId: '', clientSecret: '', enabled: false })
const oauthRedirects = ref<{ github: string; google: string }>({ github: '', google: '' })
const oauthSaving = ref(false)
const oauthError = ref('')

function oauthClientId(provider: 'github' | 'google') {
  return provider === 'github' ? oauthGithub.value.clientId : oauthGoogle.value.clientId
}

function setOauthClientId(provider: 'github' | 'google', value: string) {
  if (provider === 'github') oauthGithub.value.clientId = value
  else oauthGoogle.value.clientId = value
}

function oauthClientSecret(provider: 'github' | 'google') {
  return provider === 'github' ? oauthGithub.value.clientSecret : oauthGoogle.value.clientSecret
}

function setOauthClientSecret(provider: 'github' | 'google', value: string) {
  if (provider === 'github') oauthGithub.value.clientSecret = value
  else oauthGoogle.value.clientSecret = value
}

// Step 5: Complete
const summary = ref('')

async function handleRequestOtp() {
  adminError.value = ''
  adminLoading.value = true
  const res = await setup.requestAdminOtp(adminEmail.value.trim())
  adminLoading.value = false
  if (res.success) {
    adminStep.value = 'otp'
  } else {
    adminError.value = res.error?.message || '发送验证码失败'
  }
}

async function handleVerifyOtp() {
  adminError.value = ''
  adminLoading.value = true
  const res = await setup.verifyAdminOtp(adminEmail.value.trim(), adminCode.value)
  adminLoading.value = false
  if (res.success && res.data) {
    auth.user = { ...res.data.user, role: res.data.user.role as UserRole, status: 'active', createdAt: new Date().toISOString() }
    auth.initialized = true
    await next()
  } else {
    adminError.value = res.error?.message || '验证失败'
  }
}

function addCredential() {
  if (!newCred.value.displayName.trim()) {
    credError.value = '请输入凭据名称'
    return
  }
  if (!newCred.value.apiKey.trim()) {
    credError.value = '请输入 API Key'
    return
  }
  credError.value = ''
  creds.value.push({ ...newCred.value })
  newCred.value = { displayName: '', adapter: 'openai', apiKey: '', baseUrl: '', enabled: true }
}

function removeCredential(index: number) {
  creds.value.splice(index, 1)
}

async function saveCredentials() {
  credSaving.value = true
  for (const cred of creds.value) {
    await admin.createProviderCredential({
      displayName: cred.displayName,
      adapter: cred.adapter,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl || undefined,
      enabled: cred.enabled,
    })
  }
  credSaving.value = false
  await next()
}

async function loadPresets() {
  const res = await api<ModelPreset[]>('/api/admin/model-presets')
  if (res.success && res.data) {
    presets.value = res.data
  }
}

function togglePreset(id: string) {
  if (selectedPresets.value.has(id)) {
    selectedPresets.value.delete(id)
  } else {
    selectedPresets.value.add(id)
  }
}

async function saveModels() {
  modelSaving.value = true
  modelError.value = ''
  const selected = presets.value.filter((p) => selectedPresets.value.has(p.id))

  for (const preset of selected) {
    const matchedCred = admin.providerCredentials.find((c) => c.adapter === preset.adapter && c.enabled)
    const data: Record<string, unknown> = {
      presetId: preset.id,
      concurrencyLimit: preset.concurrencyLimit,
      sortOrder: 0,
    }
    if (matchedCred) data.providerCredentialId = matchedCred.id
    if (preset.modelKind === 'image') data.watermark = preset.watermark ?? false
    else data.reasoningEffort = preset.reasoningEffort || 'medium'

    const res = await admin.createModel(data)
    if (!res.success) {
      modelError.value = `${preset.displayName}: ${res.error?.message || '创建失败'}`
      break
    }
  }
  modelSaving.value = false
  await next()
}

async function saveOAuth() {
  oauthSaving.value = true
  oauthError.value = ''
  if (oauthGithub.value.clientId || oauthGithub.value.clientSecret) {
    await admin.updateOAuthProvider('github', {
      clientId: oauthGithub.value.clientId || undefined,
      clientSecret: oauthGithub.value.clientSecret || undefined,
      enabled: oauthGithub.value.enabled,
    })
  }
  if (oauthGoogle.value.clientId || oauthGoogle.value.clientSecret) {
    await admin.updateOAuthProvider('google', {
      clientId: oauthGoogle.value.clientId || undefined,
      clientSecret: oauthGoogle.value.clientSecret || undefined,
      enabled: oauthGoogle.value.enabled,
    })
  }
  oauthSaving.value = false
  await next()
}

async function next() {
  if (currentStep.value < totalSteps) {
    currentStep.value++
    if (currentStep.value === 3) {
      await admin.fetchProviderCredentials()
      await loadPresets()
    }
    if (currentStep.value === 4) {
      await admin.fetchOAuthProviders()
      const g = admin.oauthProviders.find((p) => p.provider === 'github')
      const gg = admin.oauthProviders.find((p) => p.provider === 'google')
      if (g) {
        oauthRedirects.value.github = g.redirectUri
        oauthGithub.value = { clientId: g.clientId || '', clientSecret: '', enabled: g.enabled }
      }
      if (gg) {
        oauthRedirects.value.google = gg.redirectUri
        oauthGoogle.value = { clientId: gg.clientId || '', clientSecret: '', enabled: gg.enabled }
      }
    }
    if (currentStep.value === 5) {
      const parts: string[] = []
      if (creds.value.length > 0) parts.push(`已配置 ${creds.value.length} 个供应商凭据`)
      if (selectedPresets.value.size > 0) parts.push(`已创建 ${selectedPresets.value.size} 个模型`)
      if (oauthGithub.value.enabled || oauthGoogle.value.enabled) parts.push('已配置 OAuth 登录')
      summary.value = parts.length > 0 ? parts.join('；') : '已跳过所有可选步骤，可在管理后台随时补充配置'
    }
  }
}

function goToApp() {
  void router.push(auth.isAdmin ? '/admin' : '/generate')
}

onMounted(async () => {
  await setup.checkStatus()
  if (setup.setupComplete) {
    void router.push('/login')
  }
})
</script>

<template>
  <div class="flex min-h-screen flex-col items-center justify-center bg-canvas p-4 text-foreground">
    <div class="w-full max-w-2xl">
      <!-- Header -->
      <div class="mb-8 text-center">
        <h1 class="mb-2 text-3xl font-bold text-foreground">MuseCanvas 初始化</h1>
        <p class="text-muted-foreground">完成以下步骤即可开始使用</p>
      </div>

      <!-- Step indicator -->
      <div class="mb-10 flex items-center justify-center gap-2">
        <template v-for="(name, i) in stepNames" :key="i">
          <div class="flex items-center">
            <div
              :class="[
                'flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors',
                i + 1 === currentStep
                  ? 'bg-primary text-primary-foreground'
                  : i + 1 < currentStep
                    ? 'bg-success text-white'
                    : 'bg-surface-subtle text-muted-foreground',
              ]"
            >
              {{ i + 1 < currentStep ? '✓' : i + 1 }}
            </div>
            <span
              :class="[
                'ml-2 hidden text-sm sm:inline',
                i + 1 === currentStep ? 'font-medium text-foreground' : 'text-muted-foreground',
              ]"
            >
              {{ name }}
            </span>
          </div>
          <div v-if="i < stepNames.length - 1" class="mx-1 h-px w-8 bg-border" />
        </template>
      </div>

      <!-- Step content -->
      <SurfaceCard padding="lg">
        <!-- Step 1: Admin -->
        <div v-if="currentStep === 1">
          <h2 class="mb-2 text-xl font-semibold text-foreground">设置管理员账号</h2>
          <p class="mb-6 text-sm text-muted-foreground">输入你的邮箱，系统将发送验证码以创建管理员账号</p>

          <div v-if="adminStep === 'email'">
            <Field label="管理员邮箱" :error="adminError || undefined">
              <TextInput
                v-model="adminEmail"
                type="email"
                placeholder="admin@example.com"
                :invalid="!!adminError"
                @keyup.enter="handleRequestOtp"
              />
            </Field>
            <BaseButton
              :loading="adminLoading"
              :disabled="!adminEmail.trim()"
              class="mt-4 w-full"
              @click="handleRequestOtp"
            >
              {{ adminLoading ? '发送中...' : '发送验证码' }}
            </BaseButton>
          </div>

          <div v-else>
            <p class="mb-4 text-sm text-muted-foreground">验证码已发送至 <strong class="text-foreground">{{ adminEmail }}</strong></p>
            <Field label="验证码" :error="adminError || undefined">
              <TextInput
                v-model="adminCode"
                type="text"
                inputmode="numeric"
                maxlength="6"
                placeholder="输入 6 位验证码"
                class="text-center tracking-widest"
                :invalid="!!adminError"
                @keyup.enter="handleVerifyOtp"
              />
            </Field>
            <BaseButton
              :loading="adminLoading"
              :disabled="adminCode.length !== 6"
              class="mt-4 w-full"
              @click="handleVerifyOtp"
            >
              {{ adminLoading ? '验证中...' : '验证并创建管理员' }}
            </BaseButton>
            <BaseButton variant="ghost" class="mt-2 w-full" @click="adminStep = 'email'">
              更换邮箱
            </BaseButton>
          </div>
        </div>

        <!-- Step 2: Provider Credentials -->
        <div v-if="currentStep === 2">
          <h2 class="mb-2 text-xl font-semibold text-foreground">配置供应商凭据</h2>
          <p class="mb-6 text-sm text-muted-foreground">添加图像生成或语言模型的 API 凭据。可在管理后台随时补充。</p>

          <!-- Existing credentials list -->
          <div v-if="creds.length > 0" class="mb-4 space-y-2">
            <div v-for="(cred, i) in creds" :key="i" class="flex items-center justify-between rounded-[var(--radius-control)] border border-border bg-surface-subtle px-4 py-3">
              <div>
                <span class="font-medium text-foreground">{{ cred.displayName }}</span>
                <span class="ml-2 text-sm text-muted-foreground">{{ adapterLabels[cred.adapter] }}</span>
              </div>
              <BaseButton variant="danger-ghost" size="sm" @click="removeCredential(i)">删除</BaseButton>
            </div>
          </div>

          <!-- Add new credential form -->
          <div class="space-y-3">
            <Field label="凭据名称">
              <TextInput v-model="newCred.displayName" placeholder="凭据名称" />
            </Field>
            <Field label="适配器">
              <select
                v-model="newCred.adapter"
                class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="openai">OpenAI 兼容</option>
                <option value="seedream">火山引擎 Seedream</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </Field>
            <Field label="API Key">
              <TextInput v-model="newCred.apiKey" type="password" placeholder="API Key" />
            </Field>
            <Field label="Base URL" hint="可选，不填则使用默认地址">
              <TextInput v-model="newCred.baseUrl" type="url" :placeholder="adapterPlaceholders[newCred.adapter] + '（可选）'" />
            </Field>
            <p v-if="credError" class="text-sm text-danger">{{ credError }}</p>
            <BaseButton variant="secondary" class="w-full" @click="addCredential">
              + 添加凭据
            </BaseButton>
          </div>

          <div class="mt-6 flex gap-3">
            <BaseButton variant="secondary" class="flex-1" @click="next">
              跳过
            </BaseButton>
            <BaseButton
              :loading="credSaving"
              :disabled="creds.length === 0"
              class="flex-1"
              @click="saveCredentials"
            >
              {{ credSaving ? '保存中...' : '保存并继续' }}
            </BaseButton>
          </div>
        </div>

        <!-- Step 3: Models -->
        <div v-if="currentStep === 3">
          <h2 class="mb-2 text-xl font-semibold text-foreground">创建模型</h2>
          <p class="mb-6 text-sm text-muted-foreground">选择需要启用的模型预设，系统将自动关联已配置的凭据。</p>

          <div v-if="presets.length === 0" class="py-8 text-center text-muted-foreground">
            加载预设中...
          </div>

          <div v-else class="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div
              v-for="preset in presets"
              :key="preset.id"
              :class="[
                'cursor-pointer rounded-[var(--radius-card)] border p-4 transition-colors',
                selectedPresets.has(preset.id)
                  ? 'border-primary bg-primary-soft'
                  : 'border-border bg-surface-subtle hover:border-border-strong',
              ]"
              @click="togglePreset(preset.id)"
            >
              <div class="flex items-start justify-between">
                <div>
                  <h3 class="font-medium text-foreground">{{ preset.displayName }}</h3>
                  <p class="mt-1 text-xs text-muted-foreground">{{ adapterLabels[preset.adapter] }} · {{ preset.modelKind === 'image' ? '图像' : '语言' }}</p>
                </div>
                <div
                  :class="[
                    'mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border-2',
                    selectedPresets.has(preset.id) ? 'border-primary bg-primary' : 'border-border-strong',
                  ]"
                >
                  <span v-if="selectedPresets.has(preset.id)" class="text-xs text-primary-foreground">✓</span>
                </div>
              </div>
              <p class="mt-2 text-xs text-muted-foreground">{{ preset.vendorModelId }}</p>
            </div>
          </div>

          <p v-if="modelError" class="mb-4 text-sm text-danger">{{ modelError }}</p>

          <div class="flex gap-3">
            <BaseButton variant="secondary" class="flex-1" @click="next">
              跳过
            </BaseButton>
            <BaseButton
              :loading="modelSaving"
              :disabled="selectedPresets.size === 0"
              class="flex-1"
              @click="saveModels"
            >
              {{ modelSaving ? '创建中...' : '创建并继续' }}
            </BaseButton>
          </div>
        </div>

        <!-- Step 4: OAuth -->
        <div v-if="currentStep === 4">
          <h2 class="mb-2 text-xl font-semibold text-foreground">配置 OAuth 登录</h2>
          <p class="mb-6 text-sm text-muted-foreground">可选。配置 GitHub 或 Google 登录，让用户可以使用第三方账号登录。</p>

          <div v-for="provider in (['github', 'google'] as const)" :key="provider" class="mb-6 last:mb-0">
            <h3 class="mb-2 font-medium text-foreground">{{ provider === 'github' ? 'GitHub' : 'Google' }} 登录</h3>
            <div class="mb-3 rounded-[var(--radius-control)] border border-border bg-surface-subtle p-3">
              <p class="mb-1 text-xs text-muted-foreground">回调地址（需在 {{ provider === 'github' ? 'GitHub' : 'Google' }} 开发者控制台配置）</p>
              <code class="break-all text-sm text-primary">{{ oauthRedirects[provider] || '加载中...' }}</code>
            </div>
            <Field label="Client ID">
              <TextInput
                :model-value="oauthClientId(provider)"
                placeholder="Client ID"
                @update:model-value="setOauthClientId(provider, $event)"
              />
            </Field>
            <Field label="Client Secret" hint="留空不修改" class="mt-2">
              <TextInput
                :model-value="oauthClientSecret(provider)"
                type="password"
                placeholder="Client Secret（留空不修改）"
                @update:model-value="setOauthClientSecret(provider, $event)"
              />
            </Field>
          </div>

          <p v-if="oauthError" class="mb-4 text-sm text-danger">{{ oauthError }}</p>

          <div class="mt-6 flex gap-3">
            <BaseButton variant="secondary" class="flex-1" @click="next">
              跳过
            </BaseButton>
            <BaseButton
              :loading="oauthSaving"
              class="flex-1"
              @click="saveOAuth"
            >
              {{ oauthSaving ? '保存中...' : '保存并继续' }}
            </BaseButton>
          </div>
        </div>

        <!-- Step 5: Complete -->
        <div v-if="currentStep === 5">
          <div class="py-8 text-center">
            <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-success-soft">
              <span class="text-3xl text-success">✓</span>
            </div>
            <h2 class="mb-2 text-xl font-semibold text-foreground">初始化完成</h2>
            <p class="mb-4 text-muted-foreground">{{ summary }}</p>
            <BaseButton size="lg" class="px-8" @click="goToApp">
              开始创作
            </BaseButton>
          </div>
        </div>
      </SurfaceCard>
    </div>
  </div>
</template>
