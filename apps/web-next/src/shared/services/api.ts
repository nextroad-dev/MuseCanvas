import { ApiError, clientApi, type RequestOptions } from './client-api'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type {
  User,
  ModelConfig,
  GenerationJob,
  Asset,
  ApiResponse,
  Session,
  PresignedUploadResponse,
  UploadCompleteResponse,
} from '@/shared/types'

export type { RequestOptions }
export { ApiError }

export const api = Object.assign(
  function api<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return clientApi<T>(path, options)
  },
  {
    get: <T>(path: string, options?: RequestOptions) =>
      clientApi<T>(path, { ...options, method: 'GET' }),
    post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      clientApi<T>(path, { ...options, method: 'POST', body }),
    patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      clientApi<T>(path, { ...options, method: 'PATCH', body }),
    delete: <T>(path: string, options?: RequestOptions) =>
      clientApi<T>(path, { ...options, method: 'DELETE' }),

    // Auth
    getMe: async (): Promise<ApiResponse<User>> => {
      const res = await clientApi<Session>(API_ENDPOINTS.session)
      return {
        success: res.success,
        data: res.data?.user,
        error: res.error,
      }
    },
    logout: () => clientApi(API_ENDPOINTS.auth.logout, { method: 'POST' }),

    // Models
    getModels: () => clientApi<ModelConfig[]>(API_ENDPOINTS.models),

    // Jobs
    getJobs: () => clientApi<{ items: GenerationJob[]; total: number; hasMore: boolean }>(API_ENDPOINTS.jobs.list),
    getJob: (id: string) => clientApi<GenerationJob>(API_ENDPOINTS.jobs.detail(id)),
    createGeneration: (body: unknown) =>
      clientApi<GenerationJob>(API_ENDPOINTS.generations, { method: 'POST', body }),
    // Reference image uploads: bytes go straight to object storage with the
    // presigned POST, so only these three JSON control calls live here.
    createGenerationUpload: (body: { mimeType: string; sizeBytes: number }) =>
      clientApi<PresignedUploadResponse>(API_ENDPOINTS.generationUploads.create, { method: 'POST', body }),
    completeGenerationUpload: (uploadId: string) =>
      clientApi<UploadCompleteResponse>(API_ENDPOINTS.generationUploads.complete(uploadId), { method: 'POST' }),
    deleteGenerationUpload: (uploadId: string) =>
      clientApi(API_ENDPOINTS.generationUploads.remove(uploadId), { method: 'DELETE' }),
    cancelJob: (id: string) =>
      clientApi<GenerationJob>(API_ENDPOINTS.jobs.cancel(id), { method: 'POST' }),
    retryJob: (id: string) =>
      clientApi<GenerationJob>(API_ENDPOINTS.jobs.retry(id), { method: 'POST' }),
    deleteJob: (id: string) => clientApi(API_ENDPOINTS.jobs.detail(id), { method: 'DELETE' }),

    // Library (assets)
    getAssets: (params?: Record<string, string | number | boolean | undefined>) =>
      clientApi<{ items: Asset[]; total: number; hasMore: boolean; nextCursor?: string }>(API_ENDPOINTS.library.list, {
        params,
      }),
    /** Freshly signed URL for one owned asset. Gallery URLs expire, so this is the
     *  recovery path when a thumbnail request fails — previously this endpoint had no
     *  caller at all. */
    getAssetDownloadUrl: (id: string) =>
      clientApi<{ url: string; downloadUrl: string; mediaKind: string; mimeType: string }>(
        API_ENDPOINTS.library.download(id),
      ),
    deleteAsset: (id: string) => clientApi(API_ENDPOINTS.library.detail(id), { method: 'DELETE' }),
  },
)

