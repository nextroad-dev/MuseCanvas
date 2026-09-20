import { clientApi, type RequestOptions } from './client-api'
import type {
  User,
  ModelConfig,
  GenerationJob,
  Asset,
  CreditBalance,
  BillingSettings,
  ApiResponse,
  LoginCredentials,
} from '@/shared/types'

export type { RequestOptions }

export const api = Object.assign(
  function api<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return clientApi<T>(path, options)
  },
  {
    get: <T>(path: string, options?: RequestOptions) =>
      clientApi<T>(path, { ...options, method: 'GET' }),
    post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      clientApi<T>(path, { ...options, method: 'POST', body }),
    delete: <T>(path: string, options?: RequestOptions) =>
      clientApi<T>(path, { ...options, method: 'DELETE' }),

    // Auth
    getMe: async (): Promise<ApiResponse<User>> => {
      const res = await clientApi<{ user: User }>('/api/auth/me')
      return {
        success: res.success,
        data: res.data?.user,
        error: res.error,
      }
    },
    login: async (credentials: LoginCredentials): Promise<ApiResponse<User>> => {
      const res = await clientApi<{ user: User }>('/api/auth/login', {
        method: 'POST',
        body: credentials,
      })
      return {
        success: res.success,
        data: res.data?.user,
        error: res.error,
      }
    },
    logout: () => clientApi('/api/auth/logout', { method: 'POST' }),

    // Models
    getModels: () => clientApi<ModelConfig[]>('/api/models'),

    // Jobs
    getJobs: () => clientApi<{ items: GenerationJob[] }>('/api/jobs'),
    getJob: (id: string) => clientApi<GenerationJob>(`/api/jobs/${id}`),
    createGeneration: (body: unknown) =>
      clientApi<GenerationJob>('/api/generations', { method: 'POST', body }),
    cancelJob: (id: string) =>
      clientApi<GenerationJob>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
    retryJob: (id: string) =>
      clientApi<GenerationJob>(`/api/jobs/${id}/retry`, { method: 'POST' }),
    deleteJob: (id: string) => clientApi(`/api/jobs/${id}`, { method: 'DELETE' }),

    // Assets
    getAssets: (params?: Record<string, string | number | boolean | undefined>) =>
      clientApi<{ items: Asset[]; total: number; hasMore: boolean }>('/api/assets', {
        params: params as Record<string, string | number | boolean | undefined>,
      }),
    deleteAsset: (id: string) => clientApi(`/api/assets/${id}`, { method: 'DELETE' }),

    // Account & Billing
    getCredits: () => clientApi<CreditBalance>('/api/credits'),
    getBillingSettings: () => clientApi<BillingSettings>('/api/settings/billing'),
  },
)

