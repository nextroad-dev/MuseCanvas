'use client'

// 本地演示用的 API 拦截层：`WORKSPACE_MODE === 'mock'` 时，所有 `/api/**`
// 浏览器请求都在这里返回内存 fixture，绝不触网。studio 已有专用 mock 适配器，
// 本模块补齐 session / account / setup / admin 全量页面。
//
// 数据只存在于当前页面会话：刷新会重置；mutation 会即时修改内存并让
// TanStack Query 重新拉取，足以演示表格、状态切换、设置保存等交互。

import type { PromptTemplateEntryDto, SetupStatusResponse } from '@musecanvas/contracts'
import type { ApiRequestInit } from './api'
import { MOCK_OAUTH_IDENTITIES, MOCK_SESSION_USER, MOCK_SETUP_COMPLETED_AT } from './mock-identity'
import type {
  AdminDashboardDto,
  AdminJobDto,
  AdminModelDto,
  AdminModelInput,
  AdminOAuthProviderDto,
  AdminPluginDeleteResult,
  AdminPluginDocsDto,
  AdminPluginDto,
  AdminPluginUploadResult,
  AdminPluginValidateResult,
  AdminUserDto,
  InvitationDto,
  MediaModelDefaultsDto,
  ModelPresetDto,
  OAuthProvider,
  PromptOptimizationSettingsDto,
  PromptTemplateSetDetailDto,
  PromptTemplateSetSummaryDto,
  ProviderCredentialDto,
  ProviderCredentialInput,
  RegistrationModeDto,
  SessionDto,
  SetupDatabaseTestResult,
  SetupStorageTestResult,
  SetupSmtpTestResult,
  SiteSettingsDto,
  SmtpSettingsDto,
  StorageSettingsDto,
  RuntimeSettingsDto,
  SetupConfigDto,
} from '@/shared/types'

const now = '2026-11-20T09:00:00.000Z'
const day = (offset: number) => new Date(Date.parse(now) - offset * 86_400_000).toISOString().slice(0, 10)
const uuid = () => globalThis.crypto.randomUUID()

// ---------------------------------------------------------------------------
// 后台 fixture
// ---------------------------------------------------------------------------

const users: AdminUserDto[] = [
  MOCK_SESSION_USER,
  { id: '00000000-0000-4000-8000-00000000a002', email: 'lin@example.invalid', role: 'user', status: 'active', createdAt: '2026-10-03T10:00:00.000Z' },
  { id: '00000000-0000-4000-8000-00000000a003', email: 'mira@example.invalid', role: 'user', status: 'disabled', createdAt: '2026-10-08T11:20:00.000Z' },
  { id: '00000000-0000-4000-8000-00000000a004', email: 'studio@example.invalid', role: 'user', status: 'active', createdAt: '2026-11-01T02:10:00.000Z' },
]

const invitations: InvitationDto[] = [
  { id: '00000000-0000-4000-8000-00000000c001', code: 'MUSE-DEMO-2026', used: false, createdAt: '2026-11-10T03:00:00.000Z' },
  { id: '00000000-0000-4000-8000-00000000c002', code: 'MUSE-USED-0001', used: true, createdAt: '2026-10-20T04:00:00.000Z' },
]

const jobs: AdminJobDto[] = [
  { id: '00000000-0000-4000-8000-00000000d001', createdBy: 'lin@example.invalid', modelId: 'seedream-4-5', modelName: 'Seedream 4.5', mediaKind: 'image', providerId: 'volcengine', pluginId: 'seedream-image', pluginVersion: '1.1.0', phase: 'completed', progress: 100, status: 'succeeded', durationMs: 18_400, createdAt: '2026-11-20T07:10:00.000Z', completedAt: '2026-11-20T07:10:18.000Z' },
  { id: '00000000-0000-4000-8000-00000000d002', createdBy: 'studio@example.invalid', modelId: 'seedance-1-0', modelName: 'Seedance 2.0 Fast', mediaKind: 'video', providerId: 'volcengine', pluginId: 'seedance-video', pluginVersion: '1.0.0', phase: 'polling', progress: 42, status: 'running', createdAt: '2026-11-20T06:42:00.000Z' },
  { id: '00000000-0000-4000-8000-00000000d003', createdBy: 'mira@example.invalid', modelId: 'veo-3-1', modelName: 'Veo 3.1', mediaKind: 'video', providerId: 'google', pluginId: 'veo-video', pluginVersion: '1.0.0', phase: 'failed', status: 'failed', errorCode: 'PROVIDER_TIMEOUT', durationMs: 300_000, createdAt: '2026-11-19T15:20:00.000Z', completedAt: '2026-11-19T15:25:00.000Z' },
  { id: '00000000-0000-4000-8000-00000000d004', createdBy: 'lin@example.invalid', modelId: 'seedream-4-5', modelName: 'Seedream 4.5', mediaKind: 'image', providerId: 'volcengine', pluginId: 'seedream-image', pluginVersion: '1.1.0', phase: 'queued', progress: 0, status: 'queued', createdAt: '2026-11-20T08:30:00.000Z' },
  { id: '00000000-0000-4000-8000-00000000d005', createdBy: 'studio@example.invalid', modelId: 'seedream-4-5', modelName: 'Seedream 4.5', mediaKind: 'image', providerId: 'volcengine', pluginId: 'seedream-image', pluginVersion: '1.1.0', phase: 'completed', progress: 100, status: 'succeeded', durationMs: 22_100, createdAt: '2026-11-18T09:00:00.000Z', completedAt: '2026-11-18T09:00:22.000Z' },
]

function mediaModel(over: Partial<AdminModelDto> & Pick<AdminModelDto, 'id' | 'displayName' | 'modelKind'>): AdminModelDto {
  return {
    providerId: 'volcengine',
    pluginId: 'seedream-image',
    pluginVersion: '1.1.0',
    modes: ['text_to_image', 'image_to_image'],
    parameters: [],
    inputSlots: [],
    defaults: {},
    maxCount: 4,
    maxInputImages: 4,
    supportedMediaKinds: ['image'],
    adapter: 'seedream',
    sizes: ['2048x2048'],
    qualityOptions: ['high'],
    enabled: true,
    sortOrder: 0,
    isDefault: false,
    vendorModelId: 'doubao-seedream-4-5-251128',
    baseUrl: 'https://ark.cn-beijing.volces.com',
    concurrencyLimit: 2,
    watermark: false,
    revision: 1,
    latestRevisionId: `rev-${over.id}`,
    providerCredentialId: '00000000-0000-4000-8000-00000000e001',
    providerCredentialName: '火山方舟 · 默认',
    ...over,
  }
}

const models: AdminModelDto[] = [
  mediaModel({ id: 'seedream-4-5', displayName: 'Seedream 4.5', modelKind: 'image', isDefault: true, sortOrder: 0 }),
  mediaModel({ id: 'gpt-image-2', displayName: 'GPT Image 2', modelKind: 'image', providerId: 'openai', pluginId: 'openai-image', pluginVersion: '1.1.0', adapter: 'openai', vendorModelId: 'gpt-image-2', baseUrl: 'https://api.openai.com', sortOrder: 1 }),
  mediaModel({ id: 'seedance-1-0', displayName: 'Seedance 2.0 Fast', modelKind: 'video', pluginId: 'seedance-video', pluginVersion: '1.0.0', adapter: 'seedance', modes: ['text_to_video', 'image_to_video'], supportedMediaKinds: ['video'], sizes: [], vendorModelId: 'doubao-seedance-2-0-fast-260128', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', isDefault: true, sortOrder: 2 }),
  mediaModel({ id: 'veo-3-1', displayName: 'Veo 3.1', modelKind: 'video', providerId: 'google', pluginId: 'veo-video', pluginVersion: '1.0.0', adapter: 'veo', modes: ['text_to_video', 'image_to_video'], supportedMediaKinds: ['video'], sizes: [], vendorModelId: 'veo-3.1-generate-001', baseUrl: 'https://us-central1-aiplatform.googleapis.com', sortOrder: 3 }),
  mediaModel({ id: 'gpt-5-5', displayName: 'GPT-5.5', modelKind: 'language', providerId: 'openai', pluginId: 'openai-language', pluginVersion: '1.0.0', adapter: 'openai', modes: [], supportedMediaKinds: [], sizes: [], maxCount: 0, maxInputImages: 0, vendorModelId: 'gpt-5.5', baseUrl: 'https://api.openai.com', languageProtocol: 'openai_chat', maxOutputTokens: 25_000, temperature: 0.7, reasoningEffort: 'medium', sortOrder: 4 }),
]

const presets: ModelPresetDto[] = [
  { id: 'seedream-4-5', modelKind: 'image', displayName: 'Seedream 4.5', adapter: 'seedream', providerId: 'volcengine', pluginId: 'seedream-image', pluginVersion: '1.1.0', vendorModelId: 'doubao-seedream-4-5-251128', baseUrl: 'https://ark.cn-beijing.volces.com', concurrencyLimit: 1 },
  { id: 'seedance-1-0', modelKind: 'video', displayName: 'Seedance 2.0 Fast', adapter: 'seedance', providerId: 'volcengine', pluginId: 'seedance-video', pluginVersion: '1.0.0', vendorModelId: 'doubao-seedance-2-0-fast-260128', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', concurrencyLimit: 1 },
  { id: 'gpt-image-2', modelKind: 'image', displayName: 'GPT Image 2', adapter: 'openai', providerId: 'openai', pluginId: 'openai-image', pluginVersion: '1.1.0', vendorModelId: 'gpt-image-2', baseUrl: 'https://api.openai.com', concurrencyLimit: 1 },
]

const credentials: ProviderCredentialDto[] = [
  { id: '00000000-0000-4000-8000-00000000e001', displayName: '火山方舟 · 默认', providerId: 'volcengine', schemaId: 'ark-api-key-v1', schemaVersion: 1, adapter: 'volcengine', baseUrl: 'https://ark.cn-beijing.volces.com', enabled: true, hasCredential: true, hasApiKey: true, keyFingerprint: 'demo…0001', configuredFields: { region: 'cn-beijing' }, lastTestStatus: 'success', lastTestedAt: '2026-11-19T10:00:00.000Z', updatedAt: now },
  { id: '00000000-0000-4000-8000-00000000e002', displayName: 'OpenAI · 演示', providerId: 'openai', schemaId: 'openai-api-key-v1', schemaVersion: 1, adapter: 'openai', baseUrl: 'https://api.openai.com', enabled: true, hasCredential: true, hasApiKey: true, keyFingerprint: 'demo…0002', configuredFields: {}, lastTestStatus: 'not_tested', updatedAt: now },
  { id: '00000000-0000-4000-8000-00000000e003', displayName: 'Google Vertex · 演示', providerId: 'google', schemaId: 'google-service-account-v1', schemaVersion: 1, adapter: 'google', baseUrl: 'https://us-central1-aiplatform.googleapis.com', enabled: false, hasCredential: true, hasApiKey: false, keyFingerprint: 'demo…0003', configuredFields: { projectId: 'musecanvas-demo' }, lastTestStatus: 'failed', lastTestErrorCode: 'CREDENTIAL_INVALID', lastTestedAt: '2026-11-18T08:00:00.000Z', updatedAt: now },
]

const plugins: AdminPluginDto[] = [
  { id: '00000000-0000-4000-8000-00000000f001', pluginId: 'seedream-image', pluginVersion: '1.1.0', kind: 'media', displayName: 'Seedream 图像', description: '火山方舟 Seedream 图像模型适配器', status: 'active', source: 'builtin', allowedHosts: ['ark.cn-beijing.volces.com'], credentialSchemas: ['ark-api-key-v1'], modalities: ['image'], languageProtocols: [], manifest: {}, artifactDigest: 'a'.repeat(64), artifactSizeBytes: 48_213, packageFormat: 'zip-v1', packageDigest: 'b'.repeat(64), packageFiles: [], packageMeta: { author: 'MuseCanvas' }, hasIcon: true, docs: { readme: true, changelog: true, licenseText: false }, scanReport: [], errorCode: null, errorMessage: null, createdAt: '2026-10-01T08:00:00.000Z', updatedAt: now },
  { id: '00000000-0000-4000-8000-00000000f002', pluginId: 'veo-video', pluginVersion: '1.0.0', kind: 'media', displayName: 'Veo 视频', description: 'Google Veo 视频模型适配器', status: 'disabled', source: 'uploaded', allowedHosts: ['us-central1-aiplatform.googleapis.com'], credentialSchemas: ['google-service-account-v1'], modalities: ['video'], languageProtocols: [], manifest: {}, artifactDigest: 'c'.repeat(64), artifactSizeBytes: 61_002, packageFormat: 'zip-v1', packageDigest: 'd'.repeat(64), packageFiles: [], packageMeta: { author: 'MuseCanvas' }, hasIcon: false, docs: { readme: false, changelog: false, licenseText: false }, scanReport: [], errorCode: null, errorMessage: null, createdAt: '2026-10-12T08:00:00.000Z', updatedAt: now },
]

const oauthProviders: AdminOAuthProviderDto[] = [
  { provider: 'github', label: 'GitHub', enabled: true, configuredInDatabase: true, source: 'database', clientId: 'Iv1.demo0000000000', hasClientSecret: true, redirectUri: 'http://localhost:3100/api/auth/oauth/github/callback' },
  { provider: 'google', label: 'Google', enabled: false, configuredInDatabase: false, source: 'none', clientId: '', hasClientSecret: false, redirectUri: 'http://localhost:3100/api/auth/oauth/google/callback' },
]

const promptSetId = '00000000-0000-4000-8000-000000010001'
const promptEntries: PromptTemplateEntryDto[] = [
  { id: '00000000-0000-4000-8000-000000011001', setId: promptSetId, name: '写实摄影', description: '把一句话扩写成写实摄影提示词', path: 'photography/realistic.md', instruction: '将用户描述扩展为写实摄影提示词，强调光线、镜头与材质。', contentSha256: 'e'.repeat(64), sortOrder: 0, createdAt: now },
  { id: '00000000-0000-4000-8000-000000011002', setId: promptSetId, name: '电影感画面', description: '电影分镜与色彩风格', path: 'cinema/frame.md', instruction: '按电影分镜描述主体、景别、色温与氛围。', contentSha256: 'f'.repeat(64), sortOrder: 1, createdAt: now },
  { id: '00000000-0000-4000-8000-000000011003', setId: promptSetId, name: '国风插画', description: '东方美学与留白', path: 'illustration/guofeng.md', instruction: '使用东方美学、留白与工笔/写意结合的视觉语言。', contentSha256: '1'.repeat(64), sortOrder: 2, createdAt: now },
]
const promptSets: PromptTemplateSetDetailDto[] = [
  { id: promptSetId, name: '演示提示词集', version: 3, isActive: true, entryCount: promptEntries.length, contentDigest: 'a'.repeat(64), createdBy: MOCK_SESSION_USER.id, createdAt: '2026-10-05T08:00:00.000Z', updatedAt: now, entries: promptEntries },
  { id: '00000000-0000-4000-8000-000000010002', name: '经典 V2', version: 2, isActive: false, entryCount: 2, contentDigest: 'b'.repeat(64), createdBy: MOCK_SESSION_USER.id, createdAt: '2026-09-20T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z', entries: [] },
]

const site: SiteSettingsDto = { siteName: 'MuseCanvas 演示站', siteUrl: 'http://localhost:3100', revision: 4, updatedAt: now }
const smtp: SmtpSettingsDto = { host: 'smtp.example.invalid', port: 587, tlsMode: 'starttls', username: 'demo', fromAddress: 'no-reply@example.invalid', fromName: 'MuseCanvas', hasSecret: true, secretFingerprint: 'demo…smtp', encryptionKeyId: null, status: 'configured', revision: 2, updatedAt: now }
const storage: StorageSettingsDto = { driver: 'local', localRoot: '/data/media', endpoint: null, publicEndpoint: null, region: '', bucket: null, accessKeyId: null, signedUrlTtlSeconds: 900, hasSecret: false, secretFingerprint: null, encryptionKeyId: null, status: 'configured', revision: 3, updatedAt: now }
const runtime: RuntimeSettingsDto = { uploadTtlSeconds: 86_400, signedUrlTtlSeconds: 900, maxImageBytes: 10_000_000, maxTotalBytes: 20_000_000, maxInputs: 4, providerTimeoutMs: 300_000, maxOutputBytes: 100_000_000, jobLeaseMs: 600_000, revision: 5, updatedAt: now }
const database = { driver: 'postgres' as const, availableDrivers: [{ id: 'postgres' as const, label: 'PostgreSQL', available: true }, { id: 'sqlite' as const, label: 'SQLite', available: false, reason: '后端尚未支持' }], connection: { host: '127.0.0.1', port: 5432, database: 'musecanvas', user: 'fixture' }, serverVersion: 'PostgreSQL 17.12', schemaVersion: '0047', reachable: true }

let registration: RegistrationModeDto = { requiresInvitation: false }
let promptOptimization: PromptOptimizationSettingsDto = { enabled: false, allowUserReadFinalPrompt: true, languageModelConfigId: null, timeoutMs: 600_000, updatedAt: now }
let mediaDefaults: MediaModelDefaultsDto = { imageModelId: 'seedream-4-5', videoModelId: 'seedance-1-0', updatedAt: now }
const status: SetupStatusResponse = {
  setupComplete: true,
  status: 'complete',
  sections: Object.fromEntries(['bootstrap', 'site', 'smtp', 'admin', 'storage', 'providers', 'models', 'oauth', 'templates', 'runtime'].map(key => [key, { status: 'complete', updatedAt: now }])) as SetupStatusResponse['sections'],
  bootstrap: null,
  configRevision: 8,
  completedAt: MOCK_SETUP_COMPLETED_AT,
  claimRequired: false,
}

function setupConfig(): SetupConfigDto {
  return {
    site, smtp, storage, runtime, database,
    templates: { active: { id: promptSetId, name: '演示提示词集', version: 3, entryCount: promptEntries.length, updatedAt: now }, entries: promptEntries.map(entry => ({ name: entry.name, description: entry.description, path: entry.path ?? '' })) },
  }
}

const DEMO_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#E8F0E6"/><path d="M14 44V20h7l11 14 11-14h7v24h-6V30l-9 11h-6l-9-11v14z" fill="#2F5D3A"/></svg>')}`
export function mockPluginIconUrl(): string { return DEMO_ICON }

export function mockPromptExportUrl(): string {
  const payload = { name: '演示提示词集', version: 3, templates: promptEntries.map(entry => ({ name: entry.name, description: entry.description, instruction: entry.instruction, path: entry.path, sortOrder: entry.sortOrder })) }
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`
}

function notFound(path: string, method: string): never {
  throw new Error(`MOCK_UNHANDLED: ${method} ${path}`)
}

function mergeModel(input: AdminModelInput, existing?: AdminModelDto): AdminModelDto {
  const base = existing ?? mediaModel({ id: input.id ?? uuid(), displayName: input.displayName ?? '演示模型', modelKind: (input.modelKind ?? 'image') as AdminModelDto['modelKind'] })
  return {
    ...base,
    ...(input.presetId ? { presetId: input.presetId } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.vendorModelId ? { vendorModelId: input.vendorModelId } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.concurrencyLimit ? { concurrencyLimit: input.concurrencyLimit } : {}),
    ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.watermark !== undefined ? { watermark: input.watermark } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.providerCredentialId !== undefined ? { providerCredentialId: input.providerCredentialId ?? undefined } : {}),
    ...(input.languageProtocol ? { languageProtocol: input.languageProtocol } : {}),
    ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    revision: (base.revision ?? 1) + 1,
    latestRevisionId: `rev-${uuid()}`,
  }
}

function mergeCredential(input: ProviderCredentialInput, existing?: ProviderCredentialDto): ProviderCredentialDto {
  const base = existing ?? {
    id: uuid(), displayName: input.displayName ?? '演示凭据', schemaId: input.schemaId ?? 'openai-api-key-v1', schemaVersion: input.schemaVersion ?? 1,
    baseUrl: input.baseUrl ?? '', enabled: true, hasCredential: true, hasApiKey: true, configuredFields: {}, lastTestStatus: 'not_tested' as const, updatedAt: now,
  }
  return {
    ...base,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.schemaId ? { schemaId: input.schemaId } : {}),
    ...(input.schemaVersion ? { schemaVersion: input.schemaVersion } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl ?? '' } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.secret !== undefined ? { hasCredential: true, hasApiKey: true, keyFingerprint: `demo…${uuid().slice(0, 4)}` } : {}),
    updatedAt: now,
  }
}

function upsertSet(setId: string, mutate: (set: PromptTemplateSetDetailDto) => void): PromptTemplateSetDetailDto {
  const set = promptSets.find(item => item.id === setId)
  if (!set) throw new Error('演示数据中没有该模板集')
  mutate(set)
  set.entryCount = set.entries.length
  set.updatedAt = now
  return set
}

export async function mockApiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET'
  const params = init.params ?? {}
  const body = init.body
  const ok = <V>(value: V) => Promise.resolve(value as unknown as T)

  // session / auth / account
  if (method === 'GET' && path === '/api/session') return ok({ user: MOCK_SESSION_USER } satisfies SessionDto)
  if (method === 'POST' && path === '/api/auth/logout') return ok({ loggedOut: true })
  if (method === 'GET' && path === '/api/registration') return ok(registration)
  if (method === 'GET' && path === '/api/auth/oauth/providers') return ok({ providers: oauthProviders.map(({ provider, label, enabled }) => ({ provider, label, enabled })) })
  if (method === 'POST' && (path === '/api/auth/otp/request' || path === '/api/auth/otp/verify' || path === '/api/auth/oauth/invitation')) return ok({ user: MOCK_SESSION_USER, setupRequired: false })
  if (method === 'GET' && path === '/api/account/oauth') return ok(MOCK_OAUTH_IDENTITIES)
  if (method === 'DELETE' && /^\/api\/account\/oauth\/[^/]+$/.test(path)) return ok({ unlinked: true })

  // setup
  if (method === 'GET' && path === '/api/setup/status') return ok(status)
  if (method === 'GET' && path === '/api/setup/config') return ok(setupConfig())
  if (method === 'GET' && path === '/api/setup/database') return ok(database)
  if (method === 'POST' && path === '/api/setup/database/test') return ok({ ok: true, errorCode: null, driver: 'postgres', availableDrivers: database.availableDrivers, connection: database.connection, serverVersion: database.serverVersion, schemaVersion: database.schemaVersion, reachable: true } satisfies SetupDatabaseTestResult)
  if (method === 'POST' && path === '/api/setup/site') { Object.assign(site, body as object, { revision: site.revision + 1, updatedAt: now }); return ok(site) }
  if (method === 'POST' && path === '/api/setup/smtp') { Object.assign(smtp, body as object, { revision: smtp.revision + 1, updatedAt: now }); return ok(smtp) }
  if (method === 'POST' && path === '/api/setup/storage') { Object.assign(storage, body as object, { revision: storage.revision + 1, updatedAt: now }); return ok(storage) }
  if (method === 'POST' && path === '/api/setup/runtime') { Object.assign(runtime, body as object, { revision: runtime.revision + 1, updatedAt: now }); return ok(runtime) }
  if (method === 'POST' && path === '/api/setup/smtp/test') return ok({ verified: true, settings: smtp } satisfies SetupSmtpTestResult)
  if (method === 'POST' && path === '/api/setup/storage/test') return ok({ verified: true, settings: storage } satisfies SetupStorageTestResult)

  // admin: dashboard / registration / users / jobs / invitations
  if (method === 'GET' && path === '/api/admin/dashboard') {
    const dashboard: AdminDashboardDto = { totalUsers: users.length, totalJobs: 1_284, failedJobs7d: 7, successRate7d: 96.8, days: Array.from({ length: 7 }, (_, index) => ({ date: day(6 - index), total: 120 + index * 9, succeeded: 112 + index * 8, failed: 8 - Math.floor(index / 3) })) }
    return ok(dashboard)
  }
  if (method === 'GET' && path === '/api/admin/registration') return ok(registration)
  if (method === 'PATCH' && path === '/api/admin/registration') { registration = { requiresInvitation: Boolean((body as { requiresInvitation?: boolean }).requiresInvitation) }; return ok(registration) }
  if (method === 'GET' && path === '/api/admin/users') {
    const statusFilter = typeof params.status === 'string' ? params.status : ''
    const email = typeof params.email === 'string' ? params.email.toLowerCase() : ''
    const items = users.filter(user => (!statusFilter || user.status === statusFilter) && (!email || user.email.toLowerCase().includes(email)))
    return ok({ items, total: items.length, hasMore: false })
  }
  if (method === 'PATCH' && /^\/api\/admin\/users\/[^/]+\/status$/.test(path)) {
    const id = path.split('/')[4]
    const target = users.find(user => user.id === id)
    if (!target) throw new Error('演示数据中没有该用户')
    target.status = (body as { status: AdminUserDto['status'] }).status
    return ok(target)
  }
  if (method === 'DELETE' && /^\/api\/admin\/users\/[^/]+$/.test(path)) {
    const id = path.split('/')[4]
    const index = users.findIndex(user => user.id === id)
    if (index >= 0) users.splice(index, 1)
    return ok({ deleted: true })
  }
  if (method === 'GET' && path === '/api/admin/jobs') {
    const statusFilter = typeof params.status === 'string' ? params.status : ''
    const items = jobs.filter(job => !statusFilter || job.status === statusFilter)
    return ok({ items, total: items.length, hasMore: false })
  }
  if (method === 'GET' && path === '/api/admin/invitations') return ok({ items: invitations, total: invitations.length, hasMore: false })
  if (method === 'POST' && path === '/api/admin/invitations') {
    const invitation: InvitationDto = { id: uuid(), code: `MUSE-DEMO-${String(invitations.length + 1).padStart(4, '0')}`, used: false, createdAt: now }
    invitations.unshift(invitation)
    return ok(invitation)
  }
  if (method === 'DELETE' && /^\/api\/admin\/invitations\/[^/]+$/.test(path)) {
    const id = path.split('/')[4]
    const index = invitations.findIndex(invitation => invitation.id === id)
    if (index >= 0) invitations.splice(index, 1)
    return ok({ revoked: true })
  }

  // admin: models / presets / media defaults
  if (method === 'GET' && path === '/api/admin/models') return ok(models)
  if (method === 'POST' && path === '/api/admin/models') { const model = mergeModel(body as AdminModelInput); models.push(model); return ok(model) }
  if (method === 'PATCH' && /^\/api\/admin\/models\/[^/]+$/.test(path)) {
    const id = path.split('/')[4]
    const index = models.findIndex(model => model.id === id)
    if (index < 0) throw new Error('演示数据中没有该模型')
    models[index] = mergeModel(body as AdminModelInput, models[index])
    return ok(models[index])
  }
  if (method === 'DELETE' && /^\/api\/admin\/models\/[^/]+$/.test(path)) {
    const id = path.split('/')[4]
    const index = models.findIndex(model => model.id === id)
    if (index >= 0) models.splice(index, 1)
    return ok({ deleted: true })
  }
  if (method === 'GET' && path === '/api/admin/model-presets') return ok(presets)
  if (method === 'GET' && path === '/api/models') return ok(models.filter(model => model.modelKind !== 'language'))
  if (method === 'GET' && path === '/api/admin/media-model-defaults') return ok(mediaDefaults)
  if (method === 'PATCH' && path === '/api/admin/media-model-defaults') { mediaDefaults = { ...mediaDefaults, ...(body as object), updatedAt: now }; return ok(mediaDefaults) }

  // admin: provider credentials / templates
  if (method === 'GET' && path === '/api/admin/provider-credentials') return ok(credentials)
  if (method === 'POST' && path === '/api/admin/provider-credentials') { const credential = mergeCredential(body as ProviderCredentialInput); credentials.push(credential); return ok(credential) }
  if (method === 'PATCH' && /^\/api\/admin\/provider-credentials\/[^/]+$/.test(path)) {
    const id = path.split('/')[4]
    const index = credentials.findIndex(credential => credential.id === id)
    if (index < 0) throw new Error('演示数据中没有该凭据')
    credentials[index] = mergeCredential(body as ProviderCredentialInput, credentials[index])
    return ok(credentials[index])
  }
  if (method === 'DELETE' && /^\/api\/admin\/provider-credentials\/[^/]+$/.test(path)) {
    const id = path.split('/')[4]
    const index = credentials.findIndex(credential => credential.id === id)
    if (index >= 0) credentials.splice(index, 1)
    return ok({ deleted: true })
  }
  if (method === 'POST' && /^\/api\/admin\/provider-credentials\/[^/]+\/test$/.test(path)) {
    const id = path.split('/')[4]
    const target = credentials.find(credential => credential.id === id)
    if (target) { target.lastTestStatus = 'success'; target.lastTestedAt = now }
    return ok({ tested: true, status: 'success' as const })
  }
  if (method === 'GET' && path === '/api/admin/provider-templates') return ok({ templates: [
    { key: 'openai', pluginId: 'openai-image', pluginVersion: '1.1.0', providerId: 'openai', adapter: 'openai', displayName: 'OpenAI', description: 'OpenAI 图像与语言模型', modality: 'image', baseUrl: 'https://api.openai.com', credential: { schemaId: 'openai-api-key-v1', schemaVersion: 1, format: 'text', kind: 'api_key', label: 'API Key', placeholder: 'sk-…', baseUrlPolicy: 'fixed' }, presetIds: ['gpt-image-2'], models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }] },
    { key: 'volcengine', pluginId: 'seedream-image', pluginVersion: '1.1.0', providerId: 'volcengine', adapter: 'seedream', displayName: '火山方舟', description: '字节跳动火山方舟', modality: 'image', baseUrl: 'https://ark.cn-beijing.volces.com', credential: { schemaId: 'ark-api-key-v1', schemaVersion: 1, format: 'text', kind: 'api_key', label: 'ARK API Key', baseUrlPolicy: 'fixed' }, presetIds: ['seedream-4-5'], models: [{ id: 'seedream-4-5', name: 'Seedream 4.5' }] },
  ] })

  // admin: plugins
  if (method === 'GET' && path === '/api/admin/plugins') return ok(plugins)
  if (method === 'PATCH' && /^\/api\/admin\/plugins\/[^/]+$/.test(path)) {
    const id = path.split('/')[4]
    const target = plugins.find(plugin => plugin.id === id)
    if (!target) throw new Error('演示数据中没有该插件')
    target.status = (body as { status: 'active' | 'disabled' }).status
    target.updatedAt = now
    return ok(target)
  }
  if (method === 'DELETE' && /^\/api\/admin\/plugins\/[^/]+$/.test(path)) {
    const id = path.split('/')[4]
    const index = plugins.findIndex(plugin => plugin.id === id)
    if (index >= 0) plugins.splice(index, 1)
    return ok({ deleted: true, pinnedRevisionsRetainArtifact: false, note: '本地演示已移除；真实环境会保留在途任务所需的制品。' } satisfies AdminPluginDeleteResult)
  }
  if (method === 'GET' && /^\/api\/admin\/plugins\/[^/]+\/docs$/.test(path)) return ok({ readme: '# 演示插件\n\n这是本地 mock 的 README。', changelog: '## 1.1.0\n\n- 演示更新', licenseText: null } satisfies AdminPluginDocsDto)
  if (method === 'POST' && path === '/api/admin/plugins/validate') return ok({
    ok: true, pluginId: 'demo-uploaded', pluginVersion: '1.0.0', kind: 'media', displayName: '演示上传插件', modelIds: ['demo-model'],
    allowedHosts: ['api.example.invalid'], artifactDigest: 'a'.repeat(64), artifactSizeBytes: 12_345, packageFormat: 'zip-v1',
    packageDigest: 'b'.repeat(64), packageFiles: [], packageMeta: { author: 'Demo' }, hasIcon: false, warnings: [],
  } satisfies AdminPluginValidateResult)
  if (method === 'POST' && path === '/api/admin/plugins/upload') {
    const plugin: AdminPluginDto = { id: uuid(), pluginId: 'demo-uploaded', pluginVersion: '1.0.0', kind: 'media', displayName: '演示上传插件', description: '本地 mock 上传', status: 'active', source: 'uploaded', allowedHosts: ['api.example.invalid'], credentialSchemas: [], modalities: ['image'], languageProtocols: [], manifest: {}, artifactDigest: 'a'.repeat(64), artifactSizeBytes: 12_345, packageFormat: 'zip-v1', packageDigest: 'b'.repeat(64), packageFiles: [], packageMeta: { author: 'Demo' }, hasIcon: false, docs: { readme: false, changelog: false, licenseText: false }, scanReport: [], errorCode: null, errorMessage: null, createdAt: now, updatedAt: now }
    plugins.push(plugin)
    return ok({ installed: true, plugin, warnings: [] } satisfies AdminPluginUploadResult)
  }

  // admin: oauth
  if (method === 'GET' && path === '/api/admin/oauth-providers') return ok(oauthProviders)
  if (method === 'PATCH' && /^\/api\/admin\/oauth-providers\/[^/]+$/.test(path)) {
    const provider = path.split('/')[4] as OAuthProvider
    const target = oauthProviders.find(item => item.provider === provider)
    if (!target) throw new Error('演示数据中没有该 OAuth 供应商')
    const input = body as { clientId?: string; clientSecret?: string; enabled?: boolean }
    if (input.clientId !== undefined) target.clientId = input.clientId
    if (input.clientSecret !== undefined) target.hasClientSecret = Boolean(input.clientSecret)
    if (input.enabled !== undefined) target.enabled = input.enabled
    target.configuredInDatabase = true
    target.source = 'database'
    return ok(target)
  }

  // admin: prompt templates
  if (method === 'GET' && path === '/api/admin/prompt-templates') return ok(promptSets.find(set => set.isActive) ?? null)
  if (method === 'GET' && path === '/api/admin/prompt-templates/sets') return ok(promptSets.map((set): PromptTemplateSetSummaryDto => ({ id: set.id, name: set.name, version: set.version, isActive: set.isActive, entryCount: set.entryCount, contentDigest: set.contentDigest, createdBy: set.createdBy, createdAt: set.createdAt, updatedAt: set.updatedAt })))
  if (method === 'GET' && /^\/api\/admin\/prompt-templates\/sets\/[^/]+$/.test(path)) {
    const id = path.split('/')[5]
    const set = promptSets.find(item => item.id === id)
    if (!set) throw new Error('演示数据中没有该模板集')
    return ok(set)
  }
  if (method === 'POST' && /^\/api\/admin\/prompt-templates\/sets\/[^/]+\/activate$/.test(path)) {
    const id = path.split('/')[5]
    promptSets.forEach(set => { set.isActive = set.id === id })
    const set = promptSets.find(item => item.id === id)!
    return ok({ id: set.id, name: set.name, version: set.version, isActive: set.isActive, entryCount: set.entryCount, contentDigest: set.contentDigest, createdAt: set.createdAt, updatedAt: set.updatedAt } satisfies PromptTemplateSetSummaryDto)
  }
  if (method === 'POST' && /^\/api\/admin\/prompt-templates\/sets\/[^/]+\/entries$/.test(path)) {
    const id = path.split('/')[5]
    const input = body as { name: string; description?: string; instruction: string; sortOrder?: number }
    return ok(upsertSet(id, set => { set.entries.push({ id: uuid(), setId: id, name: input.name, description: input.description ?? '', instruction: input.instruction, contentSha256: 'c'.repeat(64), sortOrder: input.sortOrder ?? set.entries.length, createdAt: now }) }))
  }
  if (method === 'PATCH' && /^\/api\/admin\/prompt-templates\/entries\/[^/]+$/.test(path)) {
    const entryId = path.split('/')[5]
    const set = promptSets.find(item => item.entries.some(entry => entry.id === entryId))
    if (!set) throw new Error('演示数据中没有该模板条目')
    const input = body as { name?: string; description?: string; instruction?: string; sortOrder?: number }
    return ok(upsertSet(set.id, current => { const entry = current.entries.find(item => item.id === entryId)!; Object.assign(entry, input) }))
  }
  if (method === 'DELETE' && /^\/api\/admin\/prompt-templates\/entries\/[^/]+$/.test(path)) {
    const entryId = path.split('/')[5]
    const set = promptSets.find(item => item.entries.some(entry => entry.id === entryId))
    if (!set) throw new Error('演示数据中没有该模板条目')
    upsertSet(set.id, current => { const index = current.entries.findIndex(item => item.id === entryId); if (index >= 0) current.entries.splice(index, 1) })
    return ok({ deleted: true, setId: set.id })
  }
  if (method === 'DELETE' && /^\/api\/admin\/prompt-templates\/sets\/[^/]+$/.test(path)) {
    const id = path.split('/')[5]
    const set = promptSets.find(item => item.id === id)
    if (!set) throw new Error('演示数据中没有该模板集')
    if (set.isActive) throw new Error('不能删除启用中的模板集')
    promptSets.splice(promptSets.indexOf(set), 1)
    return ok({ deleted: true })
  }
  if (method === 'POST' && path === '/api/admin/prompt-templates/import') {
    const input = body as { name?: string; templates: Array<{ name: string; description?: string; instruction: string; path?: string; sortOrder?: number }> }
    const id = uuid()
    const set: PromptTemplateSetDetailDto = { id, name: input.name ?? '导入的模板集', version: 1, isActive: false, entryCount: input.templates.length, contentDigest: 'd'.repeat(64), createdBy: MOCK_SESSION_USER.id, createdAt: now, updatedAt: now, entries: input.templates.map((entry, index) => ({ id: uuid(), setId: id, name: entry.name, description: entry.description ?? '', instruction: entry.instruction, path: entry.path, contentSha256: 'e'.repeat(64), sortOrder: entry.sortOrder ?? index, createdAt: now })) }
    promptSets.push(set)
    return ok({ imported: true, setId: id, name: set.name, version: set.version, entryCount: set.entryCount, isActive: set.isActive })
  }
  if (method === 'POST' && path === '/api/admin/prompt-templates/preview') {
    const input = body as { instruction?: string; values?: Record<string, string | number> }
    return ok({ rendered: `${input.instruction ?? '演示模板'}\n\n变量：${JSON.stringify(input.values ?? {})}`, usedVariables: Object.keys(input.values ?? {}), hasUnresolvedVariables: false })
  }
  if (method === 'GET' && path === '/api/admin/prompt-optimization-settings') return ok(promptOptimization)
  if (method === 'PATCH' && path === '/api/admin/prompt-optimization-settings') { promptOptimization = { ...promptOptimization, ...(body as object), updatedAt: now }; return ok(promptOptimization) }

  return notFound(path, method)
}
