import type {
  BooleanParameterDescriptor,
  ImageSizeConstraints,
  ImageSizeParameterDescriptor,
  ImageSizePreset,
  InputSlotDescriptor,
  IntegerParameterDescriptor,
  JsonValue,
  ModelCapabilities,
} from '@musecanvas/contracts'
import { describeImageSize, validateImageSizeValue, validateParameterValue } from '@musecanvas/contracts'
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
import { inspectDecodedImageOutput } from '../../core/output-image'
import { validateInputImages } from '../../core/image-input'

export const SEEDREAM_IMAGE_PLUGIN_ID = 'seedream-image'
export const SEEDREAM_IMAGE_PLUGIN_VERSION = '1.1.0'
export const LEGACY_SEEDREAM_IMAGE_PLUGIN_VERSION = '1.0.0'

const SEEDREAM_MAX_ASPECT_RATIO = 16
const SEEDREAM_MAX_BATCH_SIZE = 4
const SEEDREAM_MAX_INPUT_IMAGES = 4
const MAX_PROMPT_CHARS = 8_000

export const SEEDREAM_IMAGE_SUPPORTED_MODELS = [
  'doubao-seedream-4-0-250828',
  'doubao-seedream-4-5-251128',
] as const

// ---------------------------------------------------------------------------
// Capability declaration
//
// This block *is* Seedream's parameter contract: it is what `GET /api/models`
// serves, what the browser renders and what `validateRequest` below enforces.
// There is deliberately no second table of pixel bands in this file, because the
// previous one (`seedreamRules`) and the declaration disagreed the moment one of
// them was edited.
//
// The size grids are the values the admin presets already offered, so widening
// the declaration to presets changes nothing that worked before; `allowCustom`
// plus `constraints` is what keeps an unlisted in-band size legal.
// ---------------------------------------------------------------------------

const seedream1kSizes = [
  '1024x1024', '1152x864', '864x1152', '1280x720', '720x1280', '1248x832', '832x1248', '1512x648',
]
const seedream2kSizes = [
  '2048x2048', '2304x1728', '1728x2304', '2848x1600', '1600x2848', '2496x1664', '1664x2496', '3136x1344',
]
const seedream4kSizes = [
  '4096x4096', '4704x3520', '3520x4704', '5504x3040', '3040x5504', '4992x3328', '3328x4992', '6240x2656',
]

/** Bands shared by every Seedream model; only the pixel floor differs per model. */
const seedreamBaseSizeConstraints: ImageSizeConstraints = {
  maxPixels: 4096 * 4096,
  maxAspectRatio: SEEDREAM_MAX_ASPECT_RATIO,
}

function seedreamSizePresets(values: readonly string[]): ImageSizePreset[] {
  return values.map(value => {
    const [width, height] = value.split('x').map(Number)
    const preset: ImageSizePreset = { value, width, height, label: value }
    return { ...preset, label: describeImageSize(preset) }
  })
}

function seedreamSizeParameter(presets: readonly string[], minPixels: number): ImageSizeParameterDescriptor {
  return {
    type: 'image-size',
    name: 'size',
    label: '尺寸',
    presets: seedreamSizePresets(presets),
    allowCustom: true,
    constraints: { ...seedreamBaseSizeConstraints, minPixels },
    // The body builder's fallback when the caller sent no size at all.
    defaultValue: '2048x2048',
    ui: { control: 'size-picker' },
  }
}

const seedream40SizeParameter = seedreamSizeParameter(
  [...seedream1kSizes, ...seedream2kSizes, ...seedream4kSizes],
  1280 * 720,
)
const seedream45SizeParameter = seedreamSizeParameter(
  [...seedream2kSizes, ...seedream4kSizes],
  2560 * 1440,
)
// 5.0 lite is not served by this plugin version — it is absent from
// `SEEDREAM_IMAGE_SUPPORTED_MODELS` and declares no manifest entry — but
// `normalizeSeedreamSize` has always answered for it, so its band stays here as
// a declaration too rather than as a second arithmetic table.
const seedream50LiteSizeParameter: ImageSizeParameterDescriptor = {
  ...seedream45SizeParameter,
  presets: seedreamSizePresets(seedream2kSizes),
  constraints: {
    minPixels: 2560 * 1440,
    maxPixels: 10_404_496,
    maxAspectRatio: SEEDREAM_MAX_ASPECT_RATIO,
  },
}

const seedreamCountParameter: IntegerParameterDescriptor = {
  type: 'integer',
  name: 'count',
  label: '数量',
  min: 1,
  max: SEEDREAM_MAX_BATCH_SIZE,
  defaultValue: 1,
}

// Declared because the body builder really does put `watermark` on the wire
// (`watermark: request.watermark ?? false`). `quality` is *not* declared: the
// vendor accepts no quality token for these models, so advertising one would be
// the invented-parameter bug this contract exists to remove.
const seedreamWatermarkParameter: BooleanParameterDescriptor = {
  type: 'boolean',
  name: 'watermark',
  label: '水印',
  defaultValue: false,
}

const seedreamSharedParameters: Array<IntegerParameterDescriptor | BooleanParameterDescriptor> = [
  seedreamCountParameter,
  seedreamWatermarkParameter,
]

const seedreamInputSlots: InputSlotDescriptor[] = [
  {
    role: 'reference_image',
    required: false,
    minCount: 0,
    maxCount: SEEDREAM_MAX_INPUT_IMAGES,
    allowedMediaKinds: ['image'],
    label: '参考图',
  },
]

function seedreamCapabilities(size: ImageSizeParameterDescriptor): ModelCapabilities {
  return {
    modes: ['text_to_image', 'image_to_image'],
    parameters: [size, ...seedreamSharedParameters],
    inputSlots: seedreamInputSlots,
    maxCount: SEEDREAM_MAX_BATCH_SIZE,
    supportedMediaKinds: ['image'],
    // mask / inpainting / transparentBackground stay absent: nothing in this
    // plugin sends them and the vendor docs at hand do not confirm them.
    flags: { textToImage: true, imageToImage: true, imageEdit: true },
    declaredBy: 'plugin-manifest',
  }
}

const seedream40Capabilities = seedreamCapabilities(seedream40SizeParameter)
const seedream45Capabilities = seedreamCapabilities(seedream45SizeParameter)

const seedreamDefaults: Record<string, JsonValue> = {
  size: '2048x2048',
  count: 1,
  watermark: false,
}

function seedreamSizeParameterFor(vendorModelId?: string): ImageSizeParameterDescriptor {
  const id = (vendorModelId || '').toLowerCase()
  if ((id.includes('5-0') || id.includes('5.0')) && id.includes('lite')) return seedream50LiteSizeParameter
  if (id.includes('4-5') || id.includes('4.5')) return seedream45SizeParameter
  return seedream40SizeParameter
}

/**
 * Wire-format guard for a Seedream `size`.
 *
 * Kept stricter than the contract's `WIDTHxHEIGHT` pattern on purpose: leading
 * zeros and a zero edge have never been sendable, and a size accepted here goes
 * straight into the request body. Geometry is not decided here — each model's
 * own `image-size` declaration above answers that.
 */
const SEEDREAM_WIRE_SIZE_PATTERN = /^([1-9]\d*)x([1-9]\d*)$/

export function normalizeSeedreamSize(size: string, vendorModelId?: string): string {
  if (!SEEDREAM_WIRE_SIZE_PATTERN.test(size)) throw new Error('INVALID_IMAGE_SIZE')
  if (validateImageSizeValue(seedreamSizeParameterFor(vendorModelId), size).length > 0) {
    throw new Error('INVALID_IMAGE_SIZE')
  }
  return size
}

function buildManifest(version: string, active: boolean): MediaProviderManifest {
  // The contract rides only on the active version: already-pinned 1.0.0
  // revisions resolve against a manifest that stayed deliberately thin, and
  // tightening it there would retroactively make a working revision illegal.
  return {
    kind: 'media',
    id: SEEDREAM_IMAGE_PLUGIN_ID,
    version,
    displayName: 'Seedream (Volcengine Ark) Image Generation',
    modalities: ['image'],
    description: active
      ? 'ByteDance Seedream image generation models via Volcengine Ark API pinned to ark.cn-beijing.volces.com (compatible endpoints remain on legacy 1.0.0)'
      : 'ByteDance Seedream image generation models via Volcengine Ark API',
    allowedHosts: ['ark.cn-beijing.volces.com', '*.volces.com'],
    credentialSchemas: ['legacy-api-key-v1', 'json-v1'],
    models: [
      {
        id: 'doubao-seedream-4-0-250828',
        modalities: ['image'],
        supportedAspectRatios: ['1024x1024', '2048x2048'],
        maxBatchSize: 4,
        ...(active
          ? { maxInputImages: 4, capabilities: seedream40Capabilities, defaults: seedreamDefaults }
          : {}),
      },
      {
        id: 'doubao-seedream-4-5-251128',
        modalities: ['image'],
        supportedAspectRatios: ['2048x2048'],
        maxBatchSize: 4,
        ...(active
          ? { maxInputImages: 4, capabilities: seedream45Capabilities, defaults: seedreamDefaults }
          : {}),
      },
    ],
  }
}

export const seedreamImageManifest: MediaProviderManifest = buildManifest(SEEDREAM_IMAGE_PLUGIN_VERSION, true)
export const legacySeedreamImageManifest: MediaProviderManifest = buildManifest(LEGACY_SEEDREAM_IMAGE_PLUGIN_VERSION, false)

function invalidRequest(version: string, detail: string): NormalizedProviderError {
  return NormalizedProviderError.create(SEEDREAM_IMAGE_PLUGIN_ID, version, 'INVALID_REQUEST', detail)
}

function inputImageBytes(request: MediaRequest): Buffer[] {
  return (request.inputImages ?? []).map(img =>
    typeof img.data === 'string' ? Buffer.from(img.data, 'base64') : img.data,
  )
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function endpointAuthHosts(endpoint: string): string[] {
  try {
    return [new URL(endpoint).hostname]
  } catch {
    return []
  }
}

function declaredParameter<T extends { name: string }>(
  parameters: readonly unknown[],
  name: string,
): T | undefined {
  return parameters.find(
    candidate => typeof candidate === 'object' && candidate !== null && (candidate as { name?: unknown }).name === name,
  ) as T | undefined
}

/**
 * Request validation reads the manifest declaration above rather than a private
 * rules table, so the browser's controls, the API's authoritative check and the
 * adapter that ships the bytes all answer from one statement.
 */
function validateSharedRequest(request: MediaRequest, manifest: MediaProviderManifest): void {
  const version = manifest.version
  if (request.modality !== 'image') {
    throw invalidRequest(version, `Only image modality is supported, got '${request.modality}'`)
  }
  if (!request.prompt || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
    throw invalidRequest(version, 'Prompt must be a non-empty string')
  }
  if (request.prompt.length > MAX_PROMPT_CHARS) {
    throw invalidRequest(version, `Prompt exceeds maximum length of ${MAX_PROMPT_CHARS} characters`)
  }
  if (!(SEEDREAM_IMAGE_SUPPORTED_MODELS as readonly string[]).includes(request.vendorModelId)) {
    throw invalidRequest(
      version,
      `Unsupported model '${request.vendorModelId}'; supported models: ${SEEDREAM_IMAGE_SUPPORTED_MODELS.join(', ')}`,
    )
  }
  const model: MediaModelDeclaration | undefined = manifest.models?.find(candidate => candidate.id === request.vendorModelId)
  const capabilities = model?.capabilities
  if (!capabilities) {
    // Unreachable for this manifest — both supported models declare a contract,
    // and an id outside them was just rejected. Refusing rather than falling back
    // to a hardcoded band is the point: no declaration means no guess.
    throw invalidRequest(version, `Model '${request.vendorModelId}' declares no parameter contract`)
  }

  const sizeParameter = declaredParameter<ImageSizeParameterDescriptor>(capabilities.parameters, 'size')
  const countParameter = declaredParameter<IntegerParameterDescriptor>(capabilities.parameters, 'count')
  const watermarkParameter = declaredParameter<BooleanParameterDescriptor>(capabilities.parameters, 'watermark')
  if (!sizeParameter || !countParameter) {
    throw invalidRequest(
      version,
      `Model '${request.vendorModelId}' declares no ${sizeParameter ? 'count' : 'size'} parameter`,
    )
  }

  // `width`/`height` are the pre-descriptor typed fields: nothing builds them
  // today, but when a caller does send them they mean the same size and are
  // checked as one, so the declaration cannot be sidestepped by field choice.
  const rawSize = request.size ?? (request.width !== undefined && request.height !== undefined
    ? `${request.width}x${request.height}`
    : undefined)
  if (rawSize !== undefined) {
    // Two predicates, both read from the same place the adapter reads: the wire
    // pattern is what `normalizeSeedreamSize` can actually put in the body (so
    // validation never passes a size the body builder then throws on), and the
    // descriptor decides geometry.
    if (!SEEDREAM_WIRE_SIZE_PATTERN.test(rawSize)
      || validateParameterValue(sizeParameter, rawSize).length > 0) {
      throw invalidRequest(version, `Invalid size for model ${request.vendorModelId}: ${rawSize}`)
    }
  }

  const count = request.count ?? countParameter.defaultValue ?? 1
  const countIssues = validateParameterValue(countParameter, count)
  if (countIssues.length > 0) {
    throw invalidRequest(
      version,
      `count must be an integer between ${countParameter.min ?? 1} and ${countParameter.max ?? SEEDREAM_MAX_BATCH_SIZE} for model ${request.vendorModelId}`,
    )
  }

  if (watermarkParameter && request.watermark !== undefined) {
    if (validateParameterValue(watermarkParameter, request.watermark).length > 0) {
      throw invalidRequest(version, `watermark must be a boolean for model ${request.vendorModelId}`)
    }
  }

  const images = request.inputImages ?? []
  for (const img of images) {
    if (img.mimeType !== 'image/png' && img.mimeType !== 'image/jpeg') {
      throw invalidRequest(version, `Unsupported input image mimeType '${img.mimeType}'`)
    }
  }
  try {
    validateInputImages(inputImageBytes(request).map(data => ({ data })))
  } catch (err: unknown) {
    throw invalidRequest(
      version,
      `Invalid input image: ${err instanceof Error ? err.message : 'validation failed'}`,
    )
  }
}

export class SeedreamImagePlugin implements MediaProviderPlugin {
  readonly manifest = seedreamImageManifest

  async probe(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult> {
    this.validateConfig(config)
    const start = Date.now()
    const baseUrl = this.resolveBaseUrl(config)
    const apiKey = this.resolveApiKey(config)
    const endpoint = `${baseUrl}/models`

    try {
      const res = await context.http.get(endpoint, {
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        timeoutMs: config.timeoutMs ?? 15_000,
        allowedHosts: endpointAuthHosts(endpoint),
      })
      if (!res.ok) {
        const text = await res.text()
        return {
          healthy: false,
          message: `Probe failed with HTTP ${res.status}: ${text}`,
          latencyMs: Date.now() - start,
        }
      }
      return {
        healthy: true,
        latencyMs: Date.now() - start,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown probe error'
      return {
        healthy: false,
        message,
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
        'Seedream Ark API key is missing in provider config',
      )
    }

    const effectiveBase = config.credential?.baseUrl || config.baseUrl || 'https://ark.cn-beijing.volces.com'
    try {
      const u = new URL(effectiveBase)
      if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'ark.cn-beijing.volces.com') {
        throw new Error(`baseUrl host must be ark.cn-beijing.volces.com, got '${u.hostname}'`)
      }
    } catch (err: unknown) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_CONFIG',
        `Invalid baseUrl '${effectiveBase}': ${err instanceof Error ? err.message : ''}`,
      )
    }
  }

  validateRequest(request: MediaRequest): void {
    validateSharedRequest(request, this.manifest)
  }

  async submit(
    request: MediaRequest,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    this.validateRequest(request)

    const apiKey = this.resolveApiKey(config)
    const baseUrl = this.resolveBaseUrl(config)
    const endpoint = `${baseUrl}/images/generations`

    // Transport failures (temporary/timeout) propagate as thrown
    // NormalizedProviderError; only deterministic HTTP 4xx becomes failed.
    const body = JSON.stringify(this.buildGenerationBody(request))
    const response = await context.http.post(endpoint, body, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      timeoutMs: config.timeoutMs,
      allowedHosts: endpointAuthHosts(endpoint),
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
        throw normalized
      }
      return {
        status: 'failed',
        error: normalized.diagnostic,
      }
    }

    type SeedreamResponsePayload = {
      data?: Array<{
        url?: string
        b64_json?: string
        error?: unknown
      }>
    }

    let json: SeedreamResponsePayload
    try {
      json = await response.json<SeedreamResponsePayload>()
    } catch {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'Seedream returned an unreadable response payload',
        ).diagnostic,
      }
    }
    if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'Seedream returned empty data array',
        ).diagnostic,
      }
    }

    const count = request.count || 1
    const outputs: OutputDescriptor[] = []
    for (const item of json.data) {
      const hasUrl = typeof item.url === 'string' && item.url.length > 0
      const hasB64 = typeof item.b64_json === 'string' && item.b64_json.length > 0
      if (hasUrl === hasB64) continue
      if (hasUrl && !isHttpsUrl(item.url as string)) continue
      outputs.push({
        index: outputs.length,
        mimeType: 'image/png',
        url: hasUrl ? (item.url as string) : undefined,
        b64Json: hasB64 ? (item.b64_json as string) : undefined,
      })
      if (outputs.length >= count) break
    }
    if (outputs.length === 0) {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'Seedream returned no successful image outputs',
        ).diagnostic,
      }
    }

    return {
      status: 'succeeded',
      outputs,
    }
  }

  async openOutput(
    descriptor: OutputDescriptor,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<BoundedOutput> {
    const version = this.manifest.version
    const hasUrl = typeof descriptor.url === 'string' && descriptor.url.length > 0
    const hasB64 = typeof descriptor.b64Json === 'string' && descriptor.b64Json.length > 0
    if (hasUrl === hasB64) {
      throw invalidRequest(version, 'Output descriptor must contain exactly one of url or b64Json')
    }
    if (hasUrl && !isHttpsUrl(descriptor.url as string)) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        version,
        'UNSAFE_URL',
        'Output URL must use HTTPS',
      )
    }
    if (descriptor.mimeType !== 'image/png' && descriptor.mimeType !== 'image/jpeg') {
      throw invalidRequest(version, `Only PNG/JPEG outputs can be opened, got mimeType '${descriptor.mimeType}'`)
    }
    const output = await context.readOutput(descriptor, {
      maxBytes: config.maxBytes,
      timeoutMs: config.timeoutMs,
    })
    const decoded = await inspectDecodedImageOutput(output.data, output.mimeType, {
      pluginId: this.manifest.id,
      version,
    })
    return {
      ...output,
      mimeType: decoded.mimeType,
      width: decoded.width,
      height: decoded.height,
      sizeBytes: output.data.length,
    }
  }

  private resolveApiKey(config: ProviderConfig): string {
    if (config.credential?.apiKey) return config.credential.apiKey
    if (typeof config.apiKey === 'string' && config.apiKey) return config.apiKey
    return ''
  }

  private resolveBaseUrl(config: ProviderConfig): string {
    const raw = (
      config.credential?.baseUrl ||
      config.baseUrl ||
      'https://ark.cn-beijing.volces.com'
    ).replace(/\/$/, '')
    return raw.endsWith('/api/v3') ? raw : `${raw}/api/v3`
  }

  buildGenerationBody(request: MediaRequest): Record<string, unknown> {
    const inputImages = request.inputImages || []
    let imageField: string | string[] | undefined

    if (inputImages.length > 0) {
      const urls = inputImages.map(img => {
        const mime = img.mimeType || 'image/png'
        const b64 =
          typeof img.data === 'string'
            ? img.data
            : img.data.toString('base64')
        return `data:${mime};base64,${b64}`
      })
      imageField = urls.length === 1 ? urls[0] : urls
    }

    const size = request.size
      ? normalizeSeedreamSize(request.size, request.vendorModelId)
      : '2048x2048'

    const count = request.count || 1

    return {
      model: request.vendorModelId,
      prompt: request.prompt,
      ...(imageField !== undefined ? { image: imageField } : {}),
      size,
      response_format: 'url',
      watermark: request.watermark ?? false,
      stream: false,
      ...(count > 1
        ? {
            sequential_image_generation: 'auto',
            sequential_image_generation_options: { max_images: count },
          }
        : {}),
    }
  }
}

/**
 * Legacy 1.0.0 Seedream image plugin retained verbatim for already-pinned
 * revisions. New presets/revisions must use the active 1.1.0 plugin.
 */
export class LegacySeedreamImagePlugin implements MediaProviderPlugin {
  readonly manifest = legacySeedreamImageManifest

  async probe(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult> {
    const start = Date.now()
    const apiKey = this.resolveApiKey(config)
    const baseUrl = this.resolveBaseUrl(config)
    const endpoint = `${baseUrl}/images/generations`

    try {
      // Send lightweight dry-run / ping request
      const res = await context.http.post(
        endpoint,
        JSON.stringify({
          model: 'doubao-seedream-4-0-250828',
          prompt: 'ping',
          size: '1024x1024',
        }),
        {
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          timeoutMs: config.timeoutMs ?? 15_000,
        },
      )
      // Even if 400 or 401, if transport connects we know network is reachable
      return {
        healthy: res.status < 500,
        latencyMs: Date.now() - start,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown probe error'
      return {
        healthy: false,
        message,
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
        'Seedream Ark API key is missing in provider config',
      )
    }

    if (config.baseUrl) {
      try {
        const u = new URL(config.baseUrl)
        if (u.protocol !== 'https:') {
          throw new Error('baseUrl must use https:')
        }
      } catch (err: unknown) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_CONFIG',
          `Invalid baseUrl '${config.baseUrl}': ${err instanceof Error ? err.message : ''}`,
        )
      }
    }
  }

  validateRequest(request: MediaRequest): void {
    if (!request.prompt || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'Prompt must be a non-empty string',
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

    if (request.size) {
      try {
        normalizeSeedreamSize(request.size, request.vendorModelId)
      } catch (err: unknown) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          `Invalid size for model ${request.vendorModelId}: ${request.size}`,
        )
      }
    }
  }

  async submit(
    request: MediaRequest,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    this.validateRequest(request)

    const apiKey = this.resolveApiKey(config)
    const baseUrl = this.resolveBaseUrl(config)
    const endpoint = `${baseUrl}/images/generations`

    const body = JSON.stringify(this.buildGenerationBody(request))
    const response = await context.http.post(endpoint, body, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
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
      return {
        status: 'failed',
        error: normalized.diagnostic,
      }
    }

    type SeedreamResponsePayload = {
      data?: Array<{
        url?: string
        b64_json?: string
        error?: unknown
      }>
    }

    const json = await response.json<SeedreamResponsePayload>()
    if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'Seedream returned empty data array',
        ).diagnostic,
      }
    }

    const count = request.count || 1
    const successful = json.data
      .filter(item => Boolean(item.url || item.b64_json))
      .slice(0, count)
    if (successful.length === 0) {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'Seedream returned no successful image outputs',
        ).diagnostic,
      }
    }

    const outputs: OutputDescriptor[] = successful.map((item, index) => ({
      index,
      mimeType: 'image/png',
      url: item.url,
      b64Json: item.b64_json,
    }))

    return {
      status: 'succeeded',
      outputs,
    }
  }

  async openOutput(
    descriptor: OutputDescriptor,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<BoundedOutput> {
    return context.readOutput(descriptor, {
      maxBytes: config.maxBytes,
      timeoutMs: config.timeoutMs,
    })
  }

  private resolveApiKey(config: ProviderConfig): string {
    if (config.credential?.apiKey) return config.credential.apiKey
    if (typeof config.apiKey === 'string' && config.apiKey) return config.apiKey
    return ''
  }

  private resolveBaseUrl(config: ProviderConfig): string {
    const raw = (
      config.credential?.baseUrl ||
      config.baseUrl ||
      'https://ark.cn-beijing.volces.com'
    ).replace(/\/$/, '')
    return raw.endsWith('/api/v3') ? raw : `${raw}/api/v3`
  }

  buildGenerationBody(request: MediaRequest): Record<string, unknown> {
    const inputImages = request.inputImages || []
    let imageField: string | string[] | undefined

    if (inputImages.length > 0) {
      const urls = inputImages.map(img => {
        const mime = img.mimeType || 'image/png'
        const b64 =
          typeof img.data === 'string'
            ? img.data
            : img.data.toString('base64')
        return `data:${mime};base64,${b64}`
      })
      imageField = urls.length === 1 ? urls[0] : urls
    }

    const size = request.size
      ? normalizeSeedreamSize(request.size, request.vendorModelId)
      : '2048x2048'

    const count = request.count || 1

    return {
      model: request.vendorModelId,
      prompt: request.prompt,
      ...(imageField !== undefined ? { image: imageField } : {}),
      size,
      response_format: 'url',
      watermark: request.watermark ?? false,
      stream: false,
      ...(count > 1
        ? {
            sequential_image_generation: 'auto',
            sequential_image_generation_options: { max_images: count },
          }
        : {}),
    }
  }
}

export const seedreamImagePlugin = new SeedreamImagePlugin()
export const legacySeedreamImagePlugin = new LegacySeedreamImagePlugin()
