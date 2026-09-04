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
import { inspectDecodedImageOutput } from '../../core/output-image'
import { validateInputImages } from '../../core/image-input'

export const SEEDREAM_IMAGE_PLUGIN_ID = 'seedream-image'
export const SEEDREAM_IMAGE_PLUGIN_VERSION = '1.1.0'
export const LEGACY_SEEDREAM_IMAGE_PLUGIN_VERSION = '1.0.0'

const SEEDREAM_MAX_ASPECT_RATIO = 16
const SEEDREAM_MAX_BATCH_SIZE = 4
const MAX_PROMPT_CHARS = 8_000

export const SEEDREAM_IMAGE_SUPPORTED_MODELS = [
  'doubao-seedream-4-0-250828',
  'doubao-seedream-4-5-251128',
] as const

const seedreamRules: Record<string, { minPixels: number; maxPixels: number }> = {
  '4.0': { minPixels: 1280 * 720, maxPixels: 4096 * 4096 },
  '4.5': { minPixels: 2560 * 1440, maxPixels: 4096 * 4096 },
  '5.0-lite': { minPixels: 2560 * 1440, maxPixels: 10_404_496 },
}

export function seedreamRule(vendorModelId?: string) {
  const id = (vendorModelId || '').toLowerCase()
  if ((id.includes('5-0') || id.includes('5.0')) && id.includes('lite')) return seedreamRules['5.0-lite']
  if (id.includes('4-5') || id.includes('4.5')) return seedreamRules['4.5']
  return seedreamRules['4.0']
}

export function normalizeSeedreamSize(size: string, vendorModelId?: string): string {
  const match = size.match(/^([1-9]\d*)x([1-9]\d*)$/)
  if (!match) throw new Error('INVALID_IMAGE_SIZE')
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) throw new Error('INVALID_IMAGE_SIZE')

  const pixels = width * height
  const aspectRatio = Math.max(width / height, height / width)
  const rule = seedreamRule(vendorModelId)
  if (pixels < rule.minPixels || pixels > rule.maxPixels || aspectRatio > SEEDREAM_MAX_ASPECT_RATIO) {
    throw new Error('INVALID_IMAGE_SIZE')
  }
  return size
}

function buildManifest(version: string, active: boolean): MediaProviderManifest {
  return {
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
        ...(active ? { maxInputImages: 4 } : {}),
      },
      {
        id: 'doubao-seedream-4-5-251128',
        modalities: ['image'],
        supportedAspectRatios: ['2048x2048'],
        maxBatchSize: 4,
        ...(active ? { maxInputImages: 4 } : {}),
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

function validateSharedRequest(request: MediaRequest, version: string): void {
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
  if (request.size !== undefined) {
    try {
      normalizeSeedreamSize(request.size, request.vendorModelId)
    } catch {
      throw invalidRequest(
        version,
        `Invalid size for model ${request.vendorModelId}: ${request.size}`,
      )
    }
  }
  const count = request.count ?? 1
  if (!Number.isInteger(count) || count < 1 || count > SEEDREAM_MAX_BATCH_SIZE) {
    throw invalidRequest(
      version,
      `count must be an integer between 1 and ${SEEDREAM_MAX_BATCH_SIZE} for model ${request.vendorModelId}`,
    )
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
    validateSharedRequest(request, this.manifest.version)
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
