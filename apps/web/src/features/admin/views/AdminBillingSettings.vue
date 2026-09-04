<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import PillToggle from '@/shared/components/ui/PillToggle.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import Field from '@/shared/components/ui/Field.vue'
import { toast } from '@/shared/composables/useToast'
import { Coins, Save, AlertCircle, RefreshCw } from 'lucide-vue-next'
const admin = useAdminStore()
const loading = ref(false)
const loaded = ref(false)
const loadError = ref<string | null>(null)
const saving = ref(false)

const form = ref({
  enabled: true,
  signupGrant: 100,
  promptOptimizationCredits: 1,
})

async function loadSettings() {
  loading.value = true
  loadError.value = null
  const res = await admin.fetchBillingSettings()
  loading.value = false
  if (res.success && res.data) {
    form.value = {
      enabled: res.data.enabled,
      signupGrant: res.data.signupGrant,
      promptOptimizationCredits: res.data.promptOptimizationCredits,
    }
    loaded.value = true
    loadError.value = null
  } else {
    loaded.value = false
    loadError.value = res.error?.message || '加载计费设置失败'
  }
}

onMounted(() => {
  loadSettings()
})
async function handleSave() {
  if (!loaded.value || saving.value || loading.value) return
  saving.value = true
  const res = await admin.updateBillingSettings({
    enabled: form.value.enabled,
    signupGrant: Number(form.value.signupGrant || 0),
    promptOptimizationCredits: Number(form.value.promptOptimizationCredits || 0),
  })
  saving.value = false
  if (res.success) {
    toast('计费设置已更新', 'success')
  } else {
    toast(res.error?.message || '更新设置失败', 'error')
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="计费设置"
      description="管理全局计费开关、新用户注册赠送积分以及提示词优化积分消耗。"
    >
      <template #actions>
        <BaseButton
          variant="primary"
          size="sm"
          :loading="saving"
          :disabled="!loaded || saving || loading"
          @click="handleSave"
        >
          <template #icon>
            <Save class="h-3.5 w-3.5" />
          </template>
          保存设置
        </BaseButton>
      </template>
    </PageHeader>

    <div v-if="loadError" class="max-w-2xl rounded-[var(--radius-card)] border border-danger/30 bg-danger/10 p-4 text-xs text-danger flex items-center justify-between gap-4">
      <div class="flex items-center gap-2">
        <AlertCircle class="h-4 w-4 shrink-0 text-danger" />
        <span>{{ loadError }}</span>
      </div>
      <BaseButton variant="secondary" size="sm" :loading="loading" @click="loadSettings">
        <template #icon>
          <RefreshCw class="h-3 w-3" :class="{ 'animate-spin': loading }" />
        </template>
        重试
      </BaseButton>
    </div>

    <div v-else-if="loading && !loaded" class="max-w-2xl py-12 text-center text-sm text-muted-foreground">
      <RefreshCw class="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
      <p class="mt-2 text-xs">正在加载计费设置...</p>
    </div>

    <div v-if="loaded" class="max-w-2xl space-y-6">
      <div class="rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-sm">
        <div class="flex items-center justify-between gap-4">
          <div>
            <h3 class="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Coins class="h-4 w-4 text-amber-500" />
              全局积分计费系统
            </h3>
            <p class="mt-1 text-xs text-muted-foreground">
              关闭后，用户可无视积分余额自由发起生图；开启后系统将按模型单价冻结并扣减积分。
            </p>
          </div>
          <PillToggle
            v-model="form.enabled"
          />
        </div>
      </div>

      <!-- Pricing Parameters Card -->
      <div class="rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-sm space-y-4">
        <h3 class="text-sm font-semibold text-foreground">积分策略参数</h3>

        <Field label="新用户注册默认赠送积分" hint="新用户完成注册时自动发放的初始可用积分数量。">
          <input
            v-model.number="form.signupGrant"
            type="number"
            min="0"
            step="1"
            class="mt-1 block w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          />
        </Field>

        <Field label="提示词优化额外消耗积分" hint="任务启用提示词优化时，每单任务固定追加的积分报价。">
          <input
            v-model.number="form.promptOptimizationCredits"
            type="number"
            min="0"
            step="1"
            class="mt-1 block w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          />
        </Field>
      </div>
    </div>
  </div>
</template>
