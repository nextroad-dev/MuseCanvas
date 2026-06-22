<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { CheckCircle, AlertCircle } from 'lucide-vue-next'
import BaseSelect from '@/components/ui/BaseSelect.vue'

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
const testResult = ref<'success' | 'error' | null>(null)
const testMessage = ref('')
const saving = ref(false)

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
  testResult.value = null
  const res = await admin.testSmtp()
  if (res.success) {
    testResult.value = 'success'
    testMessage.value = '测试邮件已发送'
  } else {
    testResult.value = 'error'
    testMessage.value = res.error?.message || '发送失败'
  }
  setTimeout(() => (testResult.value = null), 5000)
}
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-sm font-semibold text-neutral-900">SMTP 配置</h1>

    <div class="max-w-lg space-y-4">
      <div class="grid grid-cols-3 gap-4">
        <div class="col-span-2">
          <label class="mb-1.5 block text-xs font-medium text-neutral-700">服务器</label>
          <input
            v-model="form.host"
            type="text"
            placeholder="smtp.example.com"
            class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div>
          <label class="mb-1.5 block text-xs font-medium text-neutral-700">端口</label>
          <input
            v-model.number="form.port"
            type="number"
            class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      <div>
        <label class="mb-1.5 block text-xs font-medium text-neutral-700">TLS 模式</label>
        <BaseSelect
          v-model="form.secure"
        >
          <option value="implicit_tls">隐式 TLS (SSL)</option>
          <option value="starttls">STARTTLS</option>
          <option value="none">无加密</option>
        </BaseSelect>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="mb-1.5 block text-xs font-medium text-neutral-700">发件地址</label>
          <input
            v-model="form.from"
            type="email"
            placeholder="noreply@example.com"
            class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div>
          <label class="mb-1.5 block text-xs font-medium text-neutral-700">发件名称</label>
          <input
            v-model="form.fromName"
            type="text"
            placeholder="MuseCanvas"
            class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      <div>
        <label class="mb-1.5 block text-xs font-medium text-neutral-700">用户名</label>
        <input
          v-model="form.user"
          type="text"
          class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div>
        <label class="mb-1.5 block text-xs font-medium text-neutral-700">密码</label>
        <input
          v-model="form.password"
          type="password"
          :placeholder="admin.smtpSettings?.hasPassword ? '已配置（留空保持不变）' : '输入密码'"
          class="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <!-- Test result toast -->
      <div
        v-if="testResult"
        :class="[
          'flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
          testResult === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700',
        ]"
      >
        <CheckCircle v-if="testResult === 'success'" class="h-4 w-4" />
        <AlertCircle v-else class="h-4 w-4" />
        {{ testMessage }}
      </div>

      <!-- Actions -->
      <div class="flex gap-2 pt-2">
        <button
          :disabled="saving"
          class="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          @click="handleSave"
        >
          {{ saving ? '保存中...' : '保存配置' }}
        </button>
        <button
          class="inline-flex h-9 items-center rounded-lg border border-neutral-200 px-4 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          @click="handleTest"
        >
          发送测试邮件
        </button>
      </div>
    </div>
  </div>
</template>
