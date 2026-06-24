<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAdminStore } from '@/features/admin/stores/admin'
import BaseDropdown from '@/shared/components/ui/BaseDropdown.vue'
import PageHeader from '@/shared/components/ui/PageHeader.vue'
import BaseButton from '@/shared/components/ui/BaseButton.vue'
import { toast } from '@/shared/composables/useToast'

const admin = useAdminStore()

const form = ref({
  host: '',
  port: 465,
  secure: 'implicit_tls' as 'implicit_tls' | 'starttls' | 'none',
  from: '',
  fromName: '',
  user: '',
  password: '',
})
const saving = ref(false)

const secureOptions = [
  { value: 'implicit_tls', label: '隐式 TLS (SSL)' },
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'none', label: '无加密' },
]

onMounted(async () => {
  await admin.fetchSmtp()
  if (admin.smtpSettings) {
    form.value = {
      host: admin.smtpSettings.host,
      port: admin.smtpSettings.port,
      secure: admin.smtpSettings.secure,
      from: admin.smtpSettings.from,
      fromName: admin.smtpSettings.fromName,
      user: admin.smtpSettings.user,
      password: '',
    }
  }
})

async function handleSave() {
  saving.value = true
  const data: Record<string, unknown> = {
    host: form.value.host,
    port: form.value.port,
    secure: form.value.secure,
    from: form.value.from,
    fromName: form.value.fromName,
    user: form.value.user,
  }
  if (form.value.password) {
    data.password = form.value.password
  }
  await admin.updateSmtp(data)
  saving.value = false
}

async function handleTest() {
  const res = await admin.testSmtp()
  if (res.success) {
    toast('测试邮件已发送', 'success')
  } else {
    toast(res.error?.message || '发送失败', 'error')
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="SMTP 配置" description="配置邮件服务器，用于系统邮件通知和用户验证。" />

    <div class="max-w-lg space-y-8">
      <!-- Server -->
      <div class="space-y-4">
        <h2 class="text-sm font-semibold text-foreground">服务器设置</h2>
        <div class="space-y-4">
          <div class="grid grid-cols-3 gap-4">
            <div class="col-span-2">
              <label class="mb-1.5 block text-xs font-medium text-muted-foreground">服务器</label>
              <input
                v-model="form.host"
                type="text"
                placeholder="smtp.example.com"
                class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label class="mb-1.5 block text-xs font-medium text-muted-foreground">端口</label>
              <input
                v-model.number="form.port"
                type="number"
                class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
          <div>
            <label class="mb-1.5 block text-xs font-medium text-muted-foreground">TLS 模式</label>
            <BaseDropdown v-model="form.secure" :options="secureOptions" />
          </div>
        </div>
      </div>

      <!-- Sender -->
      <div class="space-y-4">
        <h2 class="text-sm font-semibold text-foreground">发件人设置</h2>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="mb-1.5 block text-xs font-medium text-muted-foreground">发件地址</label>
            <input
              v-model="form.from"
              type="email"
              placeholder="noreply@example.com"
              class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label class="mb-1.5 block text-xs font-medium text-muted-foreground">发件名称</label>
            <input
              v-model="form.fromName"
              type="text"
              placeholder="MuseCanvas"
              class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
      </div>

      <!-- Authentication -->
      <div class="space-y-4">
        <h2 class="text-sm font-semibold text-foreground">身份验证</h2>
        <div class="space-y-4">
          <div>
            <label class="mb-1.5 block text-xs font-medium text-muted-foreground">用户名</label>
            <input
              v-model="form.user"
              type="text"
              class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label class="mb-1.5 block text-xs font-medium text-muted-foreground">密码</label>
            <input
              v-model="form.password"
              type="password"
              :placeholder="admin.smtpSettings?.hasPassword ? '已配置（留空保持不变）' : '输入密码'"
              class="h-9 w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
      </div>

      <!-- Actions -->
      <div class="flex gap-2 pt-2">
        <BaseButton :loading="saving" @click="handleSave">保存配置</BaseButton>
        <BaseButton variant="secondary" @click="handleTest">发送测试邮件</BaseButton>
      </div>
    </div>
  </div>
</template>
