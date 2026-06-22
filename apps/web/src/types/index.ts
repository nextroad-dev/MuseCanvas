// Shared types used across the frontend

export type UserRole = 'user' | 'admin'
export type UserStatus = 'active' | 'disabled'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'retry_wait'
export type RegistrationMode = 'open' | 'invite_only'
export type ModelAdapter = 'openai' | 'seedream'
export type Quality = 'low' | 'medium' | 'high' | 'auto'
export type TLSMode = 'implicit_tls' | 'starttls' | 'none'

export interface User {
  id: string
  email: string
  role: UserRole
  status: UserStatus
  createdAt: string
}

export interface Session {
  user: User
}

export interface ModelConfig {
  id: string
  displayName: string
  adapter: ModelAdapter
  vendorModelId?: string
  sizes: string[]
  qualityOptions?: Quality[]
  maxCount: number
  concurrencyLimit: number
  enabled: boolean
  sortOrder: number
}

export interface GenerationJob {
  id: string
  createdBy: string
  modelId: string
  modelName: string
  prompt: string
  size: string
  quality?: Quality
  count: number
  status: JobStatus
  errorCode?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  outputs: GenerationOutput[]
}

export interface GenerationOutput {
  id: string
  assetId: string
  imageUrl: string
}

export interface Asset {
  id: string
  prompt: string
  imageUrl: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
  createdAt: string
}

export interface Invitation {
  id: string
  email: string
  used: boolean
  revoked?: boolean
  createdAt: string
  code?: string
}

export interface SmtpSettings {
  host: string
  port: number
  secure: TLSMode
  from: string
  fromName: string
  user: string
  hasPassword: boolean
}

export interface AdminUser {
  id: string
  email: string
  role: UserRole
  status: UserStatus
  createdAt: string
}

export interface AdminModel extends ModelConfig {
  vendorModelId: string
  baseUrl: string
  watermark?: boolean
  providerCredentialId?: string
  providerCredentialName?: string
}

export type ProviderTestStatus = 'success' | 'failed' | 'not_tested'

export interface ProviderCredential {
  id: string
  displayName: string
  adapter: ModelAdapter
  baseUrl: string
  enabled: boolean
  hasApiKey: boolean
  keyFingerprint?: string
  lastTestStatus: ProviderTestStatus
  lastTestErrorCode?: string
  lastTestedAt?: string
  updatedAt: string
}

export interface ProviderCredentialInput {
  displayName?: string
  adapter?: ModelAdapter
  baseUrl?: string
  apiKey?: string
  enabled?: boolean
}

export interface OAuthProviderInfo {
  provider: 'github' | 'google'
  label: string
  enabled: boolean
}

export interface AdminOAuthProvider extends OAuthProviderInfo {
  configuredInDatabase: boolean
  source: 'database' | 'environment' | 'none'
  clientId: string
  hasClientSecret: boolean
  redirectUri: string
}

export interface OAuthProviderInput {
  clientId?: string
  clientSecret?: string
  enabled?: boolean
}

export interface OAuthIdentity {
  provider: 'github' | 'google'
  providerSubject: string
  emailAtLink: string
  displayName?: string
  avatarUrl?: string
  linkedAt: string
  lastLoginAt: string
}

export interface ModelPreset {
  id: string
  displayName: string
  adapter: ModelAdapter
  vendorModelId: string
  baseUrl: string
  sizes: string[]
  qualityOptions: Quality[]
  maxCount: number
  concurrencyLimit: number
  watermark: boolean
}

export interface AdminJob {
  id: string
  createdBy: string
  modelId: string
  modelName: string
  status: JobStatus
  errorCode?: string
  providerReferenceId?: string
  durationMs?: number
  createdAt: string
  completedAt?: string
}

export interface DashboardMetrics {
  totalUsers: number
  totalJobs: number
  successRate7d: number
  failedJobs7d: number
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  hasMore: boolean
  nextCursor?: string
}

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: { code: string; message: string }
}
