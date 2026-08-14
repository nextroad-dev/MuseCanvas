<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSetupStore } from '../stores/setup'
import { useAdminStore } from '@/features/admin/stores/admin'
import { useAuthStore } from '@/features/auth/stores/auth'
import type { ModelPreset, ModelAdapter, UserRole } from '@/shared/types'
import { api } from '@/shared/services/api'

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
  <div class="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-950 flex flex-col items-center justify-center p-4">
    <div class="w-full max-w-2xl">
      <!-- Header -->
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold text-white mb-2">MuseCanvas 初始化</h1>
        <p class="text-slate-400">完成以下步骤即可开始使用</p>
      </div>

      <!-- Step indicator -->
      <div class="flex items-center justify-center gap-2 mb-10">
        <template v-for="(name, i) in stepNames" :key="i">
          <div class="flex items-center">
            <div
              :class="[
                'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors',
                i + 1 === currentStep
                  ? 'bg-purple-600 text-white'
                  : i + 1 < currentStep
                    ? 'bg-green-600 text-white'
                    : 'bg-slate-700 text-slate-400',
              ]"
            >
              {{ i + 1 < currentStep ? '✓' : i + 1 }}
            </div>
            <span
              :class="[
                'ml-2 text-sm hidden sm:inline',
                i + 1 === currentStep ? 'text-purple-300' : 'text-slate-500',
              ]"
            >
              {{ name }}
            </span>
          </div>
          <div v-if="i < stepNames.length - 1" class="w-8 h-px bg-slate-700 mx-1" />
        </template>
      </div>

      <!-- Step content -->
      <div class="bg-slate-900/80 backdrop-blur-sm rounded-xl border border-slate-800 p-8 shadow-2xl">
        <!-- Step 1: Admin -->
        <div v-if="currentStep === 1">
          <h2 class="text-xl font-semibold text-white mb-2">设置管理员账号</h2>
          <p class="text-slate-400 text-sm mb-6">输入你的邮箱，系统将发送验证码以创建管理员账号</p>

          <div v-if="adminStep === 'email'">
            <input
              v-model="adminEmail"
              type="email"
              placeholder="admin@example.com"
              class="w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500 mb-4"
              @keyup.enter="handleRequestOtp"
            />
            <p v-if="adminError" class="text-red-400 text-sm mb-4">{{ adminError }}</p>
            <button
              :disabled="adminLoading || !adminEmail.trim()"
              class="w-full py-3 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors"
              @click="handleRequestOtp"
            >
              {{ adminLoading ? '发送中...' : '发送验证码' }}
            </button>
          </div>

          <div v-else>
            <p class="text-slate-300 text-sm mb-2">验证码已发送至 <strong>{{ adminEmail }}</strong></p>
            <input
              v-model="adminCode"
              type="text"
              maxlength="6"
              placeholder="输入 6 位验证码"
              class="w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500 mb-4 text-center text-2xl tracking-widest"
              @keyup.enter="handleVerifyOtp"
            />
            <p v-if="adminError" class="text-red-400 text-sm mb-4">{{ adminError }}</p>
            <button
              :disabled="adminLoading || adminCode.length !== 6"
              class="w-full py-3 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors"
              @click="handleVerifyOtp"
            >
              {{ adminLoading ? '验证中...' : '验证并创建管理员' }}
            </button>
            <button class="w-full mt-2 py-2 text-sm text-slate-400 hover:text-white transition-colors" @click="adminStep = 'email'">
              更换邮箱
            </button>
          </div>
        </div>

        <!-- Step 2: Provider Credentials -->
        <div v-if="currentStep === 2">
          <h2 class="text-xl font-semibold text-white mb-2">配置供应商凭据</h2>
          <p class="text-slate-400 text-sm mb-6">添加图像生成或语言模型的 API 凭据。可在管理后台随时补充。</p>

          <!-- Existing credentials list -->
          <div v-if="creds.length > 0" class="mb-4 space-y-2">
            <div v-for="(cred, i) in creds" :key="i" class="flex items-center justify-between bg-slate-800 rounded-lg px-4 py-3">
              <div>
                <span class="text-white font-medium">{{ cred.displayName }}</span>
                <span class="text-slate-400 text-sm ml-2">{{ adapterLabels[cred.adapter] }}</span>
              </div>
              <button class="text-red-400 hover:text-red-300 text-sm" @click="removeCredential(i)">删除</button>
            </div>
          </div>

          <!-- Add new credential form -->
          <div class="space-y-3">
            <input v-model="newCred.displayName" placeholder="凭据名称" class="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500" />
            <select v-model="newCred.adapter" class="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white focus:outline-none focus:ring-2 focus:ring-purple-500">
              <option value="openai">OpenAI 兼容</option>
              <option value="seedream">火山引擎 Seedream</option>
              <option value="anthropic">Anthropic</option>
            </select>
            <input v-model="newCred.apiKey" type="password" placeholder="API Key" class="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500" />
            <input v-model="newCred.baseUrl" :placeholder="adapterPlaceholders[newCred.adapter] + '（可选）'" class="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500" />
            <p v-if="credError" class="text-red-400 text-sm">{{ credError }}</p>
            <button class="w-full py-2.5 rounded-lg border border-dashed border-slate-600 text-slate-300 hover:border-purple-500 hover:text-purple-300 transition-colors" @click="addCredential">
              + 添加凭据
            </button>
          </div>

          <div class="flex gap-3 mt-6">
            <button class="flex-1 py-2.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors" @click="next">
              跳过
            </button>
            <button
              :disabled="creds.length === 0 || credSaving"
              class="flex-1 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors"
              @click="saveCredentials"
            >
              {{ credSaving ? '保存中...' : '保存并继续' }}
            </button>
          </div>
        </div>

        <!-- Step 3: Models -->
        <div v-if="currentStep === 3">
          <h2 class="text-xl font-semibold text-white mb-2">创建模型</h2>
          <p class="text-slate-400 text-sm mb-6">选择需要启用的模型预设，系统将自动关联已配置的凭据。</p>

          <div v-if="presets.length === 0" class="text-center py-8 text-slate-500">
            加载预设中...
          </div>

          <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
            <div
              v-for="preset in presets"
              :key="preset.id"
              :class="[
                'rounded-lg border p-4 cursor-pointer transition-colors',
                selectedPresets.has(preset.id)
                  ? 'border-purple-500 bg-purple-900/30'
                  : 'border-slate-700 bg-slate-800/50 hover:border-slate-600',
              ]"
              @click="togglePreset(preset.id)"
            >
              <div class="flex items-start justify-between">
                <div>
                  <h3 class="text-white font-medium">{{ preset.displayName }}</h3>
                  <p class="text-slate-400 text-xs mt-1">{{ adapterLabels[preset.adapter] }} · {{ preset.modelKind === 'image' ? '图像' : '语言' }}</p>
                </div>
                <div
                  :class="[
                    'w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5',
                    selectedPresets.has(preset.id) ? 'border-purple-500 bg-purple-600' : 'border-slate-600',
                  ]"
                >
                  <span v-if="selectedPresets.has(preset.id)" class="text-white text-xs">✓</span>
                </div>
              </div>
              <p class="text-slate-500 text-xs mt-2">{{ preset.vendorModelId }}</p>
            </div>
          </div>

          <p v-if="modelError" class="text-red-400 text-sm mb-4">{{ modelError }}</p>

          <div class="flex gap-3">
            <button class="flex-1 py-2.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors" @click="next">
              跳过
            </button>
            <button
              :disabled="selectedPresets.size === 0 || modelSaving"
              class="flex-1 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors"
              @click="saveModels"
            >
              {{ modelSaving ? '创建中...' : '创建并继续' }}
            </button>
          </div>
        </div>

        <!-- Step 4: OAuth -->
        <div v-if="currentStep === 4">
          <h2 class="text-xl font-semibold text-white mb-2">配置 OAuth 登录</h2>
          <p class="text-slate-400 text-sm mb-6">可选。配置 GitHub 或 Google 登录，让用户可以使用第三方账号登录。</p>

          <div v-for="provider in (['github', 'google'] as const)" :key="provider" class="mb-6 last:mb-0">
            <h3 class="text-white font-medium mb-2">{{ provider === 'github' ? 'GitHub' : 'Google' }} 登录</h3>
            <div class="bg-slate-800 rounded-lg p-3 mb-3">
              <p class="text-slate-400 text-xs mb-1">回调地址（需在 {{ provider === 'github' ? 'GitHub' : 'Google' }} 开发者控制台配置）</p>
              <code class="text-purple-300 text-sm break-all">{{ oauthRedirects[provider] || '加载中...' }}</code>
            </div>
            <input
              v-model="provider === 'github' ? oauthGithub.clientId : oauthGoogle.clientId"
              placeholder="Client ID"
              class="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500 mb-2"
            />
            <input
              v-model="provider === 'github' ? oauthGithub.clientSecret : oauthGoogle.clientSecret"
              type="password"
              placeholder="Client Secret（留空不修改）"
              class="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>

          <p v-if="oauthError" class="text-red-400 text-sm mb-4">{{ oauthError }}</p>

          <div class="flex gap-3 mt-6">
            <button class="flex-1 py-2.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors" @click="next">
              跳过
            </button>
            <button
              :disabled="oauthSaving"
              class="flex-1 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors"
              @click="saveOAuth"
            >
              {{ oauthSaving ? '保存中...' : '保存并继续' }}
            </button>
          </div>
        </div>

        <!-- Step 5: Complete -->
        <div v-if="currentStep === 5">
          <div class="text-center py-8">
            <div class="w-16 h-16 bg-green-600/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <span class="text-3xl text-green-400">✓</span>
            </div>
            <h2 class="text-xl font-semibold text-white mb-2">初始化完成</h2>
            <p class="text-slate-400 mb-4">{{ summary }}</p>
            <button
              class="px-8 py-3 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-medium transition-colors"
              @click="goToApp"
            >
              开始创作
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>