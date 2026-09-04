<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSetupStore } from '../stores/setup'
import { SETUP_STEPS, isSetupStepId, resumeStepId, type SetupStepId } from '../lib/steps'
import type { OnboardingSectionKey } from '@/shared/types'
import SetupStepper from '../components/SetupStepper.vue'
import StepClaimBootstrap from '../components/StepClaimBootstrap.vue'
import StepSite from '../components/StepSite.vue'
import StepSmtpAdmin from '../components/StepSmtpAdmin.vue'
import StepStorage from '../components/StepStorage.vue'
import StepProvidersModels from '../components/StepProvidersModels.vue'
import StepOauthTemplates from '../components/StepOauthTemplates.vue'
import StepRuntime from '../components/StepRuntime.vue'
import StepReview from '../components/StepReview.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import AppAlert from '@/shared/components/ui/AppAlert.vue'
import SurfaceCard from '@/shared/components/ui/SurfaceCard.vue'

const route = useRoute()
const router = useRouter()
const setup = useSetupStore()

const initializing = ref(true)
const stepHeading = ref<HTMLElement | null>(null)

const currentStepId = computed<SetupStepId>(() => {
  const raw = route.query.step
  const value = Array.isArray(raw) ? raw[0] : raw
  return isSetupStepId(value) ? value : 'claim'
})

const currentIndex = computed(() => Math.max(0, SETUP_STEPS.findIndex((s) => s.id === currentStepId.value)))
const currentStep = computed(() => SETUP_STEPS[currentIndex.value])

const completed = computed<Record<string, boolean>>(() => ({
  claim: setup.isSectionComplete('bootstrap'),
  site: setup.isSectionComplete('site'),
  'smtp-admin': setup.isSectionComplete('smtp') && setup.isSectionComplete('admin'),
  storage: setup.isSectionComplete('storage'),
  'providers-models': setup.isSectionComplete('providers') && setup.isSectionComplete('models'),
  'oauth-templates': setup.isSectionComplete('oauth') && setup.isSectionComplete('templates'),
  runtime: setup.isSectionComplete('runtime'),
  review: setup.requiredIncomplete.length === 0,
}))

const incompleteOfCurrent = computed<string[]>(() => {
  switch (currentStepId.value) {
    case 'claim': return setup.isSectionComplete('bootstrap') ? [] : ['实例引导']
    case 'site': return setup.isSectionComplete('site') ? [] : ['站点']
    case 'smtp-admin': {
      const missing: string[] = []
      if (!setup.isSectionComplete('smtp')) missing.push('邮件')
      if (!setup.isSectionComplete('admin')) missing.push('管理员')
      return missing
    }
    case 'storage': return setup.isSectionComplete('storage') ? [] : ['对象存储']
    case 'runtime': return setup.isSectionComplete('runtime') ? [] : ['运行时设置']
    case 'review': return setup.requiredIncomplete.map((k: OnboardingSectionKey) => k)
    default: return []
  }
})

const canAdvance = computed(() => {
  if (currentStepId.value === 'review') return setup.requiredIncomplete.length === 0
  if (currentStep.value.optional) return true
  return incompleteOfCurrent.value.length === 0
})

function goStep(id: SetupStepId) {
  void router.push({ path: '/setup', query: { step: id } })
}

function goNext() {
  if (!canAdvance.value) return
  const next = SETUP_STEPS[currentIndex.value + 1]
  if (next) goStep(next.id)
}

function goBack() {
  const prev = SETUP_STEPS[currentIndex.value - 1]
  if (prev) goStep(prev.id)
}

async function init() {
  initializing.value = true
  await setup.checkStatus()
  if (setup.setupComplete) {
    await router.replace('/admin')
    return
  }
  // Config needs the claim cookie (or an admin session); a failure here is
  // fine — the claim step surfaces it with its own retry.
  await setup.fetchConfig().catch(() => {})
  if (!route.query.step) {
    const target = resumeStepId((key) => setup.sectionStatus(key))
    await router.replace({ path: '/setup', query: { step: target } })
  }
  initializing.value = false
}

async function handleRetryStatus() {
  await init()
}

onMounted(() => {
  void init()
})

watch(currentStepId, () => {
  void nextTick(() => {
    stepHeading.value?.focus()
  })
})
</script>

<template>
  <div class="flex min-h-screen flex-col items-center bg-canvas px-4 py-6 text-foreground sm:justify-center sm:py-10">
    <div class="w-full max-w-3xl">
      <div class="mb-6 text-center">
        <h1 class="mb-1 text-2xl font-bold text-foreground sm:text-3xl">MuseCanvas 初始化</h1>
        <p class="text-sm text-muted-foreground">按步骤完成实例配置，进度会自动保存，刷新后可从服务端状态恢复</p>
      </div>

      <div v-if="initializing" class="py-16 text-center text-sm text-muted-foreground" role="status">
        正在加载初始化状态...
      </div>

      <template v-else>
        <AppAlert
          v-if="setup.statusFailed"
          type="error"
          title="无法连接服务端"
          :message="`${setup.statusError || '网络连接失败'}。这不是“未初始化”，你的进度没有丢失。`"
          class="mb-4"
        />
        <div v-if="setup.statusFailed" class="mb-6 text-center">
          <BaseButton variant="secondary" size="sm" :loading="setup.isBusy('status')" @click="handleRetryStatus">
            {{ setup.isBusy('status') ? '重试中...' : '重试' }}
          </BaseButton>
        </div>

        <div class="mb-6">
          <SetupStepper :steps="SETUP_STEPS" :current-id="currentStepId" :completed="completed" />
        </div>

        <SurfaceCard padding="lg">
          <h2
            ref="stepHeading"
            tabindex="-1"
            class="mb-4 text-xl font-semibold text-foreground focus:outline-none"
          >
            第 {{ currentIndex + 1 }} 步：{{ currentStep.label }}
            <span v-if="currentStep.optional" class="ml-1 align-middle text-xs font-normal text-muted-foreground">（可选，可跳过）</span>
          </h2>

          <StepClaimBootstrap v-if="currentStepId === 'claim'" />
          <StepSite v-else-if="currentStepId === 'site'" />
          <StepSmtpAdmin v-else-if="currentStepId === 'smtp-admin'" />
          <StepStorage v-else-if="currentStepId === 'storage'" />
          <StepProvidersModels v-else-if="currentStepId === 'providers-models'" />
          <StepOauthTemplates v-else-if="currentStepId === 'oauth-templates'" />
          <StepRuntime v-else-if="currentStepId === 'runtime'" />
          <StepReview v-else />

          <div class="mt-8 flex flex-col gap-2 border-t border-border pt-5 sm:flex-row">
            <BaseButton
              variant="secondary"
              class="flex-1"
              :disabled="currentIndex === 0"
              @click="goBack"
            >
              返回上一步
            </BaseButton>
            <BaseButton
              v-if="currentStep.optional && currentStepId !== 'review'"
              variant="ghost"
              class="flex-1"
              @click="goNext"
            >
              跳过此步
            </BaseButton>
            <BaseButton
              v-if="currentStepId !== 'review'"
              class="flex-1"
              :disabled="!canAdvance"
              @click="goNext"
            >
              下一步
            </BaseButton>
          </div>
          <p v-if="currentStepId !== 'review' && !canAdvance && !currentStep.optional" class="mt-2 text-center text-xs text-muted-foreground" role="status">
            请先完成本节保存（{{ incompleteOfCurrent.join('、') }}待完成）后再继续
          </p>
        </SurfaceCard>
      </template>
    </div>
  </div>
</template>
