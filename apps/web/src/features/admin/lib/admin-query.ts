import type { AdminJob, ApiResponse, Invitation } from '@/shared/types'

/** A failed envelope must reject the Query, never masquerade as an empty list. */
export function requireAdminData<T>(response: ApiResponse<T>, fallback: string): T {
  if (!response.success || response.data == null) {
    throw Object.assign(new Error(response.error?.message || fallback), {
      code: response.error?.code || 'INVALID_RESPONSE',
    })
  }
  return response.data
}

/** Provider payloads may contain prompts, endpoints or credentials: never render them. */
export function adminJobErrorSummary(job: Pick<AdminJob, 'errorCode' | 'providerError'>): string {
  const parts: string[] = []
  if (job.errorCode) {
    parts.push(/^[A-Z][A-Z0-9_]{0,99}$/.test(job.errorCode) ? job.errorCode : '错误代码不可用')
  }
  const status = job.providerError?.status
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    parts.push(`供应商 HTTP ${status}`)
  }
  return parts.join(' · ') || (job.providerError ? '供应商错误（无安全摘要）' : '')
}

/** Full task detail values are a whitelist, not a raw DTO or provider-payload dump. */
export function adminJobDetailValues(job: AdminJob) {
  return {
    id: job.id,
    createdBy: job.createdBy || '—',
    modelName: job.modelName || '未知模型',
    modelId: job.modelId,
    status: job.status,
    errorSummary: adminJobErrorSummary(job) || '—',
    createdAt: job.createdAt,
  }
}

export function invitationStatus(invitation: Invitation): {
  label: string
  tone: 'danger' | 'neutral'
} {
  if (invitation.used) return { label: '已使用', tone: 'danger' }
  if (invitation.revoked) return { label: '已撤销', tone: 'neutral' }
  // The admin list does not return expiresAt; creation time cannot prove validity.
  return { label: '未使用，期限未知', tone: 'neutral' }
}
