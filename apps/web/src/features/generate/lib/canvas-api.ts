// Typed JSON helpers for the Canvas + Canvas Agent REST endpoints.
//
// Every call goes through `shared/services/client-api`, so the `/api` prefix,
// credentials, error-envelope parsing and AbortSignal handling stay single-sourced.
// Paths come from `API_ENDPOINTS`; no literal `/api/...` string appears here.
//
// These are plain functions (not React hooks): the TanStack Query hooks in
// `shared/hooks/useCanvases.ts` and `useCanvasAgent.ts` own caching and lifecycle.

import { API_ENDPOINTS } from '@musecanvas/contracts'
import type {
  CanvasAgentApplyResultDto,
  CanvasAgentConfirmResultDto,
  CanvasAgentHistoryDto,
  CanvasAgentStatusDto,
  CanvasAgentTurnRecoveryDto,
  CanvasDto,
  CanvasListPageDto,
  CreateCanvasRequest,
} from '@musecanvas/contracts'
import { ApiError, clientApi } from '@/shared/services/client-api'
import type { RequestOptions } from '@/shared/services/client-api'

/** Unwrap the `{ success, data }` envelope; the server uses `data === undefined`
 *  for a successful empty body, which none of these endpoints produce. */
async function unwrap<T>(path: string, options?: RequestOptions): Promise<T> {
  const response = await clientApi<T>(path, options)
  if (!response.success || response.data === undefined) {
    throw new ApiError(response.error?.code ?? 'UNKNOWN', response.error?.message ?? '请求失败')
  }
  return response.data
}

export interface CanvasHistoryParams {
  /** Forward pagination (older API view); backward paging uses `beforeSeq`. */
  afterSeq?: number
  /** Backward pagination: return the page immediately older than this seq. */
  beforeSeq?: number
  limit?: number
  /** Query-param bag; `client-api` serialises string/number values. */
  [key: string]: number | undefined
}

export const canvasApi = {
  list: (params?: { limit?: number; cursor?: string }) =>
    unwrap<CanvasListPageDto>(API_ENDPOINTS.canvases.list, { params }),

  create: (body: CreateCanvasRequest = {}) =>
    unwrap<CanvasDto>(API_ENDPOINTS.canvases.create, { method: 'POST', body }),

  detail: (canvasId: string) =>
    unwrap<CanvasDto>(API_ENDPOINTS.canvases.detail(canvasId)),

  history: (canvasId: string, params?: CanvasHistoryParams) =>
    unwrap<CanvasAgentHistoryDto>(API_ENDPOINTS.canvases.agent.history(canvasId), { params }),

  turn: (canvasId: string, turnId: string) =>
    unwrap<CanvasAgentTurnRecoveryDto>(API_ENDPOINTS.canvases.agent.turn(canvasId, turnId)),

  confirm: (canvasId: string, pendingId: string, approve: boolean) =>
    unwrap<CanvasAgentConfirmResultDto>(API_ENDPOINTS.canvases.agent.confirm(canvasId), {
      method: 'POST',
      body: { pendingId, approve },
    }),

  apply: (canvasId: string, turnId: string) =>
    unwrap<CanvasAgentApplyResultDto>(API_ENDPOINTS.canvases.agent.apply(canvasId), {
      method: 'POST',
      body: { turnId },
    }),

  status: () => unwrap<CanvasAgentStatusDto>(API_ENDPOINTS.canvasAgent.status),
}

/** Highest valid seq: the first backward page is "everything before this". */
export const LATEST_HISTORY_SEQ = 2_147_483_647
