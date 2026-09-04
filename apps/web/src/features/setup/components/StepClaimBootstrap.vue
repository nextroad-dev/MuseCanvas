<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSetupStore } from '../stores/setup'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
import Field from '@/shared/components/ui/Field.vue'
import AppAlert from '@/shared/components/ui/AppAlert.vue'
import SurfaceCard from '@/shared/components/ui/SurfaceCard.vue'

const setup = useSetupStore()

// In-memory only: the claim code lives in this ref and the HttpOnly cookie, nowhere else.
const claimCode = ref('')
const localError = ref('')

const bootstrap = computed(() => setup.status?.bootstrap ?? null)
const bootstrapDone = computed(() => setup.isSectionComplete('bootstrap'))
const needsClaim = computed(() => setup.config === null)

const checkStateLabel: Record<string, string> = {
  ok: '正常',
  missing: '缺失',
  error: '异常',
}

async function handleClaim() {
  localError.value = ''
  const code = claimCode.value.trim()
  if (!code) {
    localError.value = '请输入启动日志中的一次性认领码'
    return
  }
  const res = await setup.claimSetup(code)
  // The plaintext code is single-use: drop it from memory either way.
  claimCode.value = ''
  if (!res.success) return
  await setup.fetchConfig()
  await setup.checkStatus()
}

async function handleRetry() {
  await setup.checkStatus()
  if (!setup.config) {
    await setup.fetchConfig()
  }
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <h3 class="mb-1 text-lg font-semibold text-foreground">实例认领与环境自检</h3>
      <p class="text-sm text-muted-foreground">
        输入服务端启动日志中打印的一次性认领码（15 分钟内有效），认领成功后继续配置。
      </p>
    </div>

    <AppAlert
      v-if="setup.statusFailed"
      type="error"
      title="无法获取初始化状态"
      :message="`${setup.statusError || '网络连接失败'}。这不是“未初始化”，请检查网络后重试。`"
    />

    <SurfaceCard v-if="needsClaim" padding="md">
      <Field label="一次性认领码" required :error="localError || setup.sectionError('claim') || undefined">
        <TextInput
          v-model="claimCode"
          type="text"
          placeholder="粘贴启动日志中的认领码"
          autocomplete="off"
          :invalid="!!(localError || setup.sectionError('claim'))"
          @keyup.enter="handleClaim"
        />
      </Field>
      <BaseButton
        class="mt-4 w-full"
        :loading="setup.isBusy('claim')"
        :disabled="!claimCode.trim()"
        @click="handleClaim"
      >
        {{ setup.isBusy('claim') ? '验证中...' : '认领实例' }}
      </BaseButton>
      <p class="mt-2 text-xs text-muted-foreground">认领码通过 HttpOnly Cookie 生效，仅存储于内存与 Cookie，不会写入本地存储。</p>
    </SurfaceCard>

    <AppAlert
      v-else
      type="success"
      title="实例已认领"
      :message="setup.claimExpiresAt ? `认领有效期至 ${new Date(setup.claimExpiresAt).toLocaleString('zh-CN')}` : '实例已认领，可以继续配置。'"
    />

    <section aria-label="环境自检">
      <h4 class="mb-2 text-sm font-medium text-foreground">环境自检</h4>
      <div v-if="!bootstrap" class="py-4 text-center text-sm text-muted-foreground">
        暂无自检数据，点击重试获取。
      </div>
      <ul v-else class="space-y-2">
        <li
          v-for="check in bootstrap.checks"
          :key="check.key"
          class="flex items-start justify-between gap-3 rounded-[var(--radius-control)] border border-border bg-surface-subtle px-3 py-2.5"
        >
          <div class="min-w-0">
            <p class="text-sm font-medium text-foreground">
              {{ check.key }}
              <span
                :class="[
                  'ml-2 rounded-full px-2 py-0.5 text-xs',
                  check.status === 'ok'
                    ? 'bg-success-soft text-success'
                    : check.status === 'missing'
                      ? 'bg-warning-soft text-warning'
                      : 'bg-danger-soft text-danger',
                ]"
              >
                {{ checkStateLabel[check.status] || check.status }}
              </span>
            </p>
            <p v-if="check.message" class="mt-0.5 break-words text-xs text-muted-foreground">{{ check.message }}</p>
          </div>
        </li>
      </ul>
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <AppAlert
          :type="bootstrap?.ready ? 'success' : 'warning'"
          :message="bootstrap?.ready ? '环境就绪，可以继续下一步。' : '环境尚未就绪：请按上面的自检结果修复后重试。'"
          class="min-w-0 flex-1"
        />
        <BaseButton variant="secondary" size="sm" :loading="setup.isBusy('status')" @click="handleRetry">
          {{ setup.isBusy('status') ? '检查中...' : '重新检查' }}
        </BaseButton>
      </div>
      <AppAlert
        v-if="setup.sectionError('config')"
        type="error"
        title="配置加载失败"
        :message="setup.sectionError('config')"
        class="mt-3"
      />
      <AppAlert
        v-if="bootstrapDone"
        type="success"
        message="实例引导已完成。"
        class="mt-3"
      />
    </section>
  </div>
</template>
