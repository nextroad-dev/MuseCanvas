import type { ApiResponse, AdminModel, Quality } from '@/types'
import {
  mockUser,
  mockAdmin,
  mockModels,
  mockJobs,
  mockAssets,
  mockAdminUsers,
  mockInvitations,
  mockSmtpSettings,
  mockAdminModels,
  mockAdminJobs,
  mockDashboardMetrics,
  mockModelPresets,
} from './fixtures'

// Simulated in-memory state
let currentUser = { ...mockUser }
let registrationMode: 'open' | 'invite_only' = 'open'
const jobs = [...mockJobs]
const assets = [...mockAssets]
const invitations = [...mockInvitations]
const smtpSettings = { ...mockSmtpSettings }

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data }
}

function fail(code: string, message: string): ApiResponse<never> {
  return { success: false, error: { code, message } }
}

function delay(ms = 150): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function mockFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<unknown>> {
  await delay()

  // ── Auth ────────────────────────────────────────────

  if (method === 'POST' && path === '/api/auth/otp/request') {
    return ok({ message: 'OTP sent' })
  }

  if (method === 'POST' && path === '/api/auth/otp/verify') {
    const b = body as { email?: string; code?: string; invitationCode?: string }
    if (b?.email === 'admin@example.com') {
      currentUser = { ...mockAdmin }
    } else {
      currentUser = { ...mockUser }
      if (b?.email) currentUser.email = b.email
    }
    return ok({ user: currentUser })
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    return ok({ message: 'logged out' })
  }

  if (method === 'GET' && path === '/api/session') {
    return ok({ user: currentUser })
  }

  // ── Models ──────────────────────────────────────────

  if (method === 'GET' && path === '/api/models') {
    return ok(mockModels.filter((m) => m.enabled))
  }

  // ── Generations ─────────────────────────────────────

  if (method === 'POST' && path === '/api/generations') {
    const b = body as { prompt?: string; modelId?: string; size?: string; count?: number; quality?: string }
    const model = mockModels.find((m) => m.id === b?.modelId)
    const newJob = {
      id: `j-${Date.now()}`,
      createdBy: currentUser.id,
      modelId: b?.modelId || 'm-001',
      modelName: model?.displayName || 'GPT Image 2',
      prompt: b?.prompt || '',
      size: b?.size || '1024x1024',
      quality: b?.quality as Quality | undefined,
      count: b?.count || 1,
      status: 'queued' as const,
      createdAt: new Date().toISOString(),
      outputs: [] as never[],
    }
    jobs.unshift(newJob)

    // Simulate progress
    setTimeout(() => {
      const j = jobs.find((x) => x.id === newJob.id)
      if (j) {
        j.status = 'running'
        j.startedAt = new Date().toISOString()
      }
    }, 1000)

    setTimeout(() => {
      const j = jobs.find((x) => x.id === newJob.id)
      if (j) {
        j.status = 'succeeded'
        j.completedAt = new Date().toISOString()
        j.outputs = [
          {
            id: `o-${Date.now()}`,
            assetId: `a-${Date.now()}`,
            imageUrl: `https://picsum.photos/seed/${Date.now()}/800/600`,
          },
        ]
        assets.unshift({
          id: j.outputs[0].assetId,
          prompt: j.prompt,
          imageUrl: j.outputs[0].imageUrl,
          mimeType: 'image/png',
          width: 1024,
          height: 1024,
          sizeBytes: 2000000,
          createdAt: j.completedAt,
        })
      }
    }, 5000)

    return ok(newJob)
  }

  // ── Jobs ────────────────────────────────────────────

  if (method === 'GET' && path.startsWith('/api/jobs/')) {
    const id = path.split('/').pop()
    const job = jobs.find((j) => j.id === id && j.createdBy === currentUser.id)
    return job ? ok(job) : fail('NOT_FOUND', '任务不存在')
  }

  if (method === 'GET' && path === '/api/jobs') {
    const userJobs = jobs.filter((j) => j.createdBy === currentUser.id)
    return ok({ items: userJobs, total: userJobs.length, hasMore: false })
  }

  if (method === 'POST' && path.includes('/cancel')) {
    const id = path.split('/')[3]
    const job = jobs.find((j) => j.id === id)
    if (job && (job.status === 'queued' || job.status === 'running')) {
      job.status = 'canceled'
      return ok(job)
    }
    return fail('INVALID_STATE', '任务无法取消')
  }

  // ── Library ─────────────────────────────────────────

  if (method === 'GET' && path === '/api/library') {
    const userAssets = assets
    return ok({ items: userAssets, total: userAssets.length, hasMore: false })
  }

  if (method === 'DELETE' && path.startsWith('/api/library/')) {
    const id = path.split('/').pop()
    const idx = assets.findIndex((a) => a.id === id)
    if (idx >= 0) {
      assets.splice(idx, 1)
      return ok({ message: 'deleted' })
    }
    return fail('NOT_FOUND', '图片不存在')
  }

  // ── Admin Dashboard ─────────────────────────────────

  if (method === 'GET' && path === '/api/admin/dashboard') {
    return ok(mockDashboardMetrics)
  }

  // ── Admin Users ─────────────────────────────────────

  if (method === 'GET' && path === '/api/admin/users') {
    return ok({ items: mockAdminUsers, total: mockAdminUsers.length, hasMore: false })
  }

  if (method === 'PATCH' && path.startsWith('/api/admin/users/')) {
    const id = path.split('/')[4]
    const user = mockAdminUsers.find((u) => u.id === id)
    if (user) {
      const b = body as { status?: string }
      if (b?.status) user.status = b.status as 'active' | 'disabled'
      return ok(user)
    }
    return fail('NOT_FOUND', '用户不存在')
  }

  // ── Admin Registration ──────────────────────────────

  if (method === 'GET' && path === '/api/admin/registration') {
    return ok({ mode: registrationMode })
  }

  if (method === 'PATCH' && path === '/api/admin/registration') {
    const b = body as { mode?: string }
    if (b?.mode) registrationMode = b.mode as 'open' | 'invite_only'
    return ok({ mode: registrationMode })
  }

  // ── Admin Invitations ───────────────────────────────

  if (method === 'GET' && path === '/api/admin/invitations') {
    return ok({ items: invitations, total: invitations.length, hasMore: false })
  }

  if (method === 'POST' && path === '/api/admin/invitations') {
    const b = body as { email?: string; count?: number }
    const count = b?.count || 1
    const newInv = Array.from({ length: count }, (_, i) => ({
      id: `inv-${Date.now()}-${i}`,
      email: b?.email || '',
      used: false,
      createdAt: new Date().toISOString(),
    }))
    invitations.unshift(...newInv)
    return ok(newInv)
  }

  if (method === 'DELETE' && path.startsWith('/api/admin/invitations/')) {
    const id = path.split('/').pop()
    const idx = invitations.findIndex((i) => i.id === id)
    if (idx >= 0) {
      invitations.splice(idx, 1)
      return ok({ message: 'revoked' })
    }
    return fail('NOT_FOUND', '邀请码不存在')
  }

  // ── Admin SMTP ──────────────────────────────────────

  if (method === 'GET' && path === '/api/admin/smtp') {
    return ok(smtpSettings)
  }

  if (method === 'PUT' && path === '/api/admin/smtp') {
    const b = body as Partial<typeof smtpSettings>
    Object.assign(smtpSettings, b)
    if (b.host || b.port) smtpSettings.hasPassword = true
    return ok(smtpSettings)
  }

  if (method === 'POST' && path === '/api/admin/smtp/test') {
    return ok({ message: '测试邮件已发送' })
  }

  // ── Admin Models ────────────────────────────────────

  if (method === 'GET' && path === '/api/admin/models') {
    return ok(mockAdminModels)
  }

  if (method === 'GET' && path === '/api/admin/model-presets') {
    return ok(mockModelPresets)
  }

  if (method === 'POST' && path === '/api/admin/models') {
    const b = body as Partial<AdminModel>
    const newModel = {
      id: `m-${Date.now()}`,
      displayName: b.displayName || 'New Model',
      adapter: b.adapter || 'openai',
      vendorModelId: b.vendorModelId || '',
      baseUrl: b.baseUrl || 'https://api.openai.com',
      sizes: b.sizes || ['1024x1024'],
      qualityOptions: b.qualityOptions,
      maxCount: b.maxCount || 4,
      concurrencyLimit: b.concurrencyLimit || 1,
      enabled: false,
      sortOrder: mockAdminModels.length + 1,
      watermark: b.watermark,
    }
    mockAdminModels.push(newModel)
    return ok(newModel)
  }

  if (method === 'PATCH' && path.startsWith('/api/admin/models/')) {
    const id = path.split('/')[4]
    const model = mockAdminModels.find((m) => m.id === id)
    if (model) {
      const b = body as Partial<AdminModel>
      Object.assign(model, b)
      return ok(model)
    }
    return fail('NOT_FOUND', '模型不存在')
  }

  // ── Admin Jobs ──────────────────────────────────────

  if (method === 'GET' && path === '/api/admin/jobs') {
    return ok({ items: mockAdminJobs, total: mockAdminJobs.length, hasMore: false })
  }

  // ── Fallback ────────────────────────────────────────

  return fail('NOT_FOUND', `Mock: ${method} ${path} not handled`)
}
