<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSetupStore } from '../stores/setup'
import { useAuthStore } from '@/features/auth/stores/auth'
import type { UserRole } from '@/shared/types'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import TextInput from '@/shared/components/ui/TextInput.vue'
import Field from '@/shared/components/ui/Field.vue'
import AppAlert from '@/shared/components/ui/AppAlert.vue'
import SurfaceCard from '@/shared/components/ui/SurfaceCard.vue'

const setup = useSetupStore()
const auth = useAuthStore()

// ---- SMTP form (secret stays in memory; cleared after successful submit) ----
const host = ref('')
const port = ref('')
const tlsMode = ref<'none' | 'starttls' | 'implicit_tls'>('starttls')
const username = ref('')
const password = ref('')
const fromAddress = ref('')
const fromName = ref('')
const smtpLocalError = ref('')
let smtpHydrated = false

function hydrateSmtp() {
  const smtp = setup.config?.smtp
  if (!smtp || smtpHydrated) return
  host.value = smtp.host || ''
  port.value = smtp.port != null ? String(smtp.port) : ''
  tlsMode.value = smtp.tlsMode || 'starttls'
  username.value = smtp.username || ''
  fromAddress.value = smtp.fromAddress || ''
  fromName.value = smtp.fromName || ''
  smtpHydrated = true
}

watch(() => setup.config?.smtp, hydrateSmtp, { immediate: true })

const smtp = computed(() => setup.config?.smtp ?? null)
const smtpDone = computed(() => setup.isSectionComplete('smtp'))
const adminDone = computed(() => setup.isSectionComplete('admin'))

function buildSmtpInput(includeBlankSecret: boolean) {
  const trimmedPort = port.value.trim()
  const parsedPort = trimmedPort === '' ? null : Number(trimmedPort)
  const input: Record<string, unknown> = {
    host: host.value.trim() ? host.value.trim() : null,
    port: parsedPort,
    tlsMode: tlsMode.value,
    username: username.value.trim() ? username.value.trim() : null,
    fromAddress: fromAddress.value.trim() ? fromAddress.value.trim() : null,
    fromName: fromName.value.trim() ? fromName.value.trim() : null,
  }
  // Blank password preserves the stored secret server-side.
  if (password.value) input.password = password.value
  else if (includeBlankSecret) input.password = null
  return input as Parameters<typeof setup.saveSmtp>[0]
}

async function handleSmtpTest() {
  smtpLocalError.value = ''
  if (port.value.trim() !== '' && (!Number.isInteger(Number(port.value)) || Number(port.value) <= 0)) {
    smtpLocalError.value = '端口必须为正整数'
    return
  }
  // Empty object tests the saved configuration server-side.
  const isFormEmpty =
    !host.value.trim() && !port.value.trim() && !username.value.trim()
    && !password.value && !fromAddress.value.trim() && !fromName.value.trim()
  const res = await setup.testSmtp(isFormEmpty ? {} : buildSmtpInput(false))
  if (res.success) password.value = ''
}

async function handleSmtpSave() {
  smtpLocalError.value = ''
  const res = await setup.saveSmtp(buildSmtpInput(false))
  if (res.success) {
    password.value = ''
    await setup.fetchConfig().catch(() => {})
  }
}

// ---- Admin OTP ----
const adminEmail = ref('')
const adminCode = ref('')
const adminStage = ref<'email' | 'code'>('email')
const adminLocalError = ref('')

async function handleRequestOtp() {
  adminLocalError.value = ''
  const email = adminEmail.value.trim()
  if (!email) {
    adminLocalError.value = '请输入管理员邮箱'
    return
  }
  const res = await setup.requestAdminOtp(email)
  if (res.success) adminStage.value = 'code'
}

async function handleVerifyOtp() {
  adminLocalError.value = ''
  const res = await setup.verifyAdminOtp(adminEmail.value.trim(), adminCode.value.trim())
  // OTP codes are single-use: drop from memory either way.
  adminCode.value = ''
  if (res.success && res.data) {
    auth.user = {
      id: res.data.user.id,
      email: res.data.user.email,
      role: res.data.user.role as UserRole,
      status: 'active',
      createdAt: new Date().toISOString(),
    }
    auth.initialized = true
    await setup.fetchConfig().catch(() => {})
  }
}
</script>

<template>
  <div class="space-y-8">
    <div>
      <h3 class="mb-1 text-lg font-semibold text-foreground">邮件与管理员</h3>
      <p class="text-sm text-muted-foreground">先验证 SMTP 发信能力（必填），再创建管理员账号。两节都完成后才能继续。</p>
    </div>

    <section aria-label="SMTP 设置" class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <h4 class="text-sm font-medium text-foreground">SMTP 发信</h4>
        <span
          v-if="smtp"
          :class="[
            'rounded-full px-2 py-0.5 text-xs',
            smtp.status === 'verified'
              ? 'bg-success-soft text-success'
              : smtp.status === 'configured'
                ? 'bg-info-soft text-info'
                : smtp.status === 'error'
                  ? 'bg-danger-soft text-danger'
                  : 'bg-surface-subtle text-muted-foreground',
          ]"
        >
          {{
            smtp.status === 'verified' ? '已验证' : smtp.status === 'configured' ? '已配置未验证' : smtp.status === 'error' ? '异常' : '未配置'
          }}
        </span>
        <span v-if="smtp?.hasSecret" class="text-xs text-muted-foreground">
          已保存密钥{{ smtp.secretFingerprint ? `（指纹 ${smtp.secretFingerprint}）` : '' }}，密码留空即保留
        </span>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <Field label="SMTP 主机" required>
          <TextInput v-model="host" type="text" placeholder="smtp.example.com" autocomplete="off" />
        </Field>
        <Field label="端口" hint="常用：25 / 465 / 587" :error="smtpLocalError || undefined">
          <TextInput v-model="port" type="text" inputmode="numeric" placeholder="587" autocomplete="off" :invalid="!!smtpLocalError" />
        </Field>
        <Field label="加密方式">
          <select
            v-model="tlsMode"
            class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="none">不加密</option>
            <option value="starttls">STARTTLS</option>
            <option value="implicit_tls">隐式 TLS</option>
          </select>
        </Field>
        <Field label="用户名">
          <TextInput v-model="username" type="text" placeholder="apikey / 邮箱" autocomplete="off" />
        </Field>
        <Field label="密码" :hint="smtp?.hasSecret ? '留空保留已保存的密钥' : '写入后不可回读'">
          <TextInput v-model="password" type="password" placeholder="SMTP 密码" autocomplete="new-password" />
        </Field>
        <Field label="发件人地址" required>
          <TextInput v-model="fromAddress" type="email" placeholder="noreply@example.com" autocomplete="off" />
        </Field>
        <Field label="发件人名称" class="sm:col-span-2">
          <TextInput v-model="fromName" type="text" placeholder="MuseCanvas" autocomplete="off" />
        </Field>
      </div>

      <AppAlert v-if="setup.sectionError('smtpTest')" type="error" title="连接测试失败" :message="setup.sectionError('smtpTest')" />
      <AppAlert v-if="setup.sectionError('smtp')" type="error" title="保存失败" :message="setup.sectionError('smtp')" />
      <AppAlert v-if="smtpDone" type="success" message="SMTP 已验证通过。" />

      <div class="flex flex-col gap-2 sm:flex-row">
        <BaseButton variant="secondary" class="flex-1" :loading="setup.isBusy('smtpTest')" @click="handleSmtpTest">
          {{ setup.isBusy('smtpTest') ? '测试中...' : '测试连接' }}
        </BaseButton>
        <BaseButton class="flex-1" :loading="setup.isBusy('smtp')" @click="handleSmtpSave">
          {{ setup.isBusy('smtp') ? '保存中...' : '保存 SMTP' }}
        </BaseButton>
      </div>
    </section>

    <SurfaceCard padding="md">
      <section aria-label="管理员账号" class="space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          <h4 class="text-sm font-medium text-foreground">管理员账号</h4>
          <span
            v-if="adminDone"
            class="rounded-full bg-success-soft px-2 py-0.5 text-xs text-success"
          >
            已创建
          </span>
        </div>

        <div v-if="adminDone">
          <AppAlert type="success" :message="`管理员账号已创建（${auth.user?.email || '已登录'}）。`" />
        </div>
        <div v-else-if="adminStage === 'email'">
          <Field label="管理员邮箱" required :error="adminLocalError || setup.sectionError('adminRequest') || undefined">
            <TextInput
              v-model="adminEmail"
              type="email"
              placeholder="admin@example.com"
              :invalid="!!(adminLocalError || setup.sectionError('adminRequest'))"
              @keyup.enter="handleRequestOtp"
            />
          </Field>
          <BaseButton
            class="mt-4 w-full"
            :loading="setup.isBusy('adminRequest')"
            :disabled="!adminEmail.trim()"
            @click="handleRequestOtp"
          >
            {{ setup.isBusy('adminRequest') ? '发送中...' : '发送验证码' }}
          </BaseButton>
        </div>
        <div v-else>
          <p class="mb-3 text-sm text-muted-foreground">
            验证码已发送至 <strong class="text-foreground">{{ adminEmail }}</strong>（需先完成上方 SMTP 配置才能收到邮件）
          </p>
          <Field label="验证码" required :error="adminLocalError || setup.sectionError('adminVerify') || undefined">
            <TextInput
              v-model="adminCode"
              type="text"
              inputmode="numeric"
              maxlength="6"
              placeholder="输入 6 位验证码"
              class="text-center tracking-widest"
              :invalid="!!(adminLocalError || setup.sectionError('adminVerify'))"
              @keyup.enter="handleVerifyOtp"
            />
          </Field>
          <BaseButton
            class="mt-4 w-full"
            :loading="setup.isBusy('adminVerify')"
            :disabled="adminCode.trim().length !== 6"
            @click="handleVerifyOtp"
          >
            {{ setup.isBusy('adminVerify') ? '验证中...' : '验证并创建管理员' }}
          </BaseButton>
          <BaseButton variant="ghost" class="mt-2 w-full" @click="adminStage = 'email'">
            更换邮箱
          </BaseButton>
        </div>
      </section>
    </SurfaceCard>
  </div>
</template>
