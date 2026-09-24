/**
 * Core Media Provider Kernel Types
 *
 * All inputs, outputs, models, operations, credentials crossing durable
 * boundaries must be strictly JSON-serializable.
 */

// Type-only, so an uploaded plugin bundle still ships zero runtime imports even
// though its declarations reference the shared capability contract.
import type { JsonValue, ModelCapabilities } from '@musecanvas/contracts'

export type MediaProviderPluginId = string
export type MediaProviderPluginVersion = string

export type MediaPluginKey = `${string}@${string}`

/** Discriminates which kernel a registered plugin belongs to. */
export type ProviderPluginKind = 'media' | 'language'

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
  kind: 'media'
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
   * Models this plugin can serve, each with the full parameter contract the
   * vendor actually accepts for it.
   *
   * The per-model `capabilities` block is the authoritative statement of that
   * model's parameters, geometry limits and edit abilities. The host does not
   * invent any of it: what a model does not declare it does not offer, and a
   * model that declares nothing surfaces as undeclared rather than as a guess.
   */
  models?: MediaModelDeclaration[]
}

/**
 * One vendor model, with everything the system needs to render, validate and
 * dispatch a request for it.
 *
 * Exported so a plugin can build a shared parameter set once and reference it
 * from several models that behave identically, instead of copy-pasting a
 * descriptor list per model id.
 */
export interface MediaModelDeclaration {
  id: string
  name?: string
  modalities: ('image' | 'video')[]
  /**
   * @deprecated Superseded by the `image-size` descriptor's `presets`, which
   * carry labels and geometry and can also express custom-size limits. Retained
   * because persisted manifest copies still contain it.
   */
  supportedAspectRatios?: string[]
  /**
   * @deprecated Superseded by the `count` parameter descriptor's `max`.
   */
  maxBatchSize?: number
  /**
   * @deprecated Superseded by `inputSlots` / `flags.imageToImage`.
   */
  maxInputImages?: number
  /**
   * this vendor model accepts a separate alpha mask part on its edit endpoint
   */
  supportsMask?: boolean
  /** The authoritative parameter contract for this model. */
  capabilities?: ModelCapabilities
  /** Starting values, each of which must be legal for its own descriptor. */
  defaults?: Record<string, JsonValue>
  /** Vendor-retired but still servable. Never the default recommendation. */
  deprecated?: boolean
  deprecationNote?: string
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
  role?: string
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
  /**
   * Parameters declared by the model's manifest contract that have no typed
   * field of their own — `background`, `output_format`, `output_compression`,
   * `input_fidelity`, `seed`, and so on.
   *
   * This is deliberately a *separate* field from `extra`. `extra` means
   * "untyped leftovers" and is read with alias-tolerant lookups by the video
   * adapters; treating it as the contract channel would make the documented
   * escape hatch load-bearing and would collide with its `imageRoles` key.
   * Keys here are exactly the descriptor names the model declared, so the
   * adapter converts unified parameters into provider-specific wire fields
   * rather than the frontend ever learning those differences.
   */
  parameters?: Record<string, JsonValue>
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
  /** Opt-out of the HTTPS-only default for explicit deployments (e.g. ALLOW_INSECURE_PROVIDER_BASE_URL). */
  allowInsecureProtocol?: boolean
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

/* -------------------------------------------------------------------------
 * Language Provider Kernel Types
 *
 * A minimal kernel for LLM completions; no media-specific types cross over.
 * ------------------------------------------------------------------------- */

/** LLM wire protocol family (single source of truth; re-exported from language-model.ts). */
export type LanguageProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages'
/** Reasoning-effort token (single source of truth; re-exported from language-model.ts). */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

/**
 * Manifest describing a language-model plugin's protocol, host allowlist and models.
 */
export type LanguageProviderManifest = {
  kind: 'language'
  id: MediaProviderPluginId
  version: MediaProviderPluginVersion
  displayName: string
  description?: string
  languageProtocols: LanguageProtocol[]
  allowedHosts: string[]
  credentialSchemas: string[]
  models?: {
    id: string
    name?: string
    maxInputTokens?: number
    maxOutputTokensDefault?: number
    supportsStructuredOutput?: boolean
  }[]
}

/** Normalized completion request crossing the plugin boundary (no transport secrets). */
export type LanguageRequest = {
  vendorModelId: string
  system: string
  user: string
  schemaName?: string
  schema?: Record<string, unknown>
  maxOutputTokens: number
  temperature?: number
  reasoningEffort?: ReasoningEffort | null
  timeoutMs: number
}

/** Normalized completion result returned by a language plugin. */
export type LanguageCompletionResult = {
  text: string
  providerReferenceId?: string
  inputTokens?: number
  outputTokens?: number
  error?: NormalizedProviderErrorDiagnostic
}

/**
 * Language plugins get only a SafeHttpClient; there is no bounded binary output reader.
 */
export type LanguageExecutionContext = {
  pluginId: string
  version: string
  http: SafeHttpClient
}

/**
 * Language Provider Plugin Interface.
 */
export interface LanguageProviderPlugin {
  readonly manifest: LanguageProviderManifest

  probe?(config: ProviderConfig, context: LanguageExecutionContext): Promise<ProbeResult>

  validateConfig(config: ProviderConfig): void | Promise<void>

  complete(request: LanguageRequest, config: ProviderConfig, context: LanguageExecutionContext): Promise<LanguageCompletionResult>
}
