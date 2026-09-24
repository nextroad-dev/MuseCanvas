import { createSign } from 'node:crypto'
import type {
  BooleanParameterDescriptor,
  EnumParameterDescriptor,
  InputSlotDescriptor,
  IntegerParameterDescriptor,
  JsonValue,
  ModelCapabilities,
  ParameterCrossFieldConstraint,
  ParameterDescriptor,
} from '@musecanvas/contracts'
import { enumOptionValues, evaluateCrossFieldConstraints, validateParameterValue } from '@musecanvas/contracts'
import type {
  BoundedOutput,
  ExecutionContext,
  MediaModelDeclaration,
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

const VEO_DEFAULT_LOCATION = 'us-central1'
const VEO_MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024
const VEO_POLL_RETRY_AFTER_MS = 5000

// ---------------------------------------------------------------------------
// Capability declaration
//
// This block *is* Veo's parameter contract: what `GET /api/models` serves, what
// the browser renders, what the API validates against, and what
// `resolveVideoParameters` below enforces. The `VEO_ALLOWED_*` tables this
// replaces were a second, private copy of the same facts, and the model/duration
// coupling lived only inside imperative `if`s nobody else could see.
//
// Durations stay enum *strings* (`'4' | '6' | '8'`) because that is what the
// admin preset has always offered; request normalization hands the adapter a
// number, which is converted back to its string form for the membership test.
// ---------------------------------------------------------------------------

const veoDurationParameter: EnumParameterDescriptor = {
  type: 'enum',
  name: 'durationSeconds',
  label: '时长（秒）',
  options: ['4', '6', '8'],
  defaultValue: '8',
  ui: { control: 'segmented', unit: '秒', order: 1 },
}

const veoAspectRatioParameter: EnumParameterDescriptor = {
  type: 'enum',
  name: 'aspectRatio',
  label: '宽高比',
  options: ['16:9', '9:16'],
  defaultValue: '16:9',
  ui: { control: 'segmented', order: 2 },
}

function veoResolutionParameter(options: string[], defaultValue: string): EnumParameterDescriptor {
  return {
    type: 'enum',
    name: 'resolution',
    label: '分辨率',
    options,
    defaultValue,
    ui: { control: 'segmented', order: 3 },
  }
}

const veoStandardResolutionParameter = veoResolutionParameter(['720p', '1080p', '4k'], '1080p')
// Today's rule "resolution '1080p'/'4k' requires the standard model" is really
// the statement that the fast tier has never accepted them, so the fast model
// simply does not offer them. Expressing it as an option set keeps the check
// declarative and removes the only place the adapter read `request.vendorModelId`
// to decide what a value meant.
const veoFastResolutionParameter = veoResolutionParameter(['720p'], '720p')

const veoAudioParameter: BooleanParameterDescriptor = {
  type: 'boolean',
  name: 'audio',
  label: '生成音频',
  defaultValue: true,
  ui: { control: 'switch', order: 4 },
}

const veoCountParameter: IntegerParameterDescriptor = {
  type: 'integer',
  name: 'count',
  label: '生成数量',
  min: 1,
  max: 4,
  defaultValue: 1,
  ui: { control: 'number', order: 5 },
}

/** Above 720p the vendor only renders an 8-second clip. */
const veoResolutionDurationRules: ParameterCrossFieldConstraint[] = [
  {
    type: 'forbidden',
    parameter: 'resolution',
    whenValueEquals: '1080p',
    targetParameter: 'durationSeconds',
    targetValues: ['4', '6'],
    message: '分辨率 1080p 需要时长 8 秒',
  },
  {
    type: 'forbidden',
    parameter: 'resolution',
    whenValueEquals: '4k',
    targetParameter: 'durationSeconds',
    targetValues: ['4', '6'],
    message: '分辨率 4k 需要时长 8 秒',
  },
]

/**
 * The three frames `buildInstance` actually places: `image`, `lastFrame` and
 * `referenceImages[]`. `prompt_image` / `source_video` are absent because
 * `resolveExplicitImageRoles` refuses them and falls back to positional
 * placement instead.
 */
const veoInputSlots: InputSlotDescriptor[] = [
  { role: 'first_frame', required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'], label: '首帧' },
  { role: 'last_frame', required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'], label: '尾帧' },
  { role: 'reference_image', required: false, minCount: 0, maxCount: 4, allowedMediaKinds: ['image'], label: '参考图' },
]

function veoCapabilities(resolution: EnumParameterDescriptor): ModelCapabilities {
  return {
    modes: ['text_to_video', 'image_to_video'],
    parameters: [veoDurationParameter, veoAspectRatioParameter, resolution, veoAudioParameter, veoCountParameter],
    inputSlots: veoInputSlots,
    maxCount: 4,
    supportedMediaKinds: ['video'],
    crossFieldConstraints: veoResolutionDurationRules,
    // `flags` stays absent on purpose: every flag in the contract describes an
    // image capability (mask / inpainting / transparent background), and
    // `validateFlagModeAgreement` only polices image modes, so a video plugin
    // claiming one would never be caught contradicting itself.
    declaredBy: 'plugin-manifest',
  }
}

const veoStandardCapabilities = veoCapabilities(veoStandardResolutionParameter)
const veoFastCapabilities = veoCapabilities(veoFastResolutionParameter)

/**
 * The console's starting point, taken from the current admin preset. The
 * adapter's own fallback when a caller states no resolution at all stays the
 * floor of the declared option set ('720p'), because that is what has always
 * gone on the wire for an unqualified request.
 */
const veoStandardDefaults: Record<string, JsonValue> = {
  durationSeconds: '8',
  aspectRatio: '16:9',
  resolution: '1080p',
  audio: true,
  count: 1,
}
const veoFastDefaults: Record<string, JsonValue> = {
  ...veoStandardDefaults,
  resolution: '720p',
}

export const veoVideoManifest: MediaProviderManifest = {
  kind: 'media',
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
    {
      id: VEO_STANDARD_MODEL,
      name: 'Veo 3.1',
      modalities: ['video'],
      maxBatchSize: 4,
      capabilities: veoStandardCapabilities,
      defaults: veoStandardDefaults,
    },
    {
      id: VEO_FAST_MODEL,
      name: 'Veo 3.1 Fast',
      modalities: ['video'],
      maxBatchSize: 4,
      capabilities: veoFastCapabilities,
      defaults: veoFastDefaults,
    },
  ],
}

/** The manifest is the only model list, so the guard reads it rather than a copy. */
const VEO_SUPPORTED_MODELS = (veoVideoManifest.models ?? []).map(model => model.id)

type VeoImagePayload = {
  bytesBase64Encoded: string
  mimeType: string
}

type VeoImageRole = 'first_frame' | 'last_frame' | 'reference_image'

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

/**
 * The manifest entry a request is validated against.
 *
 * A model with no declaration is refused rather than guessed at: falling back to
 * a private band table is how the adapter and the console started disagreeing in
 * the first place. `validateRequest` rejects an unknown id before this runs, so
 * the only way to reach the throw is a manifest that lost its own contract.
 */
function veoModelDeclaration(modelId: string): MediaModelDeclaration {
  const model = veoVideoManifest.models?.find(candidate => candidate.id === modelId)
  if (!model?.capabilities) {
    throw invalidRequest(`Unsupported Veo model '${modelId}': expected ${VEO_SUPPORTED_MODELS.join(' or ')}`)
  }
  return model
}

function veoDeclaredParameter(
  model: MediaModelDeclaration,
  name: string,
): ParameterDescriptor | undefined {
  return model.capabilities?.parameters.find(candidate => candidate.name === name)
}

/** The values the model itself offers for an enum control. */
function veoDeclaredOptions(model: MediaModelDeclaration, name: string): string[] {
  const descriptor = veoDeclaredParameter(model, name)
  if (descriptor?.type !== 'enum') {
    throw invalidRequest(`Veo model '${model.id}' declares no enum parameter '${name}'`)
  }
  return enumOptionValues(descriptor.options)
}

/** The bounds the model itself declares for an integer control. */
function veoDeclaredIntegerRange(
  model: MediaModelDeclaration,
  name: string,
): { min: number; max: number } {
  const descriptor = veoDeclaredParameter(model, name)
  if (descriptor?.type !== 'integer' || descriptor.min === undefined || descriptor.max === undefined) {
    throw invalidRequest(`Veo model '${model.id}' declares no integer range for parameter '${name}'`)
  }
  return { min: descriptor.min, max: descriptor.max }
}

/** Whether the declared descriptor accepts the value — the same predicate the browser applies. */
function veoAcceptsDeclaredValue(model: MediaModelDeclaration, name: string, value: JsonValue): boolean {
  const descriptor = veoDeclaredParameter(model, name)
  if (!descriptor) return false
  return validateParameterValue(descriptor, value).length === 0
}

/** `4, 6, or 8`: the wording this adapter has always used to refuse an enum value. */
function orList(values: string[]): string {
  if (values.length < 2) return values.join('')
  return `${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`
}

function hasServiceAccountFields(extra: Record<string, unknown>): boolean {
  return typeof extra.client_email === 'string' || typeof extra.private_key === 'string'
}
const serviceAccountTokenCache = new Map<string, { token: string; expiresAtMs: number }>()
const SERVICE_ACCOUNT_TOKEN_CACHE_LIMIT = 100

export class VeoVideoPlugin implements MediaProviderPlugin {
  readonly manifest = veoVideoManifest

  async probe(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult> {
    this.validateConfig(config)
    const start = Date.now()
    try {
      const { projectId, location } = this.resolveConnection(config)
      const token = await this.resolveAccessToken(config, context)
      const endpoint = this.operationsEndpoint(projectId, location)
      const res = await context.http.get(endpoint, {
        headers: {
          authorization: `Bearer ${token}`,
        },
        timeoutMs: config.timeoutMs ?? 15_000,
      })
      if (!res.ok) {
        const text = await res.text()
        return {
          healthy: false,
          message: `Probe failed with HTTP ${res.status}: ${text}`,
          latencyMs: Date.now() - start,
        }
      }
      return { healthy: true, latencyMs: Date.now() - start }
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
    if (!VEO_SUPPORTED_MODELS.includes(request.vendorModelId)) {
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
    // Location is interpolated into `https://${location}-aiplatform.googleapis.com/...`,
    // so constrain it to a single lowercase DNS label before it reaches any URL.
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(location)) {
      throw NormalizedProviderError.create(
        VEO_VIDEO_PLUGIN_ID,
        VEO_VIDEO_PLUGIN_VERSION,
        'UNSAFE_URL',
        `Invalid Veo location '${location.slice(0, 64)}': expected a GCP region such as 'us-central1'`,
      )
    }
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

  operationsEndpoint(projectId: string, location: string): string {
    return (
      `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}` +
      `/locations/${location}/operations?pageSize=1`
    )
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
    const roles = this.resolveExplicitImageRoles(request, images.length)
    if (roles) {
      const referenceImages: Array<{ image: VeoImagePayload }> = []
      roles.forEach((role, index) => {
        if (role === 'first_frame') instance.image = images[index]
        else if (role === 'last_frame') instance.lastFrame = images[index]
        else referenceImages.push({ image: images[index] })
      })
      if (referenceImages.length > 0) instance.referenceImages = referenceImages
      return instance
    }
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

  /**
   * Stored roles win only when the list is complete, aligned with the image
   * count, and describes a request Veo accepts: an unknown or duplicated role,
   * or a last frame without its first frame, is treated as invalid so the
   * caller falls back to the positional contract instead of losing bytes.
   */
  private resolveExplicitImageRoles(request: MediaRequest, count: number): VeoImageRole[] | null {
    const explicit = request.extra?.['imageRoles']
    if (!Array.isArray(explicit) || explicit.length === 0 || explicit.length !== count) return null
    const values = explicit as unknown[]
    for (const value of values) {
      if (value !== 'first_frame' && value !== 'last_frame' && value !== 'reference_image') return null
    }
    const roles = values as VeoImageRole[]
    if (roles.filter(role => role === 'first_frame').length !== 1) return null
    const lastFrames = roles.filter(role => role === 'last_frame').length
    if (lastFrames > 1) return null
    return roles
  }

  resolveVideoParameters(request: MediaRequest, config?: ProviderConfig): VeoParameters {
    const model = veoModelDeclaration(request.vendorModelId)
    const extra = { ...(request.extra ?? {}), ...(config ? readExtra(config) : {}) }
    // Request-level fields win over shared config extras for per-call overrides.
    const requestFirst = <T>(...values: Array<T | undefined>): T | undefined => {
      for (const value of values) {
        if (value !== undefined) return value
      }
      return undefined
    }

    const durations = veoDeclaredOptions(model, 'durationSeconds')
    const durationSeconds = Number(requestFirst(request.durationSeconds, extra.durationSeconds) ?? 8)
    if (!durations.includes(String(durationSeconds))) {
      throw invalidRequest(`Invalid Veo durationSeconds '${durationSeconds}': expected ${orList(durations)}`)
    }

    const ratios = veoDeclaredOptions(model, 'aspectRatio')
    const aspectRatio = String(requestFirst(request.size, extra.aspectRatio) ?? '16:9')
    const normalizedAspect = this.normalizeAspectRatio(aspectRatio)
    if (!ratios.includes(normalizedAspect)) {
      throw invalidRequest(`Invalid Veo aspectRatio '${aspectRatio}': expected ${ratios.join(' or ')}`)
    }

    // 720p is what an unqualified request has always been sent as; the declared
    // `defaultValue` describes the console's pre-selection, not this fallback.
    const resolution = requestFirst(extra.resolution !== undefined ? String(extra.resolution) : undefined, undefined) ?? '720p'
    const resolutions = veoDeclaredOptions(model, 'resolution')
    if (!resolutions.includes(resolution)) {
      throw invalidRequest(`Invalid Veo resolution '${resolution}': expected ${orList(resolutions)}`)
    }
    // "1080p or 4k needs an 8-second clip" is no longer an `if` in here: the same
    // `evaluateCrossFieldConstraints` the browser uses to grey out the submit
    // button decides it, read off this model's own declaration.
    const coupling = evaluateCrossFieldConstraints(model.capabilities?.crossFieldConstraints, {
      durationSeconds: String(durationSeconds),
      aspectRatio: normalizedAspect,
      resolution,
    })[0]
    if (coupling) {
      throw invalidRequest(coupling.message)
    }

    const sampleCountBounds = veoDeclaredIntegerRange(model, 'count')
    const sampleCount = Number(requestFirst(request.count, extra.sampleCount) ?? 1)
    if (!Number.isSafeInteger(sampleCount) || sampleCount < sampleCountBounds.min || sampleCount > sampleCountBounds.max) {
      throw invalidRequest(
        `Invalid Veo sampleCount '${sampleCount}': expected an integer from ${sampleCountBounds.min} to ${sampleCountBounds.max}`,
      )
    }

    const parameters: VeoParameters = {
      sampleCount,
      aspectRatio: normalizedAspect,
      durationSeconds,
      resolution,
    }

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
    const audio = extra.generateAudio ?? extra.audio
    if (audio !== undefined) {
      if (!veoAcceptsDeclaredValue(model, 'audio', audio as JsonValue)) {
        throw invalidRequest(`Invalid Veo audio '${String(audio)}': expected a boolean`)
      }
      parameters.generateAudio = Boolean(audio)
    }
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
    if (serviceAccountTokenCache.size >= SERVICE_ACCOUNT_TOKEN_CACHE_LIMIT) {
      const oldest = serviceAccountTokenCache.keys().next().value
      if (oldest !== undefined) serviceAccountTokenCache.delete(oldest)
    }
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
