import type {
  User,
  ModelConfig,
  GenerationJob,
  Asset,
  Invitation,
  SmtpSettings,
  AdminUser,
  AdminModel,
  AdminJob,
  DashboardMetrics,
  ModelPreset,
} from '@/types'

// ── Auth ──────────────────────────────────────────────────

export const mockUser: User = {
  id: 'u-001',
  email: 'user@example.com',
  role: 'user',
  status: 'active',
  createdAt: '2026-01-15T08:00:00Z',
}

export const mockAdmin: User = {
  id: 'u-admin',
  email: 'admin@example.com',
  role: 'admin',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
}

// ── Auth ──────────────────────────────────────────────────

export const mockModels: ModelConfig[] = [
  {
    id: 'm-001',
    displayName: 'GPT Image 2',
    adapter: 'openai',
    vendorModelId: 'gpt-image-2',
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
    qualityOptions: ['low', 'medium', 'high', 'auto'],
    maxCount: 4,
    concurrencyLimit: 2,
    enabled: true,
    sortOrder: 1,
  },
  {
    id: 'm-002',
    displayName: 'Seedream 3.0',
    adapter: 'seedream',
    vendorModelId: 'seedream-3-0',
    sizes: ['1024x1024', '2048x2048'],
    maxCount: 4,
    concurrencyLimit: 3,
    enabled: true,
    sortOrder: 2,
  },
  {
    id: 'm-003',
    displayName: 'Seedream 4.0',
    adapter: 'seedream',
    vendorModelId: 'seedream-4-0',
    sizes: ['1024x1024', '2048x2048', '4096x4096'],
    maxCount: 2,
    concurrencyLimit: 1,
    enabled: false,
    sortOrder: 3,
  },
]

// ── Generation Jobs ───────────────────────────────────────

export const mockJobs: GenerationJob[] = [
  {
    id: 'j-001',
    createdBy: 'u-001',
    modelId: 'm-001',
    modelName: 'GPT Image 2',
    prompt: 'A serene mountain landscape at golden hour with mist in the valley',
    size: '1536x1024',
    quality: 'high',
    count: 1,
    status: 'succeeded',
    createdAt: '2026-06-20T10:30:00Z',
    startedAt: '2026-06-20T10:30:05Z',
    completedAt: '2026-06-20T10:30:42Z',
    outputs: [
      {
        id: 'o-001',
        assetId: 'a-001',
        imageUrl: 'https://picsum.photos/seed/mc1/800/600',
      },
    ],
  },
  {
    id: 'j-002',
    createdBy: 'u-001',
    modelId: 'm-002',
    modelName: 'Seedream 3.0',
    prompt: 'Cyberpunk city street at night, neon lights reflecting on wet pavement',
    size: '1024x1024',
    count: 2,
    status: 'running',
    createdAt: '2026-06-21T08:15:00Z',
    startedAt: '2026-06-21T08:15:03Z',
    outputs: [],
  },
  {
    id: 'j-003',
    createdBy: 'u-001',
    modelId: 'm-001',
    modelName: 'GPT Image 2',
    prompt: 'Minimalist still life, single flower in a white vase on marble',
    size: '1024x1024',
    quality: 'auto',
    count: 1,
    status: 'queued',
    createdAt: '2026-06-21T09:00:00Z',
    outputs: [],
  },
  {
    id: 'j-004',
    createdBy: 'u-001',
    modelId: 'm-001',
    modelName: 'GPT Image 2',
    prompt: 'Abstract watercolor pattern',
    size: '1024x1024',
    quality: 'medium',
    count: 1,
    status: 'failed',
    errorCode: 'CONTENT_POLICY_VIOLATION',
    createdAt: '2026-06-20T14:00:00Z',
    completedAt: '2026-06-20T14:00:12Z',
    outputs: [],
  },
]

// ── Assets / Library ──────────────────────────────────────

export const mockAssets: Asset[] = [
  {
    id: 'a-001',
    prompt: 'A serene mountain landscape at golden hour with mist in the valley',
    imageUrl: 'https://picsum.photos/seed/mc1/800/600',
    mimeType: 'image/png',
    width: 1536,
    height: 1024,
    sizeBytes: 2457600,
    createdAt: '2026-06-20T10:30:42Z',
  },
  {
    id: 'a-002',
    prompt: 'A serene mountain landscape at golden hour with mist in the valley',
    imageUrl: 'https://picsum.photos/seed/mc2/800/600',
    mimeType: 'image/png',
    width: 1536,
    height: 1024,
    sizeBytes: 2310400,
    createdAt: '2026-06-19T16:20:00Z',
  },
  {
    id: 'a-003',
    prompt: 'Futuristic space station orbiting a gas giant, cinematic lighting',
    imageUrl: 'https://picsum.photos/seed/mc3/800/600',
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    sizeBytes: 1980000,
    createdAt: '2026-06-18T12:00:00Z',
  },
  {
    id: 'a-004',
    prompt: 'Hand-drawn botanical illustration of a fern leaf on aged paper',
    imageUrl: 'https://picsum.photos/seed/mc4/800/600',
    mimeType: 'image/png',
    width: 1024,
    height: 1536,
    sizeBytes: 1650000,
    createdAt: '2026-06-17T09:45:00Z',
  },
]

// ── Admin Data ────────────────────────────────────────────

export const mockAdminUsers: AdminUser[] = [
  { id: 'u-001', email: 'user@example.com', role: 'user', status: 'active', createdAt: '2026-01-15T08:00:00Z' },
  { id: 'u-002', email: 'alice@example.com', role: 'user', status: 'active', createdAt: '2026-02-10T12:00:00Z' },
  { id: 'u-003', email: 'bob@example.com', role: 'user', status: 'disabled', createdAt: '2026-03-05T16:30:00Z' },
  { id: 'u-004', email: 'carol@example.com', role: 'user', status: 'active', createdAt: '2026-04-20T09:15:00Z' },
  { id: 'u-admin', email: 'admin@example.com', role: 'admin', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
]

export const mockInvitations: Invitation[] = [
  { id: 'inv-001', email: 'guest1@example.com', used: false, createdAt: '2026-06-18T10:00:00Z' },
  { id: 'inv-002', email: 'guest2@example.com', used: true, createdAt: '2026-06-17T14:30:00Z' },
  { id: 'inv-003', email: 'guest3@example.com', used: false, createdAt: '2026-06-16T08:45:00Z' },
]

export const mockSmtpSettings: SmtpSettings = {
  host: 'smtp.example.com',
  port: 465,
  secure: 'implicit_tls',
  from: 'noreply@musecanvas.com',
  fromName: 'MuseCanvas',
  user: 'smtp-user',
  hasPassword: true,
}

export const mockAdminModels: AdminModel[] = [
  {
    ...mockModels[0],
    vendorModelId: mockModels[0].vendorModelId || 'gpt-image-2',
    baseUrl: 'https://api.openai.com',
    concurrencyLimit: 2,
    watermark: false,
  },
  {
    ...mockModels[1],
    vendorModelId: mockModels[1].vendorModelId || 'seedream-3-0',
    baseUrl: 'https://ark.cn-beijing.volces.com',
    concurrencyLimit: 3,
    watermark: true,
  },
  {
    ...mockModels[2],
    vendorModelId: mockModels[2].vendorModelId || 'seedream-4-0',
    baseUrl: 'https://ark.cn-beijing.volces.com',
    concurrencyLimit: 1,
    watermark: true,
  },
]

export const mockModelPresets: ModelPreset[] = [
  { id: 'openai-gpt-image-2', displayName: 'GPT Image 2', adapter: 'openai', vendorModelId: 'gpt-image-2', baseUrl: 'https://api.openai.com', sizes: ['1024x1024', '1536x1024', '1024x1536'], qualityOptions: ['low', 'medium', 'high', 'auto'], maxCount: 4, concurrencyLimit: 1, watermark: false },
  { id: 'seedream-4-5', displayName: 'Seedream 4.5', adapter: 'seedream', vendorModelId: 'doubao-seedream-4-5-251128', baseUrl: 'https://ark.cn-beijing.volces.com', sizes: ['2K', '4K'], qualityOptions: [], maxCount: 4, concurrencyLimit: 1, watermark: false },
]

export const mockAdminJobs: AdminJob[] = [
  { id: 'j-001', createdBy: 'u-001', modelId: 'm-001', modelName: 'GPT Image 2', status: 'succeeded', createdAt: '2026-06-20T10:30:00Z', completedAt: '2026-06-20T10:30:42Z' },
  { id: 'j-002', createdBy: 'u-001', modelId: 'm-002', modelName: 'Seedream 3.0', status: 'running', createdAt: '2026-06-21T08:15:00Z' },
  { id: 'j-003', createdBy: 'u-002', modelId: 'm-001', modelName: 'GPT Image 2', status: 'succeeded', createdAt: '2026-06-20T12:00:00Z', completedAt: '2026-06-20T12:00:38Z' },
  { id: 'j-004', createdBy: 'u-002', modelId: 'm-002', modelName: 'Seedream 3.0', status: 'failed', errorCode: 'RATE_LIMIT', createdAt: '2026-06-20T15:00:00Z', completedAt: '2026-06-20T15:00:05Z' },
  { id: 'j-005', createdBy: 'u-003', modelId: 'm-001', modelName: 'GPT Image 2', status: 'canceled', createdAt: '2026-06-19T11:00:00Z' },
]

export const mockDashboardMetrics: DashboardMetrics = {
  totalUsers: 4,
  totalJobs: 127,
  successRate7d: 94.5,
  failedJobs7d: 7,
}
