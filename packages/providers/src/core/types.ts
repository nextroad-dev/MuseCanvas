/**
 * Core Media Provider Kernel Types
 *
 * All inputs, outputs, models, operations, credentials crossing durable
 * boundaries must be strictly JSON-serializable.
 */

export type MediaProviderPluginId = string
export type MediaProviderPluginVersion = string

export type MediaPluginKey = `${string}@${string}`

export function formatPluginKey(id: string, version: string): MediaPluginKey {
  return `${id}@${version}`
}

export function parsePluginKey(key: string): { id: string; version: string } {
  const atIndex = key.lastIndexOf('@')
  if (atIndex <= 0 || atIndex === key.length - 1) {
    throw new Error(`INVALID_PLUGIN_KEY: ${key}`)
  }
  return {
    id: key.slice(0, atIndex),
    version: key.slice(atIndex + 1),
  }
}

/**
 * Manifest describing plugin capabilities, supported modalities, models, host allowlists, etc.
 */
export type MediaProviderManifest = {
  id: MediaProviderPluginId
  version: MediaProviderPluginVersion
  displayName: string
  modalities: ('image' | 'video')[]
  description?: string
  /**
   * Explicit host allowlist for outbound HTTP requests from this plugin.
   * e.g. ['api.openai.com', 'ark.cn-beijing.volces.com']
   * Note: Wildcards like '*.volces.com' or exact hostnames 'api.openai.com'.
   */
  allowedHosts: string[]
  /**
   * Credential schema supported by this plugin.
   * e.g. 'legacy-api-key-v1' or 'json-v1'
   */
  credentialSchemas: string[]
  /**
   * Models supported or default configuration parameters.
   */
  models?: {
    id: string
    name?: string
    modalities: ('image' | 'video')[]
    supportedAspectRatios?: string[]
    maxBatchSize?: number
  }[]
}

/**
 * Decoded and normalized credential payload.
 */
export type DecodedCredential = {
  schema: 'legacy-api-key-v1' | 'json-v1' | string
  apiKey?: string
  baseUrl?: string
  extra?: Record<string, unknown>
}

/**
 * Common configuration for provider operations.
 */
export type ProviderConfig = {
  baseUrl?: string
  credential?: DecodedCredential
  timeoutMs?: number
  maxBytes?: number
  customHeaders?: Record<string, string>
  [key: string]: unknown
}

/**
 * Input image reference crossing boundary.
 */
export type MediaInputImage = {
  /**
   * Base64-encoded string or raw buffer if in-memory.
   * When serialized across durable boundary, data is base64 string or byte array representation.
   */
  data: string | Buffer
  mimeType: 'image/png' | 'image/jpeg'
  width?: number
  height?: number
  sizeBytes?: number
}

/**
 * Normalized Media Request.
 */
export type MediaRequest = {
  modality: 'image' | 'video'
  vendorModelId: string
  prompt: string
  size?: string
  width?: number
  height?: number
  quality?: string
  count?: number
  watermark?: boolean
  durationSeconds?: number
  fps?: number
  inputImages?: MediaInputImage[]
  extra?: Record<string, unknown>
}

/**
 * Status of operation.
 */
export type OperationStatus =
  | 'submitting'
  | 'submission_unknown'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'canceled'
/**
 * Output descriptor returned by submit or poll.
 */
export type OutputDescriptor = {
  index: number
  mimeType: string
  url?: string
  b64Json?: string
  width?: number
  height?: number
  durationSeconds?: number
  sizeBytes?: number
  metadata?: Record<string, unknown>
}

/**
 * Normalized Provider Error Diagnostic
 */
export type NormalizedProviderErrorDiagnostic = {
  pluginId: string
  version: string
  status?: number
  statusText?: string
  endpoint?: string
  detail: string
  occurredAt: string
  providerReferenceId?: string
  code:
    | 'PROVIDER_NOT_CONFIGURED'
    | 'PROVIDER_TEMPORARY_ERROR'
    | 'PROVIDER_REJECTED'
    | 'PROVIDER_TIMEOUT'
    | 'PROVIDER_EMPTY_RESULT'
    | 'INVALID_REQUEST'
    | 'INVALID_CONFIG'
    | 'INVALID_CREDENTIAL'
    | 'UNSAFE_URL'
    | 'OUTPUT_READ_FAILED'
    | 'UNKNOWN_ERROR'
}

/**
 * Result of submit / poll / cancel operation.
 */
export type OperationResult = {
  status: OperationStatus
  remoteId?: string
  progress?: number
  retryAfterMs?: number
  opaqueState?: Record<string, unknown>
  outputs?: OutputDescriptor[]
  error?: NormalizedProviderErrorDiagnostic
}

/**
 * Bounded output read result for immediate first-party persistence.
 */
export type BoundedOutput = {
  data: Buffer
  mimeType: string
  width?: number
  height?: number
  sizeBytes: number
  metadata?: Record<string, unknown>
}

/**
 * Probe result.
 */
export type ProbeResult = {
  healthy: boolean
  message?: string
  latencyMs?: number
}

/**
 * Injected Execution Context.
 */
export type ExecutionContext = {
  pluginId: string
  version: string
  http: SafeHttpClient
  readOutput: (
    descriptor: OutputDescriptor,
    options?: { maxBytes?: number; timeoutMs?: number; allowedHosts?: string[] },
  ) => Promise<BoundedOutput>
}

/**
 * Safe HTTP Client interface injected into plugins.
 */
export type SafeHttpRequestInit = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  headers?: Record<string, string>
  body?: string | FormData | Buffer | Uint8Array
  timeoutMs?: number
  maxBytes?: number
  allowedHosts?: string[]
}

export type SafeHttpResponse = {
  status: number
  statusText: string
  headers: Headers
  ok: boolean
  url: string
  text: () => Promise<string>
  json: <T = unknown>() => Promise<T>
  buffer: () => Promise<Buffer>
  stream: () => ReadableStream<Uint8Array>
}

export interface SafeHttpClient {
  request(url: string, init?: SafeHttpRequestInit): Promise<SafeHttpResponse>
  get(url: string, init?: Omit<SafeHttpRequestInit, 'method'>): Promise<SafeHttpResponse>
  post(url: string, body?: string | FormData | Buffer | Uint8Array, init?: Omit<SafeHttpRequestInit, 'method' | 'body'>): Promise<SafeHttpResponse>
}

/**
 * Media Provider Plugin Interface
 */
export interface MediaProviderPlugin {
  readonly manifest: MediaProviderManifest

  probe?(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult>

  validateConfig(config: ProviderConfig): void | Promise<void>

  validateRequest(request: MediaRequest, config: ProviderConfig): void | Promise<void>

  submit(request: MediaRequest, config: ProviderConfig, context: ExecutionContext): Promise<OperationResult>

  poll?(remoteId: string, opaqueState: Record<string, unknown> | undefined, config: ProviderConfig, context: ExecutionContext): Promise<OperationResult>

  cancel?(remoteId: string, opaqueState: Record<string, unknown> | undefined, config: ProviderConfig, context: ExecutionContext): Promise<OperationResult>

  openOutput?(descriptor: OutputDescriptor, config: ProviderConfig, context: ExecutionContext): Promise<BoundedOutput>
}
