import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SetupStatus } from '@/shared/types'
import { api } from '@/shared/services/api'

export const useSetupStore = defineStore('setup', () => {
  const setupComplete = ref(false)
  const checked = ref(false)

  async function checkStatus() {
    const res = await api<SetupStatus>('/api/setup/status')
    if (res.success && res.data) {
      setupComplete.value = res.data.setupComplete
    } else {
      // If API is unreachable, assume setup is not complete but don't block
      setupComplete.value = false
    }
    checked.value = true
  }

  async function requestAdminOtp(email: string) {
    return api<{ accepted: boolean }>('/api/setup/admin/request', {
      method: 'POST',
      body: { email },
    })
  }

  async function verifyAdminOtp(email: string, code: string) {
    const res = await api<{ user: { id: string; email: string; role: string } }>(
      '/api/setup/admin/verify',
      { method: 'POST', body: { email, code } },
    )
    if (res.success) {
      setupComplete.value = true
    }
    return res
  }

  return { setupComplete, checked, checkStatus, requestAdminOtp, verifyAdminOtp }
})