import type { CreateGenerationRequest } from '@musecanvas/contracts'
import type { AssetListDto, GenerationJobDto, GenerationJobListDto } from '../types'
import { ApiError } from './api'
import { MOCK_MODEL, mockSampleAsset, mockSeedAssets } from './mock-workspace-data'

export const MOCK_WORKSPACE_STORAGE_KEY = 'musecanvas:workspace-preview:v1'
export const MOCK_JOB_RUNNING_MS = 1_000
export const MOCK_JOB_SUCCEEDED_MS = 4_000

type Entry = { id: string; request: CreateGenerationRequest; at: number; canceled?: boolean; removed?: boolean }
type State = { version: 1; nextId: number; entries: Entry[]; removedSeeds: string[] }
export interface MockWorkspaceOptions {
  now?: () => number
  storage?: Pick<Storage, 'getItem' | 'setItem'>
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function fail(status: number, code: string, message: string): never { throw new ApiError(status, code, message) }

function validateRequest(request: CreateGenerationRequest) {
  if (!request || request.modelId !== MOCK_MODEL.id || (request.inputs?.length ?? 0) > 0) {
    fail(400, 'MOCK_UNSUPPORTED', '本地演示仅支持文字选择图片样片，不支持视频、上传或参考图；未调用真实生成服务。')
  }
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 10_000) {
    fail(400, 'INVALID_PROMPT', '请输入 1–10000 字的提示词。')
  }
  const parameters = request.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) ||
      Object.keys(parameters).some((key) => !['size', 'count'].includes(key)) ||
      (parameters.size !== undefined && !MOCK_MODEL.sizes.includes(String(parameters.size))) ||
      (parameters.count !== undefined && (!Number.isInteger(parameters.count) || Number(parameters.count) < 1 || Number(parameters.count) > 4)) ||
      (request.idempotencyKey !== undefined && (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length > 200))) {
    fail(400, 'MOCK_UNSUPPORTED_PARAMETERS', '样片演示仅支持列出的画幅及 1–4 张样片，不执行模型参数。')
  }
}

function requestIdentity(request: CreateGenerationRequest) {
  return JSON.stringify([
    request.modelId, request.prompt,
    request.parameters.size ?? MOCK_MODEL.defaults.size,
    request.parameters.count ?? MOCK_MODEL.defaults.count,
    request.inputLanguage ?? null,
  ])
}

/** Isolated state, no timers or network. Reads derive bounded progress from the clock. */
export function createMockWorkspaceApi({ now = Date.now, storage }: MockWorkspaceOptions = {}) {
  let state: State = { version: 1, nextId: 1, entries: [], removedSeeds: [] }
  try {
    const raw = storage?.getItem(MOCK_WORKSPACE_STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as State
      if (saved.version !== 1 || !Number.isSafeInteger(saved.nextId) || saved.nextId < 1 ||
          !Array.isArray(saved.entries) || saved.entries.length > 200 || !Array.isArray(saved.removedSeeds) ||
          !saved.removedSeeds.every((id) => mockSeedAssets().some((asset) => asset.id === id))) throw new Error('Invalid preview state')
      const ids = new Set<string>()
      for (const entry of saved.entries) {
        if (!entry || !/^mock-job-\d+$/.test(entry.id) || ids.has(entry.id) ||
            !Number.isSafeInteger(Number(entry.id.slice(9))) || Number(entry.id.slice(9)) < 1 ||
            Number(entry.id.slice(9)) >= saved.nextId || !Number.isFinite(entry.at) || entry.at < 0 ||
            !Number.isFinite(new Date(entry.at + MOCK_JOB_SUCCEEDED_MS).getTime()) ||
            ['canceled', 'removed'].some((key) => entry[key as keyof Entry] !== undefined && typeof entry[key as keyof Entry] !== 'boolean')) throw new Error('Invalid preview entry')
        validateRequest(entry.request)
        ids.add(entry.id)
      }
      state = saved
    }
  } catch { /* Missing, denied, stale or corrupt storage starts an isolated demo. */ }
  function save() { try { storage?.setItem(MOCK_WORKSPACE_STORAGE_KEY, JSON.stringify(state)) } catch { /* Quota/private mode: memory still works. */ } }
  function find(id: string) {
    const entry = state.entries.find((item) => item.id === id && !item.removed)
    if (!entry) return fail(404, 'NOT_FOUND', '演示任务不存在。')
    return entry
  }
  function job(entry: Entry): GenerationJobDto {
    const age = Math.max(0, now() - entry.at)
    const status = entry.canceled ? 'canceled' : age >= MOCK_JOB_SUCCEEDED_MS ? 'succeeded' : age >= MOCK_JOB_RUNNING_MS ? 'running' : 'queued'
    const completedAt = new Date(entry.at + MOCK_JOB_SUCCEEDED_MS).toISOString()
    const sizeIndex = MOCK_MODEL.sizes.indexOf(String(entry.request.parameters.size ?? MOCK_MODEL.defaults.size))
    const outputs = status === 'succeeded'
      ? Array.from({ length: Number(entry.request.parameters.count ?? 1) }, (_, index) => {
        const asset = mockSampleAsset(`${entry.id}-sample-${index}`, sizeIndex, entry.request.prompt, completedAt)
        return { mediaKind: 'image' as const, assetId: asset.id, url: asset.url, downloadUrl: asset.downloadUrl, metadata: { width: asset.width, height: asset.height, format: 'webp', sample: true } }
      }) : []
    return {
      id: entry.id, createdBy: 'local-preview', modelId: MOCK_MODEL.id, modelName: MOCK_MODEL.displayName,
      mediaKind: 'image', phase: null, title: '本地样片演示（非真实生成）', prompt: entry.request.prompt,
      inputPrompt: entry.request.prompt, parameters: copy(entry.request.parameters),
      size: String(entry.request.parameters.size ?? MOCK_MODEL.defaults.size), count: Number(entry.request.parameters.count ?? 1),
      status, progress: status === 'succeeded' ? 100 : status === 'running' ? 55 : 0,
      createdAt: new Date(entry.at).toISOString(),
      ...(age >= MOCK_JOB_RUNNING_MS ? { startedAt: new Date(entry.at + MOCK_JOB_RUNNING_MS).toISOString() } : {}),
      ...(status === 'succeeded' ? { completedAt } : {}), outputs,
    }
  }
  function assets() {
    const generated = state.entries.filter((entry) => !entry.removed).flatMap((entry) => job(entry).outputs.map((output) => ({
      ...mockSampleAsset(output.assetId, MOCK_MODEL.sizes.indexOf(String(entry.request.parameters.size ?? MOCK_MODEL.defaults.size)), entry.request.prompt, new Date(entry.at + MOCK_JOB_SUCCEEDED_MS).toISOString()),
    })))
    return [...generated, ...mockSeedAssets().filter((asset) => !state.removedSeeds.includes(asset.id))]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }
  return {
    models: { list: async () => copy([MOCK_MODEL]) },
    generations: { create: async (request: CreateGenerationRequest): Promise<GenerationJobDto> => {
      validateRequest(request)
      if (request.idempotencyKey) {
        const previous = state.entries.find((entry) => entry.request.idempotencyKey === request.idempotencyKey)
        if (previous) {
          if (previous.removed || requestIdentity(previous.request) !== requestIdentity(request)) return fail(409, 'IDEMPOTENCY_CONFLICT', '该演示请求标识已使用。')
          return job(previous)
        }
      }
      if (state.entries.length >= 200) return fail(409, 'MOCK_LIMIT', '本地演示已达 200 个任务上限，请清理演示存储后重试。')
      const entry: Entry = { id: `mock-job-${state.nextId++}`, request: copy(request), at: now() }
      state.entries.unshift(entry)
      save()
      return job(entry)
    } },
    jobs: {
      list: async (params?: { status?: string }): Promise<GenerationJobListDto> => {
        const items = state.entries.filter((entry) => !entry.removed).map(job)
          .filter((item) => !params?.status || (params.status === 'active' ? ['queued', 'running', 'retry_wait'].includes(item.status) : item.status === params.status))
        return { items: items.slice(0, 50), total: items.length, hasMore: items.length > 50 }
      },
      detail: async (id: string) => job(find(id)),
      cancel: async (id: string) => {
        const entry = find(id)
        if (!['queued', 'running'].includes(job(entry).status)) return fail(409, 'JOB_NOT_ACTIVE', '只能取消进行中的演示任务。')
        entry.canceled = true; save(); return job(entry)
      },
      retry: async (id: string) => {
        const entry = find(id)
        if (!entry.canceled) return fail(409, 'JOB_NOT_RETRYABLE', '只能重试已取消的演示任务。')
        entry.canceled = false; entry.at = now(); save(); return job(entry)
      },
      remove: async (id: string) => { find(id).removed = true; save(); return { deleted: true } },
    },
    library: {
      list: async (params?: { limit?: number; cursor?: string; q?: string; kind?: 'image' | 'video'; eligible?: boolean }): Promise<AssetListDto> => {
        const q = params?.q?.trim().toLocaleLowerCase()
        const items = assets().filter((asset) => (!params?.kind || asset.mediaKind === params.kind) &&
          (!q || asset.prompt.toLocaleLowerCase().includes(q)) &&
          (!params?.eligible || ['image/png', 'image/jpeg'].includes(asset.mimeType)))
        const limit = params?.limit === undefined ? 30 : params.limit
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(400, 'INVALID_LIMIT', '分页数量必须为 1–100。')
        let start = 0
        if (params?.cursor) {
          const position = items.findIndex((item) => `mock-cursor:${item.createdAt}:${item.id}` === params.cursor)
          if (position < 0) return fail(400, 'INVALID_CURSOR', '演示分页已变化，请刷新列表。')
          start = position + 1
        }
        const page = items.slice(start, start + limit)
        const hasMore = start + page.length < items.length
        const last = page.at(-1)
        return { items: page, total: items.length, hasMore, ...(hasMore && last ? { nextCursor: `mock-cursor:${last.createdAt}:${last.id}` } : {}) }
      },
      download: async (id: string) => {
        const asset = assets().find((item) => item.id === id)
        if (!asset) return fail(404, 'NOT_FOUND', '演示样片不存在。')
        return { url: asset.url, downloadUrl: asset.downloadUrl, mediaKind: asset.mediaKind, mimeType: asset.mimeType }
      },
      remove: async (id: string) => {
        if (!assets().some((asset) => asset.id === id)) return fail(404, 'NOT_FOUND', '演示样片不存在。')
        const entry = state.entries.find((item) => job(item).outputs.some((output) => output.assetId === id))
        // Match existing hooks: deleting an output removes the associated job and its outputs.
        if (entry) entry.removed = true
        else state.removedSeeds.push(id)
        save(); return { deleted: true }
      },
    },
  }
}

export type MockWorkspaceApi = ReturnType<typeof createMockWorkspaceApi>
let browserApi: MockWorkspaceApi | undefined
function browserMock(): MockWorkspaceApi {
  if (typeof window === 'undefined') return fail(400, 'MOCK_BROWSER_ONLY', '演示状态仅在浏览器内可用。')
  if (!browserApi) {
    let storage: Storage | undefined
    try { storage = window.localStorage } catch { /* Browser storage disabled. */ }
    browserApi = createMockWorkspaceApi({ storage })
  }
  return browserApi
}

/** Lazy facade: module evaluation during SSR never creates visitor-shared state. */
export const mockWorkspaceApi: MockWorkspaceApi = {
  models: { list: () => browserMock().models.list() },
  generations: { create: (body) => browserMock().generations.create(body) },
  jobs: {
    list: (params) => browserMock().jobs.list(params), detail: (id) => browserMock().jobs.detail(id),
    cancel: (id) => browserMock().jobs.cancel(id), retry: (id) => browserMock().jobs.retry(id), remove: (id) => browserMock().jobs.remove(id),
  },
  library: { list: (params) => browserMock().library.list(params), download: (id) => browserMock().library.download(id), remove: (id) => browserMock().library.remove(id) },
}
