import type { QueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type { SetupDatabaseStatus, SetupStatusResponse } from '@musecanvas/contracts'
import { api, ApiError } from '@/shared/services/api'
import type { ApiResponse, SetupConfigResponse } from '@/shared/types'
import { isSetupSessionError, sessionLostMessage } from './setup-wizard-state'

/** `GET /setup/config` plus the database block the server adds when the probe runs. */
export type SetupWizardConfig = SetupConfigResponse & { database?: SetupDatabaseStatus }

/** `POST /setup/database/test`: the status report plus the probe verdict. */
export type SetupDatabaseTestResult = SetupDatabaseStatus & {
  ok: boolean
  errorCode: string | null
}

export const setupQueryKeys = {
  status: ['setup', 'status'] as const,
  config: ['setup', 'config'] as const,
  database: ['setup', 'database'] as const,
}

/** Unwraps an envelope or throws an `ApiError` that keeps the server code for copy mapping. */
export function requireSetupData<T>(res: ApiResponse<T>, fallback: string): T {
  if (!res.success || res.data === undefined) {
    throw new ApiError(res.error?.code ?? 'INVALID_RESPONSE', res.error?.message || fallback)
  }
  return res.data
}

/** Verified-test responses: only a successful, verified result may replace the draft baseline. */
export function requireVerifiedSetupResult<T>(res: ApiResponse<{ verified: boolean; settings: T }>, fallback: string): T {
  if (!res.success || !res.data?.verified || !res.data.settings) {
    throw new ApiError(res.error?.code ?? 'VERIFY_FAILED', res.error?.message || fallback)
  }
  return res.data.settings
}

export function errorCodeOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined
}

/** Copy for a failed step action. Session loss is reported as one message everywhere. */
export function stepErrorMessage(error: unknown, fallback: string): string {
  const code = errorCodeOf(error)
  if (isSetupSessionError(code)) return sessionLostMessage()
  if (error instanceof ApiError && error.message) return error.message
  return fallback
}

export function fetchSetupStatus(): Promise<SetupStatusResponse> {
  return api<SetupStatusResponse>(API_ENDPOINTS.setup.status).then((res) =>
    requireSetupData(res, '无法读取初始化状态。请检查服务连接后重试。'),
  )
}

export function fetchSetupConfig(): Promise<SetupWizardConfig> {
  return api<SetupWizardConfig>(API_ENDPOINTS.setup.config).then((res) =>
    requireSetupData(res, '无法读取系统配置。'),
  )
}

export function fetchSetupDatabase(): Promise<SetupDatabaseStatus> {
  return api<SetupDatabaseStatus>(API_ENDPOINTS.setup.database).then((res) =>
    requireSetupData(res, '无法读取数据库状态。'),
  )
}

export function testSetupDatabase(): Promise<SetupDatabaseTestResult> {
  return api<SetupDatabaseTestResult>(API_ENDPOINTS.setup.databaseTest, { method: 'POST' }).then((res) =>
    requireSetupData(res, '数据库检测失败。'),
  )
}

/** Setup and admin-settings share the `setup` config, so both caches are refreshed together. */
export function invalidateSetupQueries(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['setup'] }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }),
  ])
}
