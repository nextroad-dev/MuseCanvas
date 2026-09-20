import type {
  BooleanParameterDescriptor,
  EnumParameterDescriptor,
  InputSlotDescriptor,
  IntegerParameterDescriptor,
  JsonValue,
  ModelCapabilities,
  ParameterDescriptor,
} from '@musecanvas/contracts'
import { validateParameterValue } from '@musecanvas/contracts'
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

export const SEEDANCE_VIDEO_PLUGIN_ID = 'seedance-video'
export const SEEDANCE_VIDEO_PLUGIN_VERSION = '1.0.0'

export const SEEDANCE_CN_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
export const SEEDANCE_BYTEPLUS_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3'

const SEEDANCE_TASKS_PATH = '/contents/generations/tasks'

const DEFAULT_RETRY_AFTER_MS = 5_000
const MAX_RETRY_AFTER_MS = 30_000
const MAX_PROMPT_CHARS = 8_000
// Absolute defense ceilings (setup-allowed maxima). Runtime DB limits are
// enforced upstream in API/worker; this fallback never contradicts them.
const MAX_INPUT_IMAGES = 32
const MAX_INPUT_IMAGE_BYTES = 100_000_000
const MAX_VIDEO_URL_CHARS = 4_096

export const SEEDANCE_IMAGE_ROLES = ['first_frame', 'last_frame', 'reference_image', 'mask'] as const
export type SeedanceImageRole = (typeof SEEDANCE_IMAGE_ROLES)[number]

const SEEDANCE_MAX_SEED = 2_147_483_647
const SEEDANCE_MAX_FRAMES = 10_000

// ---------------------------------------------------------------------------
// Capability declaration
//
// One contract per forwarded video control, referenced by every model below and
// enforced by `extractVideoControls` — the descriptor list *is* the whitelist
// that used to be a chain of per-key `if`s with hand-written ranges.
//
// `fps` is deliberately absent: the plugin forwards no frame-rate control to Ark
// at all, so advertising one would be the invented-capability bug this contract
// exists to remove.
// ---------------------------------------------------------------------------

const seedanceDurationParameter: IntegerParameterDescriptor = {
  type: 'integer',
  name: 'durationSeconds',
  label: '时长（秒）',
  min: 1,
  max: 30,
  defaultValue: 5,
  ui: { control: 'slider', unit: '秒', order: 1 },
}

const seedanceAspectRatioParameter: EnumParameterDescriptor = {
  type: 'enum',
  name: 'aspectRatio',
  label: '宽高比',
  options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  defaultValue: '16:9',
  ui: { control: 'select', order: 2 },
}

const seedanceResolutionParameter: EnumParameterDescriptor = {
  type: 'enum',
  name: 'resolution',
  label: '分辨率',
  options: ['720p', '1080p'],
  defaultValue: '720p',
  ui: { control: 'segmented', order: 3 },
}

const seedanceAudioParameter: BooleanParameterDescriptor = {
  type: 'boolean',
  name: 'audio',
  label: '生成音频',
  defaultValue: true,
  ui: { control: 'switch', order: 4 },
}

const seedanceCountParameter: IntegerParameterDescriptor = {
  type: 'integer',
  name: 'count',
  label: '生成数量',
  min: 1,
  max: 4,
  defaultValue: 1,
  ui: { control: 'number', order: 5 },
}

const seedanceSeedParameter: IntegerParameterDescriptor = {
  type: 'integer',
  name: 'seed',
  label: '随机种子',
  min: 0,
  max: SEEDANCE_MAX_SEED,
  ui: { control: 'number', advanced: true, order: 6 },
}

const seedanceWatermarkParameter: BooleanParameterDescriptor = {
  type: 'boolean',
  name: 'watermark',
  label: '水印',
  defaultValue: false,
  ui: { control: 'switch', advanced: true, order: 7 },
}

const seedanceCameraFixedParameter: BooleanParameterDescriptor = {
  type: 'boolean',
  name: 'camera_fixed',
  label: '镜头固定',
  ui: { control: 'switch', advanced: true, order: 8 },
}

const seedanceFramesParameter: IntegerParameterDescriptor = {
  type: 'integer',
  name: 'frames',
  label: '总帧数',
  min: 1,
  max: SEEDANCE_MAX_FRAMES,
  ui: { control: 'number', advanced: true, order: 9 },
}

/** Every control the adapter reads, in the order it has always validated them. */
const seedanceVideoParameters: ParameterDescriptor[] = [
  seedanceDurationParameter,
  seedanceAspectRatioParameter,
  seedanceResolutionParameter,
  seedanceAudioParameter,
  seedanceCountParameter,
  seedanceSeedParameter,
  seedanceWatermarkParameter,
  seedanceCameraFixedParameter,
  seedanceFramesParameter,
]

/**
 * Roles `resolveImageRoles` really forwards. `count` lives in `parameters`, not
 * here: Ark takes one clip per task, so the plugin validates the requested count
 * and never puts it on the wire.
 */
const seedanceInputSlots: InputSlotDescriptor[] = [
  { role: 'first_frame', required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'], label: '首帧' },
  { role: 'last_frame', required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'], label: '尾帧' },
  { role: 'reference_image', required: false, minCount: 0, maxCount: 4, allowedMediaKinds: ['image'], label: '参考图' },
  // `mask` has been accepted verbatim by `resolveImageRoles` (and listed in
  // `SEEDANCE_IMAGE_ROLES`) all along; declaring the slot is what makes the role
  // discoverable to the console instead of existing only in this file.
  { role: 'mask', required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'], label: '蒙版' },
]

const seedanceCapabilities: ModelCapabilities = {
  modes: ['text_to_video', 'image_to_video'],
  parameters: seedanceVideoParameters,
  inputSlots: seedanceInputSlots,
  maxCount: 4,
  supportedMediaKinds: ['video'],
  // No `flags`: they describe image models (mask / inpainting / transparent
  // background), and `validateFlagModeAgreement` does not run for video modes,
  // so a wrong claim here would go uncaught. A `mask` *input* is not the same
  // statement as an inpainting-capable image model.
  declaredBy: 'plugin-manifest',
}

const seedanceDefaults: Record<string, JsonValue> = {
  durationSeconds: 5,
  aspectRatio: '16:9',
  resolution: '720p',
  audio: true,
  count: 1,
}

export const seedanceVideoManifest: MediaProviderManifest = {
  kind: 'media',
  id: SEEDANCE_VIDEO_PLUGIN_ID,
  version: SEEDANCE_VIDEO_PLUGIN_VERSION,
  displayName: 'Seedance 2.x Video Generation (Volcengine Ark / BytePlus)',
  modalities: ['video'],
  description: 'ByteDance Seedance async video generation via the Ark Contents generations tasks API',
  allowedHosts: ['ark.cn-beijing.volces.com', 'ark.ap-southeast.bytepluses.com'],
  credentialSchemas: ['legacy-api-key-v1', 'json-v1'],
  models: [
    {
      id: 'doubao-seedance-2-0-fast-260128',
      modalities: ['video'],
      capabilities: seedanceCapabilities,
      defaults: seedanceDefaults,
    },
    {
      id: 'dreamina-seedance-2-0-fast-260128',
      modalities: ['video'],
      capabilities: seedanceCapabilities,
      defaults: seedanceDefaults,
    },
  ],
}

type SeedanceContentEntry =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string }; role: SeedanceImageRole }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchesAllowedHost(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase()
  return patterns.some(pattern => {
    const p = pattern.toLowerCase()
    if (p.startsWith('*.')) {
      const suffix = p.slice(1)
      return host.endsWith(suffix) && host.length > suffix.length
    }
    return host === p
  })
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw.trim())
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, Math.round(seconds * 1_000)))
}

function readExtra(config: ProviderConfig, key: string): unknown {
  if (config[key] !== undefined) return config[key]
  const extra = config.credential?.extra
  if (isRecord(extra) && extra[key] !== undefined) return extra[key]
  return undefined
}

function invalidControlRequest(detail: string): NormalizedProviderError {
  return NormalizedProviderError.create(SEEDANCE_VIDEO_PLUGIN_ID, SEEDANCE_VIDEO_PLUGIN_VERSION, 'INVALID_REQUEST', detail)
}

/**
 * How a declared control reaches the wire.
 *
 * `sources` is the whole of what the adapter reads out of `request.extra`, which
 * is what keeps the whitelist a whitelist: a key nobody listed is never looked
 * at, so an undocumented provider combination cannot be sent implicitly.
 */
type SeedanceVideoControl = {
  /** Parameter name as declared in the model's `capabilities`. */
  parameter: string
  /** Key this control is written to in the Ark request body. */
  wire: string
  /** `extra` keys that may carry it, provider-native spelling first. */
  sources: string[]
  /** Fallback read off the normalized request itself. */
  fromRequest?: (request: MediaRequest) => unknown
  /**
   * Provider grammar, checked instead of the descriptor's `options`.
   *
   * The declared enums are what the console offers, not the whole set Ark takes:
   * `resolution` has always accepted any `NNNp` or `WxH` token and `ratio` any
   * `N:N`. Narrowing those to the enum would reject a value that worked before,
   * so the grammar stays here and the enum stays a presentation contract.
   */
  grammar?: { pattern: RegExp; detail: string }
  /**
   * `true` when only the descriptor's declared min/max are enforced. Duration is
   * a `number` on the wire today — the integer descriptor spells out the ladder
   * the console renders — and a fractional value must keep flowing through.
   */
  rangeOnly?: boolean
}

/** The forwarded controls, in the order they have always been validated. */
const SEEDANCE_VIDEO_CONTROLS: readonly SeedanceVideoControl[] = [
  { parameter: 'audio', wire: 'generate_audio', sources: ['generate_audio', 'audio'] },
  { parameter: 'camera_fixed', wire: 'camera_fixed', sources: ['camera_fixed'] },
  { parameter: 'watermark', wire: 'watermark', sources: ['watermark'], fromRequest: request => request.watermark },
  { parameter: 'seed', wire: 'seed', sources: ['seed'] },
  {
    parameter: 'resolution',
    wire: 'resolution',
    sources: ['resolution'],
    grammar: {
      pattern: /^([0-9]{3,4}p|\d+x\d+)$/i,
      detail: "Video control 'resolution' must look like '720p', '1080p', or '1280x720'",
    },
  },
  {
    parameter: 'aspectRatio',
    wire: 'ratio',
    sources: ['ratio', 'aspectRatio'],
    grammar: { pattern: /^\d{1,2}:\d{1,2}$/, detail: "Video control 'ratio' must look like '16:9'" },
  },
  {
    parameter: 'durationSeconds',
    wire: 'duration',
    sources: ['duration'],
    fromRequest: request => request.durationSeconds,
    rangeOnly: true,
  },
  { parameter: 'frames', wire: 'frames', sources: ['frames'] },
]

function seedanceControlValue(
  rule: SeedanceVideoControl,
  request: MediaRequest,
  extra: Record<string, unknown>,
): unknown {
  for (const key of rule.sources) {
    if (extra[key] !== undefined) return extra[key]
  }
  return rule.fromRequest ? rule.fromRequest(request) : undefined
}

function seedanceCapabilitiesFor(modelId: string): ModelCapabilities {
  // An Ark model string an admin pinned that this manifest does not list is not a
  // reason to refuse the job: the plugin has always submitted whatever id it was
  // handed. It gets the same shared contract the declared models use, which
  // describes this provider family rather than guessing at an unknown one.
  return seedanceVideoManifest.models?.find(model => model.id === modelId)?.capabilities ?? seedanceCapabilities
}

function seedanceDescriptorFor(modelId: string, parameter: string): ParameterDescriptor {
  const descriptor = seedanceCapabilitiesFor(modelId).parameters.find(candidate => candidate.name === parameter)
  if (!descriptor) {
    throw invalidControlRequest(`Seedance declares no parameter '${parameter}'`)
  }
  return descriptor
}

function seedanceIntegerRange(
  descriptor: ParameterDescriptor,
  parameter: string,
): { min: number; max: number } {
  if (descriptor.type !== 'integer' || descriptor.min === undefined || descriptor.max === undefined) {
    throw invalidControlRequest(`Parameter '${parameter}' declares no integer range`)
  }
  return { min: descriptor.min, max: descriptor.max }
}

/** Today's wording for a refused control, rebuilt from what the descriptor declares. */
function seedanceControlShape(descriptor: ParameterDescriptor): string {
  if (descriptor.type === 'boolean') return 'a boolean'
  if (descriptor.type === 'integer') {
    return `an integer between ${descriptor.min ?? 0} and ${descriptor.max ?? Number.MAX_SAFE_INTEGER}`
  }
  return `a value of type ${descriptor.type}`
}

export class SeedanceVideoPlugin implements MediaProviderPlugin {
  readonly manifest = seedanceVideoManifest

  async probe(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult> {
    const start = Date.now()
    try {
      this.validateConfig(config)
      const apiKey = this.resolveApiKey(config)
      const baseUrl = this.resolveBaseUrl(config)
      const res = await context.http.get(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        timeoutMs: config.timeoutMs ?? 15_000,
      })
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
    const apiKey = this.resolveApiKey(config)
    if (!apiKey) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'PROVIDER_NOT_CONFIGURED',
        'Seedance Ark API key is missing in provider config',
      )
    }
    for (const candidate of [config.baseUrl, config.credential?.baseUrl]) {
      if (candidate === undefined) continue
      let parsed: URL
      try {
        parsed = new URL(candidate)
      } catch {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_CONFIG',
          `Invalid baseUrl '${candidate}': not a valid URL`,
        )
      }
      if (parsed.protocol !== 'https:') {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_CONFIG',
          `Invalid baseUrl '${candidate}': must use https:`,
        )
      }
      if (!matchesAllowedHost(parsed.hostname, this.manifest.allowedHosts)) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_CONFIG',
          `Invalid baseUrl '${candidate}': host is not in the plugin allowlist`,
        )
      }
    }
  }

  validateRequest(request: MediaRequest, _config?: ProviderConfig): void {
    if (request.modality !== 'video') {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        `Seedance plugin supports video modality only, got '${request.modality}'`,
      )
    }
    if (!request.prompt || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'Prompt must be a non-empty string',
      )
    }
    if (request.prompt.length > MAX_PROMPT_CHARS) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        `Prompt exceeds maximum length of ${MAX_PROMPT_CHARS} characters`,
      )
    }
    if (!request.vendorModelId) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'vendorModelId is required',
      )
    }
    if (request.count !== undefined) {
      const range = seedanceIntegerRange(seedanceDescriptorFor(request.vendorModelId, 'count'), 'count')
      if (!Number.isInteger(request.count) || request.count < range.min || request.count > range.max) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          `count must be an integer between ${range.min} and ${range.max}`,
        )
      }
    }
    if (request.durationSeconds !== undefined) {
      const declared = seedanceDescriptorFor(request.vendorModelId, 'durationSeconds')
      // The declared band, not a second copy of it: the generic 1-60 fallback that
      // used to live upstream contradicted this plugin, so 1-30 is stated once.
      const range = seedanceIntegerRange(declared, 'durationSeconds')
      if (
        typeof request.durationSeconds !== 'number' ||
        !Number.isFinite(request.durationSeconds) ||
        request.durationSeconds < range.min ||
        request.durationSeconds > range.max
      ) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          `durationSeconds must be a number between ${range.min} and ${range.max}`,
        )
      }
    }
    const images = request.inputImages ?? []
    if (images.length > MAX_INPUT_IMAGES) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        `At most ${MAX_INPUT_IMAGES} input images are supported`,
      )
    }
    for (const img of images) {
      if (img.mimeType !== 'image/png' && img.mimeType !== 'image/jpeg') {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          `Unsupported input image mimeType '${img.mimeType}'`,
        )
      }
      const empty =
        (typeof img.data === 'string' && img.data.length === 0) ||
        (typeof img.data !== 'string' && img.data.length === 0)
      if (empty) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          'Input image data must be non-empty',
        )
      }
      if (img.sizeBytes !== undefined && img.sizeBytes > MAX_INPUT_IMAGE_BYTES) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          'Input image exceeds maximum size of 100 MB',
        )
      }
    }
    const roles = request.extra?.['imageRoles']
    if (roles !== undefined) {
      if (!Array.isArray(roles) || roles.some(r => typeof r !== 'string' || !SEEDANCE_IMAGE_ROLES.includes(r as SeedanceImageRole))) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          `extra.imageRoles must be an array of [${SEEDANCE_IMAGE_ROLES.join(', ')}]`,
        )
      }
      if (roles.length !== images.length) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          'extra.imageRoles length must match inputImages length',
        )
      }
    }
    // Validate forwarded video controls early so submit never sends unvalidated values.
    this.extractVideoControls(request)
  }

  async submit(
    request: MediaRequest,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    this.validateRequest(request, config)

    const apiKey = this.resolveApiKey(config)
    const baseUrl = this.resolveBaseUrl(config)
    const endpoint = `${baseUrl}${SEEDANCE_TASKS_PATH}`

    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    }
    const clientRequestId = this.resolveClientRequestId(config)
    if (clientRequestId) headers['x-client-request-id'] = clientRequestId

    const response = await context.http.post(endpoint, JSON.stringify(this.buildGenerationsBody(request)), {
      headers,
      timeoutMs: config.timeoutMs,
    })

    if (!response.ok) {
      const errorText = await response.text()
      const normalized = NormalizedProviderError.fromHttp(
        this.manifest.id,
        this.manifest.version,
        response,
        errorText,
      )
      if (normalized.diagnostic.code === 'PROVIDER_TEMPORARY_ERROR') {
        return {
          status: 'submission_unknown',
          retryAfterMs: parseRetryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_MS,
          error: normalized.diagnostic,
        }
      }
      return { status: 'failed', error: normalized.diagnostic }
    }

    const json = (await response.json()) as unknown
    const id = isRecord(json) && typeof json['id'] === 'string' ? json['id'] : undefined
    if (!id) {
      return {
        status: 'submission_unknown',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'Seedance returned no task id',
          { providerReferenceId: this.providerReferenceId(response.headers) },
        ).diagnostic,
      }
    }

    return {
      status: 'waiting',
      remoteId: id,
      retryAfterMs: parseRetryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_MS,
      // Durable opaque state: JSON-safe identifiers only — never secrets or URLs.
      opaqueState: {
        taskId: id,
        model: request.vendorModelId,
        ...(request.durationSeconds !== undefined ? { durationSeconds: request.durationSeconds } : {}),
      },
    }
  }

  async poll(
    remoteId: string,
    opaqueState: Record<string, unknown> | undefined,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    if (!remoteId) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'remoteId is required for poll',
      )
    }
    const apiKey = this.resolveApiKey(config)
    const baseUrl = this.resolveBaseUrl(config)
    const endpoint = `${baseUrl}${SEEDANCE_TASKS_PATH}/${encodeURIComponent(remoteId)}`

    const response = await context.http.get(endpoint, {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: config.timeoutMs,
    })
    if (!response.ok) {
      const errorText = await response.text()
      const normalized = NormalizedProviderError.fromHttp(
        this.manifest.id,
        this.manifest.version,
        response,
        errorText,
      )
      if (normalized.diagnostic.code === 'PROVIDER_TEMPORARY_ERROR') {
        return {
          status: 'waiting',
          remoteId,
          opaqueState: opaqueState ?? { taskId: remoteId },
          retryAfterMs: parseRetryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_MS,
          error: normalized.diagnostic,
        }
      }
      return { status: 'failed', remoteId, error: normalized.diagnostic, opaqueState: opaqueState ?? { taskId: remoteId } }
    }

    const json = (await response.json()) as unknown
    const body: Record<string, unknown> = isRecord(json) ? json : {}
    const statusRaw = body['status'] ?? (isRecord(body['data']) ? body['data']['status'] : undefined)
    const status = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : ''
    const retryAfterMs = parseRetryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_MS
    const state = opaqueState ?? { taskId: remoteId }

    if (status === 'queued' || status === 'running' || status === 'pending' || status === 'processing') {
      const progressRaw = body['progress']
      const progress =
        typeof progressRaw === 'number' && Number.isFinite(progressRaw)
          ? Math.min(100, Math.max(0, progressRaw))
          : undefined
      return { status: 'waiting', remoteId, progress, retryAfterMs, opaqueState: state }
    }

    if (status === 'succeeded' || status === 'completed') {
      const content = isRecord(body['content'])
        ? body['content']
        : isRecord(body['data']) && isRecord(body['data']['content'])
          ? (body['data']['content'] as Record<string, unknown>)
          : undefined
      const videoUrl = content && typeof content['video_url'] === 'string' ? content['video_url'] : undefined
      if (!videoUrl || videoUrl.length > MAX_VIDEO_URL_CHARS) {
        return {
          status: 'failed',
          remoteId,
          opaqueState: state,
          error: NormalizedProviderError.create(
            this.manifest.id,
            this.manifest.version,
            'PROVIDER_EMPTY_RESULT',
            'Seedance task succeeded but returned no video_url',
            { providerReferenceId: this.providerReferenceId(response.headers) },
          ).diagnostic,
        }
      }
      let parsed: URL
      try {
        parsed = new URL(videoUrl)
      } catch {
        return {
          status: 'failed',
          remoteId,
          opaqueState: state,
          error: NormalizedProviderError.create(
            this.manifest.id,
            this.manifest.version,
            'PROVIDER_REJECTED',
            'Seedance returned an invalid video_url',
          ).diagnostic,
        }
      }
      if (parsed.protocol !== 'https:' || !matchesAllowedHost(parsed.hostname, this.manifest.allowedHosts)) {
        return {
          status: 'failed',
          remoteId,
          opaqueState: state,
          error: NormalizedProviderError.create(
            this.manifest.id,
            this.manifest.version,
            'UNSAFE_URL',
            'Seedance returned a video_url outside the plugin host allowlist',
          ).diagnostic,
        }
      }
      const durationRaw = content?.['duration']
      const durationSeconds =
        (typeof durationRaw === 'number' && Number.isFinite(durationRaw) ? durationRaw : undefined) ??
        (typeof state['durationSeconds'] === 'number' ? (state['durationSeconds'] as number) : undefined)
      const outputs: OutputDescriptor[] = [
        {
          index: 0,
          mimeType: 'video/mp4',
          url: videoUrl,
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          metadata: { remoteId, model: state['model'] ?? body['model'] },
        },
      ]
      return { status: 'succeeded', remoteId, outputs, opaqueState: state }
    }

    if (status === 'cancelled' || status === 'canceled') {
      return {
        status: 'canceled',
        remoteId,
        opaqueState: state,
      }
    }

    if (status === 'failed') {
      return {
        status: 'failed',
        remoteId,
        opaqueState: state,
        error: this.taskFailureError(body, response),
      }
    }

    // Forward-compatible: unknown non-terminal provider statuses keep waiting.
    return { status: 'waiting', remoteId, retryAfterMs, opaqueState: state }
  }

  async cancel(
    remoteId: string,
    opaqueState: Record<string, unknown> | undefined,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    if (!remoteId) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'remoteId is required for cancel',
      )
    }
    const apiKey = this.resolveApiKey(config)
    const baseUrl = this.resolveBaseUrl(config)
    const endpoint = `${baseUrl}${SEEDANCE_TASKS_PATH}/${encodeURIComponent(remoteId)}`
    const state = opaqueState ?? { taskId: remoteId }

    const response = await context.http.request(endpoint, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: config.timeoutMs,
    })

    // Best-effort: a missing task is already terminal — treat as canceled.
    if (response.status === 404) {
      return { status: 'canceled', remoteId, opaqueState: state }
    }
    if (!response.ok) {
      const errorText = await response.text()
      const normalized = NormalizedProviderError.fromHttp(
        this.manifest.id,
        this.manifest.version,
        response,
        errorText,
      )
      return { status: 'failed', remoteId, error: normalized.diagnostic, opaqueState: state }
    }

    let status = ''
    try {
      const json = (await response.json()) as unknown
      const body: Record<string, unknown> = isRecord(json) ? json : {}
      const raw = body['status'] ?? (isRecord(body['data']) ? body['data']['status'] : undefined)
      if (typeof raw === 'string') status = raw.toLowerCase()
    } catch {
      // Some providers return an empty 200 on delete — that means canceled.
    }
    if (status === 'cancelled' || status === 'canceled' || status === '') {
      return { status: 'canceled', remoteId, opaqueState: state }
    }
    // Cancel accepted but still draining (canceling/cancelling/running): waiting is the canceling equivalent.
    return { status: 'waiting', remoteId, retryAfterMs: 3_000, opaqueState: state }
  }

  async openOutput(
    descriptor: OutputDescriptor,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<BoundedOutput> {
    if (!descriptor.mimeType || !descriptor.mimeType.startsWith('video/')) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        `Only video outputs can be opened, got mimeType '${descriptor.mimeType}'`,
      )
    }
    if (!descriptor.url) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'Output descriptor has no url to download',
      )
    }
    let parsed: URL
    try {
      parsed = new URL(descriptor.url)
    } catch {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'UNSAFE_URL',
        'Output url is not a valid URL',
      )
    }
    if (parsed.protocol !== 'https:' || !matchesAllowedHost(parsed.hostname, this.manifest.allowedHosts)) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'UNSAFE_URL',
        'Output url is not an HTTPS provider output in the plugin host allowlist',
      )
    }
    return context.readOutput(descriptor, {
      maxBytes: config.maxBytes,
      timeoutMs: config.timeoutMs,
    })
  }

  buildGenerationsBody(request: MediaRequest): Record<string, unknown> {
    const content: SeedanceContentEntry[] = [{ type: 'text', text: request.prompt }]
    const images = request.inputImages ?? []
    if (images.length > 0) {
      const roles = this.resolveImageRoles(request, images.length)
      for (let i = 0; i < images.length; i++) {
        const img = images[i]
        const mime = img.mimeType || 'image/png'
        const b64 = typeof img.data === 'string' ? img.data : img.data.toString('base64')
        content.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${b64}` },
          role: roles[i],
        })
      }
    }
    return {
      model: request.vendorModelId,
      content,
      ...this.extractVideoControls(request),
    }
  }

  private resolveImageRoles(request: MediaRequest, count: number): SeedanceImageRole[] {
    const explicit = request.extra?.['imageRoles']
    if (Array.isArray(explicit) && explicit.length === count) {
      return (explicit as string[]).map(r => r as SeedanceImageRole)
    }
    if (count === 1) return ['reference_image']
    if (count === 2) return ['first_frame', 'last_frame']
    const roles: SeedanceImageRole[] = ['first_frame']
    for (let i = 1; i < count - 1; i++) roles.push('reference_image')
    roles.push('last_frame')
    return roles
  }

  /**
   * Forwards only the validated video controls. Unknown extra keys are dropped
   * so undocumented provider combinations can never be sent implicitly.
   */
  private extractVideoControls(request: MediaRequest): Record<string, unknown> {
    const controls: Record<string, unknown> = {}
    const extra = request.extra ?? {}

    for (const rule of SEEDANCE_VIDEO_CONTROLS) {
      const value = seedanceControlValue(rule, request, extra)
      if (value === undefined) continue
      this.assertDeclaredControl(request.vendorModelId, rule, value)
      controls[rule.wire] = value
    }

    return controls
  }

  /**
   * Refuse a control the model's own declaration does not accept, so `submit`
   * can never put an unvalidated value on the wire. Every bound is read from the
   * descriptor the console renders, which is what keeps the two in agreement.
   */
  private assertDeclaredControl(modelId: string, rule: SeedanceVideoControl, value: unknown): void {
    if (rule.grammar) {
      if (typeof value !== 'string' || !rule.grammar.pattern.test(value)) {
        throw invalidControlRequest(rule.grammar.detail)
      }
      return
    }

    const descriptor = seedanceDescriptorFor(modelId, rule.parameter)
    if (rule.rangeOnly) {
      const range = seedanceIntegerRange(descriptor, rule.parameter)
      if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max) {
        throw invalidControlRequest(`Video control '${rule.wire}' must be a number between ${range.min} and ${range.max}`)
      }
      return
    }

    if (validateParameterValue(descriptor, value as JsonValue).length > 0) {
      throw invalidControlRequest(`Video control '${rule.wire}' must be ${seedanceControlShape(descriptor)}`)
    }
  }

  private resolveApiKey(config: ProviderConfig): string {
    if (config.credential?.apiKey) return config.credential.apiKey
    if (typeof config.apiKey === 'string' && config.apiKey) return config.apiKey as string
    return ''
  }

  private resolveBaseUrl(config: ProviderConfig): string {
    const explicit = config.credential?.baseUrl || config.baseUrl
    if (explicit) {
      const raw = explicit.replace(/\/$/, '')
      return raw.endsWith('/api/v3') ? raw : `${raw}/api/v3`
    }
    const regionRaw = readExtra(config, 'region')
    const region = typeof regionRaw === 'string' ? regionRaw.toLowerCase() : ''
    if (region === 'byteplus' || region === 'ap-southeast' || region.includes('byteplus')) {
      return SEEDANCE_BYTEPLUS_BASE_URL
    }
    return SEEDANCE_CN_BASE_URL
  }

  private resolveClientRequestId(config: ProviderConfig): string | undefined {
    for (const key of ['clientRequestId', 'clientToken', 'x-client-request-id']) {
      const value = readExtra(config, key)
      if (typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._~+/-]+$/.test(value)) {
        return value
      }
    }
    const header = config.customHeaders?.['x-client-request-id']
    if (typeof header === 'string' && header.length > 0 && header.length <= 128) return header
    return undefined
  }

  private providerReferenceId(headers: Headers): string | undefined {
    return (
      headers.get('x-request-id') ||
      headers.get('x-tt-logid') ||
      headers.get('x-volc-trace-id') ||
      undefined
    )
  }

  private taskFailureError(
    body: Record<string, unknown>,
    response: { headers: Headers },
  ) {
    const err = isRecord(body['error']) ? body['error'] : undefined
    const code = err && typeof err['code'] === 'string' ? (err['code'] as string) : undefined
    const message = err && typeof err['message'] === 'string' ? (err['message'] as string) : undefined
    const detail = `Seedance task failed${code ? ` [${code}]` : ''}${message ? `: ${message}` : ''}`
    return NormalizedProviderError.create(this.manifest.id, this.manifest.version, 'PROVIDER_REJECTED', detail, {
      providerReferenceId: this.providerReferenceId(response.headers),
    }).diagnostic
  }
}

export const seedanceVideoPlugin = new SeedanceVideoPlugin()
