import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  OnboardingSectionKey,
  SetupClaimResult,
  SetupCompletionPayload,
  SetupConfigResponse,
  SetupSmtpTestResult,
  SetupStatusResponse,
  SetupStorageTestResult,
  SetupTemplateImportInput,
  SetupTemplateImportResult,
  SiteSettingsDto,
  SiteSettingsInput,
  SmtpSettingsDto,
  SmtpSettingsInput,
  StorageSettingsDto,
  StorageSettingsInput,
  RuntimeSettingsDto,
  RuntimeSettingsInput,
} from '@/shared/types'
import { api } from '@/shared/services/api'

// Sections that must be complete before `POST /api/setup/complete` succeeds.
// Provider / model / OAuth / template sections are optional and may be skipped.
export const REQUIRED_SETUP_SECTIONS: OnboardingSectionKey[] = [
  'bootstrap',
  'site',
  'smtp',
  'admin',
  'storage',
  'runtime',
]

function failureMessage(res: { error?: { code: string; message: string } }, fallback: string): string {
  return res.error?.message || fallback
}

export const useSetupStore = defineStore('setup', () => {
  const status = ref<SetupStatusResponse | null>(null)
  const config = ref<SetupConfigResponse | null>(null)

  const setupComplete = ref(false)
  const checked = ref(false)
  // True when the last status fetch failed at the transport/API layer. Guards
  // and pages MUST NOT treat this as "setup incomplete".
  const statusFailed = ref(false)
  const statusError = ref('')
  const claimExpiresAt = ref<string | null>(null)

  // Per-section loading / error state. Keys: status, claim, config, site,
  // smtp, smtpTest, adminRequest, adminVerify, storage, storageTest, runtime,
  // templates, complete. Provider / model / OAuth rows use the admin store's
  // own result objects so item-specific errors stay with the item.
  const busy = ref<Record<string, boolean>>({})
  const errors = ref<Record<string, string>>({})

  const smtpVerified = computed(() => config.value?.smtp.status === 'verified')
  const storageVerified = computed(() => config.value?.storage.status === 'verified')

  const requiredIncomplete = computed(() =>
    REQUIRED_SETUP_SECTIONS.filter((key) => sectionStatus(key) !== 'complete'),
  )

  function sectionStatus(key: OnboardingSectionKey): 'pending' | 'complete' {
    return status.value?.sections[key]?.status ?? 'pending'
  }

  function isSectionComplete(key: OnboardingSectionKey): boolean {
    return sectionStatus(key) === 'complete'
  }

  function setBusy(key: string, value: boolean) {
    busy.value = { ...busy.value, [key]: value }
  }

  function setError(key: string, message: string) {
    errors.value = { ...errors.value, [key]: message }
  }

  function clearError(key: string) {
    if (!errors.value[key]) return
    const next = { ...errors.value }
    delete next[key]
    errors.value = next
  }

  function isBusy(key: string): boolean {
    return !!busy.value[key]
  }

  function sectionError(key: string): string {
    return errors.value[key] || ''
  }

  async function checkStatus() {
    setBusy('status', true)
    const res = await api<SetupStatusResponse>('/api/setup/status')
    setBusy('status', false)
    if (res.success && res.data) {
      status.value = res.data
      setupComplete.value = res.data.setupComplete
      statusFailed.value = false
      statusError.value = ''
    } else {
      // Network/API failure is NOT "setup incomplete": keep the previous
      // completion value so guards never redirect on a transport error.
      statusFailed.value = true
      statusError.value = failureMessage(res, '无法获取初始化状态')
    }
    checked.value = true
    return res
  }

  async function refreshStatusBestEffort() {
    try {
      await checkStatus()
    } catch {
      // checkStatus never throws (api() converts transport errors), but stay
      // defensive so mutation callers keep their own result.
    }
  }

  async function claimSetup(code: string) {
    setBusy('claim', true)
    clearError('claim')
    const res = await api<SetupClaimResult>('/api/setup/claim', {
      method: 'POST',
      body: { code },
    })
    setBusy('claim', false)
    if (res.success && res.data) {
      claimExpiresAt.value = res.data.expiresAt
    } else {
      setError('claim', failureMessage(res, '验证失败'))
    }
    return res
  }

  async function fetchConfig() {
    setBusy('config', true)
    clearError('config')
    const res = await api<SetupConfigResponse>('/api/setup/config')
    setBusy('config', false)
    if (res.success && res.data) {
      config.value = res.data
    } else {
      setError('config', failureMessage(res, '加载配置失败'))
    }
    return res
  }

  async function saveSite(input: SiteSettingsInput) {
    setBusy('site', true)
    clearError('site')
    const res = await api<SiteSettingsDto>('/api/setup/site', { method: 'POST', body: input })
    setBusy('site', false)
    if (res.success && res.data) {
      if (config.value) config.value = { ...config.value, site: res.data }
      await refreshStatusBestEffort()
    } else {
      setError('site', failureMessage(res, '保存站点设置失败'))
    }
    return res
  }

  async function testSmtp(input: SmtpSettingsInput) {
    setBusy('smtpTest', true)
    clearError('smtpTest')
    const res = await api<SetupSmtpTestResult>('/api/setup/smtp/test', {
      method: 'POST',
      body: input,
    })
    setBusy('smtpTest', false)
    if (res.success && res.data) {
      const settings: SmtpSettingsDto | undefined = res.data.settings
      if (settings && config.value) config.value = { ...config.value, smtp: settings }
      await refreshStatusBestEffort()
    } else {
      setError('smtpTest', failureMessage(res, 'SMTP 连接测试失败'))
    }
    return res
  }

  async function saveSmtp(input: SmtpSettingsInput) {
    setBusy('smtp', true)
    clearError('smtp')
    const res = await api<SmtpSettingsDto>('/api/setup/smtp', { method: 'POST', body: input })
    setBusy('smtp', false)
    if (res.success && res.data) {
      if (config.value) config.value = { ...config.value, smtp: res.data }
      await refreshStatusBestEffort()
    } else {
      setError('smtp', failureMessage(res, '保存 SMTP 设置失败'))
    }
    return res
  }

  async function testStorage(input: StorageSettingsInput) {
    setBusy('storageTest', true)
    clearError('storageTest')
    const res = await api<SetupStorageTestResult>('/api/setup/storage/test', {
      method: 'POST',
      body: input,
    })
    setBusy('storageTest', false)
    if (res.success && res.data) {
      const settings: StorageSettingsDto | undefined = res.data.settings
      if (settings && config.value) config.value = { ...config.value, storage: settings }
      await refreshStatusBestEffort()
    } else {
      setError('storageTest', failureMessage(res, '对象存储连接测试失败'))
    }
    return res
  }

  async function saveStorage(input: StorageSettingsInput) {
    setBusy('storage', true)
    clearError('storage')
    const res = await api<StorageSettingsDto>('/api/setup/storage', {
      method: 'POST',
      body: input,
    })
    setBusy('storage', false)
    if (res.success && res.data) {
      if (config.value) config.value = { ...config.value, storage: res.data }
      await refreshStatusBestEffort()
    } else {
      setError('storage', failureMessage(res, '保存对象存储设置失败'))
    }
    return res
  }

  async function saveRuntime(input: RuntimeSettingsInput) {
    setBusy('runtime', true)
    clearError('runtime')
    const res = await api<RuntimeSettingsDto>('/api/setup/runtime', {
      method: 'POST',
      body: input,
    })
    setBusy('runtime', false)
    if (res.success && res.data) {
      if (config.value) config.value = { ...config.value, runtime: res.data }
      await refreshStatusBestEffort()
    } else {
      setError('runtime', failureMessage(res, '保存运行时设置失败'))
    }
    return res
  }

  async function importTemplates(input: SetupTemplateImportInput) {
    setBusy('templates', true)
    clearError('templates')
    const res = await api<SetupTemplateImportResult>('/api/setup/prompt-templates/import', {
      method: 'POST',
      body: input,
    })
    setBusy('templates', false)
    if (res.success) {
      // Refresh both the template summary and section status best-effort.
      try {
        await fetchConfig()
      } catch {
        // fetchConfig records its own error; import itself still succeeded.
      }
      await refreshStatusBestEffort()
    } else {
      setError('templates', failureMessage(res, '导入提示词模板失败'))
    }
    return res
  }

  async function completeSetup() {
    setBusy('complete', true)
    clearError('complete')
    const res = await api<SetupCompletionPayload>('/api/setup/complete', {
      method: 'POST',
      body: {},
    })
    setBusy('complete', false)
    if (res.success && res.data) {
      setupComplete.value = res.data.completed
      await refreshStatusBestEffort()
    } else {
      setError('complete', failureMessage(res, '完成初始化失败'))
    }
    return res
  }

  async function requestAdminOtp(email: string) {
    setBusy('adminRequest', true)
    clearError('adminRequest')
    const res = await api<{ accepted: boolean }>('/api/setup/admin/request', {
      method: 'POST',
      body: { email },
    })
    setBusy('adminRequest', false)
    if (!res.success) {
      setError('adminRequest', failureMessage(res, '发送验证码失败'))
    }
    return res
  }

  async function verifyAdminOtp(email: string, code: string) {
    setBusy('adminVerify', true)
    clearError('adminVerify')
    const res = await api<{ user: { id: string; email: string; role: string } }>(
      '/api/setup/admin/verify',
      { method: 'POST', body: { email, code } },
    )
    setBusy('adminVerify', false)
    if (res.success) {
      await refreshStatusBestEffort()
    } else {
      setError('adminVerify', failureMessage(res, '验证失败'))
    }
    return res
  }

  return {
    status,
    config,
    setupComplete,
    checked,
    statusFailed,
    statusError,
    claimExpiresAt,
    busy,
    errors,
    smtpVerified,
    storageVerified,
    requiredIncomplete,
    sectionStatus,
    isSectionComplete,
    isBusy,
    sectionError,
    clearError,
    checkStatus,
    claimSetup,
    fetchConfig,
    saveSite,
    testSmtp,
    saveSmtp,
    testStorage,
    saveStorage,
    saveRuntime,
    importTemplates,
    completeSetup,
    requestAdminOtp,
    verifyAdminOtp,
  }
})
