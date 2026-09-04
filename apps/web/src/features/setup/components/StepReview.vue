<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSetupStore, REQUIRED_SETUP_SECTIONS } from '../stores/setup'
import type { OnboardingSectionKey } from '@/shared/types'
import { useAdminStore } from '@/features/admin/stores/admin'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import AppAlert from '@/shared/components/ui/AppAlert.vue'

const router = useRouter()
const setup = useSetupStore()
const admin = useAdminStore()

const countsLoading = ref(true)

const SECTION_LABELS: Record<string, string> = {
  bootstrap: '实例引导',
  site: '站点',
  smtp: '邮件',
  admin: '管理员',
  storage: '对象存储',
  providers: '供应商凭据',
  models: '模型',
  oauth: '第三方登录',
  templates: '提示词模板',
  runtime: '运行时设置',
}

onMounted(async () => {
  countsLoading.value = true
  // Best-effort counts for the summary; failures surface inline, never block.
  await Promise.all([
    admin.fetchProviderCredentials().catch(() => null),
    admin.fetchModels().catch(() => null),
  ])
  countsLoading.value = false
})

const requiredRows = computed(() =>
  REQUIRED_SETUP_SECTIONS.map((key) => ({
    key,
    label: SECTION_LABELS[key] || key,
    complete: setup.sectionStatus(key) === 'complete',
  })),
)

const optionalRows = computed(() => (['providers', 'models', 'oauth', 'templates'] as const).map((key) => ({
  key,
  label: SECTION_LABELS[key] || key,
  complete: setup.sectionStatus(key as Parameters<typeof setup.sectionStatus>[0]) === 'complete',
})))

const siteSummary = computed(() => {
  const site = setup.config?.site
  if (!site || (!site.siteName && !site.siteUrl)) return '未设置'
  return [site.siteName, site.siteUrl].filter(Boolean).join(' · ')
})

const smtpSummary = computed(() => {
  const smtp = setup.config?.smtp
  if (!smtp) return '未配置'
  const verified = smtp.status === 'verified' ? '已验证' : smtp.status === 'configured' ? '已配置未验证' : smtp.status
  return `${smtp.host || '未设置主机'} · ${verified}`
})

const storageSummary = computed(() => {
  const storage = setup.config?.storage
  if (!storage) return '未配置'
  const verified = storage.status === 'verified' ? '已验证' : storage.status === 'configured' ? '已配置未验证' : storage.status
  return `${storage.bucket || '未设置 Bucket'} · ${verified}`
})

async function handleComplete() {
  const res = await setup.completeSetup()
  if (!res.success) return
  // Secrets and one-time codes live only in component memory and were already
  // cleared on each successful submit; nothing persisted needs wiping here.
  await router.push('/admin')
}

async function handleRecheck() {
  await setup.checkStatus()
  await setup.fetchConfig().catch(() => {})
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <h3 class="mb-1 text-lg font-semibold text-foreground">检查并完成</h3>
      <p class="text-sm text-muted-foreground">确认必填节均已完成，然后结束初始化。供应商、模型、第三方登录与模板为可选，不影响完成。</p>
    </div>

    <section aria-label="必填节状态">
      <h4 class="mb-2 text-sm font-medium text-foreground">必填节</h4>
      <ul class="space-y-2">
        <li
          v-for="row in requiredRows"
          :key="row.key"
          class="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3 py-2"
        >
          <span class="text-sm text-foreground">{{ row.label }}</span>
          <span
            :class="[
              'rounded-full px-2 py-0.5 text-xs',
              row.complete ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning',
            ]"
          >
            {{ row.complete ? '已完成' : '待完成' }}
          </span>
        </li>
      </ul>
    </section>

    <section aria-label="配置摘要" class="space-y-2 text-sm">
      <h4 class="text-sm font-medium text-foreground">配置摘要</h4>
      <dl class="space-y-1.5 rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3 py-2.5 text-xs sm:text-sm">
        <div class="flex flex-wrap gap-x-2"><dt class="text-muted-foreground">站点：</dt><dd class="text-foreground">{{ siteSummary }}</dd></div>
        <div class="flex flex-wrap gap-x-2"><dt class="text-muted-foreground">邮件：</dt><dd class="text-foreground">{{ smtpSummary }}</dd></div>
        <div class="flex flex-wrap gap-x-2"><dt class="text-muted-foreground">存储：</dt><dd class="text-foreground">{{ storageSummary }}</dd></div>
        <div class="flex flex-wrap gap-x-2">
          <dt class="text-muted-foreground">供应商 / 模型：</dt>
          <dd class="text-foreground">
            {{ countsLoading ? '统计中...' : `${admin.providerCredentials.length} 个凭据 · ${admin.models.length} 个模型` }}（可选）
          </dd>
        </div>
        <div class="flex flex-wrap gap-x-2">
          <dt class="text-muted-foreground">模板：</dt>
          <dd class="text-foreground">
            {{ setup.config?.templates.active ? `${setup.config.templates.active.name} v${setup.config.templates.active.version} · ${setup.config.templates.active.entryCount} 条` : '未导入' }}（可选）
          </dd>
        </div>
      </dl>
    </section>

    <section aria-label="可选节状态">
      <h4 class="mb-2 text-sm font-medium text-foreground">可选节 <span class="font-normal text-muted-foreground">（未完成也可结束）</span></h4>
      <ul class="space-y-2">
        <li
          v-for="row in optionalRows"
          :key="row.key"
          class="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3 py-2"
        >
          <span class="text-sm text-foreground">{{ row.label }}</span>
          <span
            :class="[
              'rounded-full px-2 py-0.5 text-xs',
              row.complete ? 'bg-success-soft text-success' : 'bg-surface-subtle text-muted-foreground',
            ]"
          >
            {{ row.complete ? '已完成' : '未完成（可跳过）' }}
          </span>
        </li>
      </ul>
    </section>

    <AppAlert v-if="setup.sectionError('complete')" type="error" title="完成失败" :message="setup.sectionError('complete')" />
    <AppAlert
      v-if="!setup.sectionError('complete') && setup.requiredIncomplete.length > 0"
      type="warning"
      :message="`尚有必填节未完成：${setup.requiredIncomplete.map((k: OnboardingSectionKey) => SECTION_LABELS[k] || k).join('、')}。请返回对应步骤完成后再试。`"
    />

    <div class="flex flex-col gap-2 sm:flex-row">
      <BaseButton variant="secondary" class="flex-1" :loading="setup.isBusy('status')" @click="handleRecheck">
        {{ setup.isBusy('status') ? '检查中...' : '重新检查状态' }}
      </BaseButton>
      <BaseButton class="flex-1" :loading="setup.isBusy('complete')" @click="handleComplete">
        {{ setup.isBusy('complete') ? '提交中...' : '完成初始化，进入管理后台' }}
      </BaseButton>
    </div>
  </div>
</template>
