import { createSign } from 'node:crypto'
import type {
  BoundedOutput,
  ExecutionContext,
  MediaProviderManifest,
  MediaProviderPlugin,
  MediaRequest,
  OperationResult,
  OutputDescriptor,
  ProbeResult,
  ProviderConfig,
} from '../../core/types'
import { NormalizedProviderError } from '../../core/errors'

export const VEO_VIDEO_PLUGIN_ID = 'veo-video'
export const VEO_VIDEO_PLUGIN_VERSION = '1.0.0'

export const VEO_STANDARD_MODEL = 'veo-3.1-generate-001'
export const VEO_FAST_MODEL = 'veo-3.1-fast-generate-001'
const VEO_SUPPORTED_MODELS = [VEO_STANDARD_MODEL, VEO_FAST_MODEL] as const

const VEO_DEFAULT_LOCATION = 'us-central1'
const VEO_ALLOWED_DURATIONS = [4, 6, 8] as const
const VEO_ALLOWED_ASPECT_RATIOS = ['16:9', '9:16'] as const
const VEO_ALLOWED_RESOLUTIONS = ['720p', '1080p', '4k'] as const
const VEO_MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024
const VEO_POLL_RETRY_AFTER_MS = 5000

export const veoVideoManifest: MediaProviderManifest = {
  id: VEO_VIDEO_PLUGIN_ID,
  version: VEO_VIDEO_PLUGIN_VERSION,
  displayName: 'Google Vertex AI Veo Video Generation',
  modalities: ['video'],
  description:
    'Google Enterprise/Vertex AI Veo text-to-video and image-to-video via raw REST predictLongRunning/fetchPredictOperation',
  allowedHosts: [
    'us-central1-aiplatform.googleapis.com',
    'aiplatform.googleapis.com',
    '*-aiplatform.googleapis.com',
    'storage.googleapis.com',
    'oauth2.googleapis.com',
  ],
  credentialSchemas: ['json-v1', 'access-token-v1'],
  models: [
    { id: VEO_STANDARD_MODEL, name: 'Veo 3.1', modalities: ['video'], maxBatchSize: 4 },
    { id: VEO_FAST_MODEL, name: 'Veo 3.1 Fast', modalities: ['video'], maxBatchSize: 4 },
  ],
}

type VeoImagePayload = {
  bytesBase64Encoded: string
  mimeType: string
}

type VeoInstance = {
  prompt: string
  image?: VeoImagePayload
  lastFrame?: VeoImagePayload
  referenceImages?: Array<{ image: VeoImagePayload }>
}

type VeoParameters = {
  storageUri?: string
  sampleCount: number
  aspectRatio: string
  resolution?: string
  durationSeconds: number
  seed?: number
  personGeneration?: string
  negativePrompt?: string
  enhancePrompt?: boolean
  generateAudio?: boolean
  fps?: number
  resizeMode?: string
  compressionQuality?: number
}

type VeoSubmitResponse = {
  name?: string
}

type VeoVideoPayload = {
  gcsUri?: string
  bytesBase64Encoded?: string
  mimeType?: string
}

type VeoFetchResponse = {
  name?: string
  done?: boolean
  response?: {
    videos?: VeoVideoPayload[]
    raiMediaFilteredCount?: number
    raiMediaFilteredReasons?: unknown[]
  }
  error?: {
    code?: number
    message?: string
    status?: string
    details?: unknown[]
  }
}

function readExtra(config: ProviderConfig): Record<string, unknown> {
  const fromCredential =
    config.credential?.extra && typeof config.credential.extra === 'object'
      ? (config.credential.extra as Record<string, unknown>)
      : {}
  const fromConfig =
    config.extra && typeof config.extra === 'object'
      ? (config.extra as Record<string, unknown>)
      : {}
  return { ...fromCredential, ...fromConfig }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function invalidRequest(detail: string): NormalizedProviderError {
  return NormalizedProviderError.create(VEO_VIDEO_PLUGIN_ID, VEO_VIDEO_PLUGIN_VERSION, 'INVALID_REQUEST', detail)
}

function invalidConfig(detail: string): NormalizedProviderError {
  return NormalizedProviderError.create(VEO_VIDEO_PLUGIN_ID, VEO_VIDEO_PLUGIN_VERSION, 'INVALID_CONFIG', detail)
}

function hasServiceAccountFields(extra: Record<string, unknown>): boolean {
  return typeof extra.client_email === 'string' || typeof extra.private_key === 'string'
}
const serviceAccountTokenCache = new Map<string, { token: string; expiresAtMs: number }>()

export class VeoVideoPlugin implements MediaProviderPlugin {
  readonly manifest = veoVideoManifest

  async probe(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult> {
    const start = Date.now()
    try {
      const resolved = this.resolveConnection(config)
      const token = await this.resolveAccessToken(config, context)
      const endpoint = this.submitEndpoint(resolved.projectId, resolved.location, VEO_FAST_MODEL)
      const res = await context.http.post(
        endpoint,
        JSON.stringify({
          instances: [{ prompt: 'ping' }],
          parameters: { sampleCount: 1, aspectRatio: '16:9', durationSeconds: 4 },
        }),
        {
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          timeoutMs: config.timeoutMs ?? 15_000,
        },
      )
      return { healthy: res.status < 500, latencyMs: Date.now() - start }
    } catch (err: unknown) {
      return {
        healthy: false,
        message: err instanceof Error ? err.message : 'Unknown probe error',
        latencyMs: Date.now() - start,
      }
    }
  }

  validateConfig(config: ProviderConfig): void {
    const extra = readExtra(config)
    const projectId =
      readString(config.projectId) ?? readString(extra.projectId) ?? readString(extra.project_id)
    if (!projectId) {
      throw invalidConfig('Veo projectId is required in provider config or credential.extra')
    }
    const credential = config.credential
    if (!credential) {
      throw NormalizedProviderError.create(
        VEO_VIDEO_PLUGIN_ID,
        VEO_VIDEO_PLUGIN_VERSION,
        'PROVIDER_NOT_CONFIGURED',
        'Veo credential is missing in provider config',
      )
    }
    const accessToken =
      readString(extra.accessToken) ??
      readString(config.accessToken) ??
      (credential.schema === 'access-token-v1' ? readString(credential.apiKey) : undefined)
    if (!accessToken && !hasServiceAccountFields(extra)) {
      throw NormalizedProviderError.create(
        VEO_VIDEO_PLUGIN_ID,
        VEO_VIDEO_PLUGIN_VERSION,
        'INVALID_CREDENTIAL',
        'Veo credential must provide a short-lived accessToken in credential.extra (or an access-token-v1 credential), or service-account fields',
      )
    }
  }

  validateRequest(request: MediaRequest, config?: ProviderConfig): void {
    if (request.modality !== 'video') {
      throw invalidRequest(`Veo plugin supports video modality only, got '${request.modality}'`)
    }
    if (!VEO_SUPPORTED_MODELS.includes(request.vendorModelId as (typeof VEO_SUPPORTED_MODELS)[number])) {
      throw invalidRequest(
        `Unsupported Veo model '${request.vendorModelId}': expected ${VEO_SUPPORTED_MODELS.join(' or ')}`,
      )
    }
    if (!request.prompt || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw invalidRequest('Prompt must be a non-empty string')
    }
    const params = this.resolveVideoParameters(request, config)
    void params
  }

  async submit(
    request: MediaRequest,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    this.validateRequest(request, config)

    const { projectId, location } = this.resolveConnection(config)
    const token = await this.resolveAccessToken(config, context)
    const instance = this.buildInstance(request)
    const parameters = this.resolveVideoParameters(request, config)
    const endpoint = this.submitEndpoint(projectId, location, request.vendorModelId)

    const body = JSON.stringify({ instances: [instance], parameters })
    let response
    try {
      response = await context.http.post(endpoint, body, {
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        timeoutMs: config.timeoutMs,
      })
    } catch (err: unknown) {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          VEO_VIDEO_PLUGIN_ID,
          VEO_VIDEO_PLUGIN_VERSION,
          'PROVIDER_TEMPORARY_ERROR',
          err instanceof Error ? err.message : 'Veo submit transport error',
          { endpoint: this.endpointPath(endpoint) },
        ).diagnostic,
      }
    }

    if (!response.ok) {
      return { status: 'failed', error: (await this.normalizeHttpError(response)).diagnostic }
    }

    const json = await response.json<VeoSubmitResponse>()
    const operationName = typeof json?.name === 'string' ? json.name : undefined
    if (!operationName) {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          VEO_VIDEO_PLUGIN_ID,
          VEO_VIDEO_PLUGIN_VERSION,
          'PROVIDER_EMPTY_RESULT',
          'Veo predictLongRunning returned no operation name',
          { endpoint: this.endpointPath(endpoint) },
        ).diagnostic,
      }
    }

    // Durable opaque state carries the full operation name only — never tokens or URLs.
    const opaqueState: Record<string, unknown> = {
      resourceName: operationName,
      location,
      projectId,
      model: request.vendorModelId,
      durationSeconds: parameters.durationSeconds,
      aspectRatio: parameters.aspectRatio,
    }
    return { status: 'waiting', remoteId: operationName, opaqueState, retryAfterMs: VEO_POLL_RETRY_AFTER_MS }
  }

  async poll(
    remoteId: string,
    opaqueState: Record<string, unknown> | undefined,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    const resourceName = this.resolveResourceName(remoteId, opaqueState)
    const { location } = this.resolveConnection(config)
    const token = await this.resolveAccessToken(config, context)
    const endpoint = `https://${location}-aiplatform.googleapis.com/v1/${resourceName}:fetchPredictOperation`
    const body = JSON.stringify({ operationName: resourceName })

    let response
    try {
      response = await context.http.post(endpoint, body, {
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        timeoutMs: config.timeoutMs,
      })
    } catch (err: unknown) {
      return {
        status: 'waiting',
        remoteId,
        opaqueState,
        retryAfterMs: VEO_POLL_RETRY_AFTER_MS,
        error: NormalizedProviderError.create(
          VEO_VIDEO_PLUGIN_ID,
          VEO_VIDEO_PLUGIN_VERSION,
          'PROVIDER_TEMPORARY_ERROR',
          err instanceof Error ? err.message : 'Veo poll transport error',
          { endpoint: this.endpointPath(endpoint) },
        ).diagnostic,
      }
    }

    if (!response.ok) {
      return {
        status: 'waiting',
        remoteId,
        opaqueState,
        retryAfterMs: VEO_POLL_RETRY_AFTER_MS,
        error: (await this.normalizeHttpError(response)).diagnostic,
      }
    }

    const json = (await response.json<VeoFetchResponse>()) ?? {}
    // Treat remote outputs as untrusted: bound counts and string lengths below.
    if (!json.done) {
      return { status: 'waiting', remoteId, opaqueState, retryAfterMs: VEO_POLL_RETRY_AFTER_MS }
    }

    if (json.error) {
      const message = typeof json.error.message === 'string' ? json.error.message : 'Veo operation failed'
      return {
        status: 'failed',
        remoteId,
        opaqueState,
        error: NormalizedProviderError.create(
          VEO_VIDEO_PLUGIN_ID,
          VEO_VIDEO_PLUGIN_VERSION,
          'PROVIDER_REJECTED',
          this.safetyDetail(message, json.error.details),
          { endpoint: this.endpointPath(endpoint), providerReferenceId: resourceName },
        ).diagnostic,
      }
    }

    const videos = Array.isArray(json.response?.videos) ? json.response!.videos!.slice(0, 4) : []
    const filteredCount =
      typeof json.response?.raiMediaFilteredCount === 'number' ? json.response.raiMediaFilteredCount : 0
    const filteredReasons = Array.isArray(json.response?.raiMediaFilteredReasons)
      ? json.response!.raiMediaFilteredReasons
      : []
    if (videos.length === 0) {
      if (filteredCount > 0 || filteredReasons.length > 0) {
        return {
          status: 'failed',
          remoteId,
          opaqueState,
          error: NormalizedProviderError.create(
            VEO_VIDEO_PLUGIN_ID,
            VEO_VIDEO_PLUGIN_VERSION,
            'PROVIDER_REJECTED',
            `Veo request was blocked by safety filters (raiMediaFilteredCount=${filteredCount})`,
            { endpoint: this.endpointPath(endpoint), providerReferenceId: resourceName },
          ).diagnostic,
        }
      }
      return {
        status: 'failed',
        remoteId,
        opaqueState,
        error: NormalizedProviderError.create(
          VEO_VIDEO_PLUGIN_ID,
          VEO_VIDEO_PLUGIN_VERSION,
          'PROVIDER_EMPTY_RESULT',
          'Veo operation completed with no videos',
          { endpoint: this.endpointPath(endpoint), providerReferenceId: resourceName },
        ).diagnostic,
      }
    }

    const durationSeconds = this.readOpaqueDuration(opaqueState)
    const outputs: OutputDescriptor[] = videos.map((video, index) => {
      const mimeType =
        typeof video.mimeType === 'string' && video.mimeType.length <= 128 ? video.mimeType : 'video/mp4'
      if (typeof video.bytesBase64Encoded === 'string' && video.bytesBase64Encoded.length > 0) {
        return {
          index,
          mimeType,
          b64Json: video.bytesBase64Encoded.slice(0, 50_000_000),
          durationSeconds,
          metadata: { provider: 'veo' },
        }
      }
      const gcsUri = typeof video.gcsUri === 'string' ? video.gcsUri.slice(0, 2048) : undefined
      const httpsUrl = gcsUri
        ? (this.mapGcsUriToHttps(gcsUri, config) ?? this.gcsUriToCanonicalHttps(gcsUri))
        : undefined
      return {
        index,
        mimeType,
        url: httpsUrl,
        durationSeconds,
        metadata: { provider: 'veo', gcsUri },
      }
    })

    return { status: 'succeeded', remoteId, opaqueState, outputs }
  }

  async cancel(
    remoteId: string,
    opaqueState: Record<string, unknown> | undefined,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    const resourceName = this.resolveResourceName(remoteId, opaqueState)
    const { location } = this.resolveConnection(config)
    const token = await this.resolveAccessToken(config, context)
    const endpoint = `https://${location}-aiplatform.googleapis.com/v1/${resourceName}:cancel`

    let response
    try {
      response = await context.http.post(endpoint, '{}', {
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        timeoutMs: config.timeoutMs,
      })
    } catch {
      // Best-effort: transport failure leaves the operation state unknown.
      return { status: 'waiting', remoteId, opaqueState, retryAfterMs: VEO_POLL_RETRY_AFTER_MS }
    }

    if (response.ok) {
      return { status: 'canceled', remoteId, opaqueState }
    }
    if (response.status === 404) {
      // Operation unknown to the provider; keep polling rather than claiming cancellation.
      return { status: 'waiting', remoteId, opaqueState, retryAfterMs: VEO_POLL_RETRY_AFTER_MS }
    }
    return {
      status: 'waiting',
      remoteId,
      opaqueState,
      retryAfterMs: VEO_POLL_RETRY_AFTER_MS,
      error: (await this.normalizeHttpError(response)).diagnostic,
    }
  }

  async openOutput(
    descriptor: OutputDescriptor,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<BoundedOutput> {
    if (descriptor.b64Json) {
      return context.readOutput(descriptor, {
        maxBytes: config.maxBytes,
        timeoutMs: config.timeoutMs,
      })
    }
    if (descriptor.url) {
      if (descriptor.url.startsWith('https://')) {
        return context.readOutput(descriptor, {
          maxBytes: config.maxBytes,
          timeoutMs: config.timeoutMs,
        })
      }
      if (descriptor.url.startsWith('gs://')) {
        const mapped = this.mapGcsUriToHttps(descriptor.url, config)
        if (mapped) {
          return context.readOutput(
            { ...descriptor, url: mapped },
            { maxBytes: config.maxBytes, timeoutMs: config.timeoutMs },
          )
        }
        throw NormalizedProviderError.create(
          VEO_VIDEO_PLUGIN_ID,
          VEO_VIDEO_PLUGIN_VERSION,
          'UNSAFE_URL',
          'Veo GCS output URI (gs://) is not directly downloadable; configure an explicit HTTPS download mapping',
        )
      }
      throw NormalizedProviderError.create(
        VEO_VIDEO_PLUGIN_ID,
        VEO_VIDEO_PLUGIN_VERSION,
        'UNSAFE_URL',
        `Refusing to open non-HTTPS output URL for Veo output ${descriptor.index}`,
      )
    }
    throw NormalizedProviderError.create(
      VEO_VIDEO_PLUGIN_ID,
      VEO_VIDEO_PLUGIN_VERSION,
      'OUTPUT_READ_FAILED',
      `Veo output ${descriptor.index} has neither inline base64 nor a URL`,
    )
  }

  resolveConnection(config: ProviderConfig): { projectId: string; location: string } {
    const extra = readExtra(config)
    const projectId =
      readString(config.projectId) ?? readString(extra.projectId) ?? readString(extra.project_id) ?? ''
    const location = readString(config.location) ?? readString(extra.location) ?? VEO_DEFAULT_LOCATION
    return { projectId, location }
  }

  async resolveAccessToken(config: ProviderConfig, context: ExecutionContext): Promise<string> {
    // Config-driven only: never reads process.env or ambient credentials.
    const extra = readExtra(config)
    const direct =
      readString(extra.accessToken) ??
      readString(config.accessToken) ??
      (config.credential?.schema === 'access-token-v1' ? readString(config.credential.apiKey) : undefined)
    if (direct) return direct
    const clientEmail = readString(extra.client_email)
    const privateKey =
      typeof extra.private_key === 'string' && extra.private_key.length > 0
        ? (extra.private_key as string)
        : undefined
    if (!clientEmail || !privateKey) {
      if (hasServiceAccountFields(extra)) {
        throw NormalizedProviderError.create(
          VEO_VIDEO_PLUGIN_ID,
          VEO_VIDEO_PLUGIN_VERSION,
          'INVALID_CREDENTIAL',
          'Veo service-account credential requires client_email and private_key',
        )
      }
      return ''
    }
    const cached = serviceAccountTokenCache.get(clientEmail)
    if (cached && Date.now() < cached.expiresAtMs - 60_000) return cached.token
    const minted = await this.mintServiceAccountToken(clientEmail, privateKey, extra, config, context)
    return minted
  }

  submitEndpoint(projectId: string, location: string, model: string): string {
    return (
      `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}` +
      `/locations/${location}/publishers/google/models/${model}:predictLongRunning`
    )
  }

  buildInstance(request: MediaRequest): VeoInstance {
    const images = (request.inputImages ?? []).map(img => this.toImagePayload(img))
    const instance: VeoInstance = { prompt: request.prompt }
    if (images.length >= 1) {
      instance.image = images[0]
    }
    if (images.length >= 2) {
      instance.lastFrame = images[1]
    }
    if (images.length > 2) {
      instance.referenceImages = images.slice(2).map(image => ({ image }))
    }
    return instance
  }

  resolveVideoParameters(request: MediaRequest, config?: ProviderConfig): VeoParameters {
    const extra = { ...(request.extra ?? {}), ...(config ? readExtra(config) : {}) }
    // Request-level fields win over shared config extras for per-call overrides.
    const requestFirst = <T>(...values: Array<T | undefined>): T | undefined => {
      for (const value of values) {
        if (value !== undefined) return value
      }
      return undefined
    }

    const durationSeconds = Number(requestFirst(request.durationSeconds, extra.durationSeconds) ?? 8)
    if (!VEO_ALLOWED_DURATIONS.includes(durationSeconds as (typeof VEO_ALLOWED_DURATIONS)[number])) {
      throw invalidRequest(`Invalid Veo durationSeconds '${durationSeconds}': expected 4, 6, or 8`)
    }

    const aspectRatio = String(requestFirst(request.size, extra.aspectRatio) ?? '16:9')
    const normalizedAspect = this.normalizeAspectRatio(aspectRatio)
    if (!VEO_ALLOWED_ASPECT_RATIOS.includes(normalizedAspect as (typeof VEO_ALLOWED_ASPECT_RATIOS)[number])) {
      throw invalidRequest(`Invalid Veo aspectRatio '${aspectRatio}': expected 16:9 or 9:16`)
    }

    const resolution = requestFirst(extra.resolution !== undefined ? String(extra.resolution) : undefined, undefined) ?? '720p'
    if (!VEO_ALLOWED_RESOLUTIONS.includes(resolution as (typeof VEO_ALLOWED_RESOLUTIONS)[number])) {
      throw invalidRequest(`Invalid Veo resolution '${resolution}': expected 720p, 1080p, or 4k`)
    }
    if (resolution !== '720p') {
      if (request.vendorModelId !== VEO_STANDARD_MODEL) {
        throw invalidRequest(`Veo resolution '${resolution}' requires the standard model ${VEO_STANDARD_MODEL}`)
      }
      if (durationSeconds !== 8) {
        throw invalidRequest(`Veo resolution '${resolution}' requires durationSeconds 8`)
      }
    }

    const sampleCount = Number(requestFirst(request.count, extra.sampleCount) ?? 1)
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 4) {
      throw invalidRequest(`Invalid Veo sampleCount '${sampleCount}': expected an integer from 1 to 4`)
    }

    const parameters: VeoParameters = {
      sampleCount,
      aspectRatio: normalizedAspect,
      durationSeconds,
    }
    if (resolution !== undefined) parameters.resolution = resolution

    const storageUri = requestFirst(
      extra.storageUri !== undefined ? String(extra.storageUri) : undefined,
      undefined,
    )
    if (storageUri) parameters.storageUri = storageUri
    if (extra.seed !== undefined) {
      const seed = Number(extra.seed)
      if (!Number.isSafeInteger(seed) || seed < 0) throw invalidRequest(`Invalid Veo seed '${extra.seed}'`)
      parameters.seed = seed
    }
    if (extra.personGeneration !== undefined) parameters.personGeneration = String(extra.personGeneration)
    if (extra.negativePrompt !== undefined) parameters.negativePrompt = String(extra.negativePrompt)
    if (extra.enhancePrompt !== undefined) parameters.enhancePrompt = Boolean(extra.enhancePrompt)
    if (extra.generateAudio !== undefined) parameters.generateAudio = Boolean(extra.generateAudio)
    if (request.fps !== undefined || extra.fps !== undefined) {
      const fps = Number(requestFirst(request.fps, extra.fps as number | undefined))
      if (!Number.isFinite(fps) || fps <= 0 || fps > 60) throw invalidRequest(`Invalid Veo fps '${fps}'`)
      parameters.fps = fps
    }
    if (extra.resizeMode !== undefined) parameters.resizeMode = String(extra.resizeMode)
    if (extra.compressionQuality !== undefined) {
      const quality = Number(extra.compressionQuality)
      if (!Number.isFinite(quality) || quality < 0 || quality > 100) {
        throw invalidRequest(`Invalid Veo compressionQuality '${extra.compressionQuality}'`)
      }
      parameters.compressionQuality = quality
    }
    return parameters
  }

  private normalizeAspectRatio(size: string): string {
    const trimmed = size.trim()
    if (trimmed === '16:9' || trimmed === '9:16') return trimmed
    const match = trimmed.match(/^(\d+)\s*x\s*(\d+)$/i)
    if (match) {
      const width = Number(match[1])
      const height = Number(match[2])
      if (Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0) {
        return width >= height ? '16:9' : '9:16'
      }
    }
    return trimmed
  }

  private toImagePayload(image: NonNullable<MediaRequest['inputImages']>[number]): VeoImagePayload {
    const bytes =
      typeof image.data === 'string' ? Buffer.from(image.data, 'base64') : image.data
    const declaredSize = typeof image.sizeBytes === 'number' ? image.sizeBytes : bytes.length
    if (declaredSize > VEO_MAX_INPUT_IMAGE_BYTES || bytes.length > VEO_MAX_INPUT_IMAGE_BYTES) {
      throw invalidRequest(`Veo input image exceeds the 20MB request boundary (${declaredSize} bytes)`)
    }
    if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') {
      throw invalidRequest(`Unsupported Veo input image mimeType '${image.mimeType}'`)
    }
    return { bytesBase64Encoded: bytes.toString('base64'), mimeType: image.mimeType }
  }

  private resolveResourceName(remoteId: string, opaqueState?: Record<string, unknown>): string {
    const fromState =
      opaqueState && typeof opaqueState.resourceName === 'string' ? opaqueState.resourceName : undefined
    const resourceName = fromState ?? remoteId
    if (!resourceName || typeof resourceName !== 'string' || !resourceName.includes('/operations/')) {
      throw invalidRequest('Veo operation name is missing or malformed; expected a full operations resource name')
    }
    return resourceName
  }

  private readOpaqueDuration(opaqueState?: Record<string, unknown>): number | undefined {
    if (opaqueState && typeof opaqueState.durationSeconds === 'number') {
      return opaqueState.durationSeconds
    }
    return undefined
  }

  private mapGcsUriToHttps(gcsUri: string, config: ProviderConfig): string | undefined {
    const extra = readExtra(config)
    const base =
      readString(config.gcsDownloadBaseUrl) ??
      readString(extra.gcsDownloadBaseUrl) ??
      readString(extra.downloadBaseUrl)
    if (!base || !base.startsWith('https://')) return undefined
    const match = gcsUri.match(/^gs:\/\/([^/]+)\/(.+)$/)
    if (!match) return undefined
    return `${base.replace(/\/$/, '')}/${match[1]}/${match[2]}`
  }

  private gcsUriToCanonicalHttps(gcsUri: string): string | undefined {
    const match = gcsUri.match(/^gs:\/\/([^/]+)\/(.+)$/)
    if (!match) return undefined
    return `https://storage.googleapis.com/${match[1]}/${match[2]}`
  }

  private async mintServiceAccountToken(
    clientEmail: string,
    privateKey: string,
    extra: Record<string, unknown>,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<string> {
    const invalidCredential = (detail: string): NormalizedProviderError =>
      NormalizedProviderError.create(VEO_VIDEO_PLUGIN_ID, VEO_VIDEO_PLUGIN_VERSION, 'INVALID_CREDENTIAL', detail)
    const scope = String(extra.scope ?? 'https://www.googleapis.com/auth/cloud-platform')
    const tokenUri = readString(extra.token_uri) ?? 'https://oauth2.googleapis.com/token'
    const nowSeconds = Math.floor(Date.now() / 1000)
    const toBase64Url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')
    const signingInput = `${toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${toBase64Url(
      JSON.stringify({ iss: clientEmail, scope, aud: tokenUri, iat: nowSeconds, exp: nowSeconds + 3600 }),
    )}`
    let jwt: string
    try {
      const signer = createSign('RSA-SHA256')
      signer.update(signingInput)
      jwt = `${signingInput}.${signer.sign(privateKey).toString('base64url')}`
    } catch {
      throw invalidCredential('Veo service-account token minting failed: unable to sign the assertion JWT')
    }
    const body =
      'grant_type=' +
      encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' +
      encodeURIComponent(jwt)
    let response
    try {
      response = await context.http.post(tokenUri, body, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        timeoutMs: config.timeoutMs ?? 15_000,
      })
    } catch (err: unknown) {
      throw invalidCredential(
        `Veo service-account token request failed: ${err instanceof Error ? err.message : 'transport error'}`,
      )
    }
    let payload: { access_token?: unknown; expires_in?: unknown } = {}
    try {
      payload = (await response.json<{ access_token?: unknown; expires_in?: unknown }>()) ?? {}
    } catch {
      payload = {}
    }
    const accessToken = typeof payload.access_token === 'string' && payload.access_token.length > 0 ? payload.access_token : undefined
    if (!response.ok || !accessToken) {
      throw invalidCredential(`Veo service-account token request failed with status ${response.status}`)
    }
    const expiresIn =
      typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
        ? payload.expires_in
        : 3600
    serviceAccountTokenCache.set(clientEmail, { token: accessToken, expiresAtMs: Date.now() + expiresIn * 1000 })
    return accessToken
  }

  private endpointPath(endpoint: string): string {
    try {
      const url = new URL(endpoint)
      return url.pathname
    } catch {
      return endpoint
    }
  }

  private safetyDetail(message: string, details: unknown): string {
    const text = String(message).slice(0, 1200)
    try {
      const serialized = JSON.stringify(details ?? '').toLowerCase()
      if (serialized.includes('rai') || serialized.includes('safety') || serialized.includes('block')) {
        return `Veo request blocked by safety filters: ${text}`
      }
    } catch {
      // Fall through with the raw message when details are not serializable.
    }
    if (/rai|safety|block/i.test(text)) {
      return `Veo request blocked by safety filters: ${text}`
    }
    return text
  }

  private async normalizeHttpError(
    response: { status: number; statusText: string; headers: Headers; url: string; text: () => Promise<string> },
  ): Promise<NormalizedProviderError> {
    const rawText = await response.text()
    // Fold gRPC-style {error:{code,message,status}} bodies into the normalized detail.
    let detail = rawText
    try {
      const parsed = JSON.parse(rawText) as { error?: { message?: unknown; status?: unknown; code?: unknown } }
      if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object') {
        const parts = [
          typeof parsed.error.status === 'string' ? parsed.error.status : undefined,
          typeof parsed.error.message === 'string' ? parsed.error.message : undefined,
          parsed.error.code !== undefined ? `code=${String(parsed.error.code)}` : undefined,
        ].filter(Boolean)
        if (parts.length > 0) detail = parts.join(': ')
      }
    } catch {
      detail = rawText
    }
    return NormalizedProviderError.fromHttp(VEO_VIDEO_PLUGIN_ID, VEO_VIDEO_PLUGIN_VERSION, response, detail)
  }
}

export const veoVideoPlugin = new VeoVideoPlugin()
