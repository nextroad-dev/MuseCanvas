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

export const OPENAI_IMAGE_PLUGIN_ID = 'openai-image'
export const OPENAI_IMAGE_PLUGIN_VERSION = '1.1.0'
export const LEGACY_OPENAI_IMAGE_PLUGIN_VERSION = '1.0.0'

const OPENAI_ALLOWED_HOSTS = [
  'api.openai.com',
  '*.openai.com',
  'oaidalleapiprodscus.blob.core.windows.net',
  '*.blob.core.windows.net',
]
const OPENAI_CREDENTIAL_SCHEMAS = ['legacy-api-key-v1', 'json-v1']

const MAX_PROMPT_CHARS = 8_000

const OPENAI_IMAGE_MODEL_RULES: Record<string, { sizes: string[]; maxBatchSize: number; qualities: string[] }> = {
  'gpt-image-2': {
    sizes: ['1024x1024', '1280x720', '720x1280', '1536x1024', '1024x1536'],
    maxBatchSize: 4,
    qualities: ['auto', 'low', 'medium', 'high'],
  },
  'dall-e-3': {
    sizes: ['1024x1024', '1792x1024', '1024x1792'],
    maxBatchSize: 1,
    qualities: ['standard', 'hd'],
  },
}

export const OPENAI_IMAGE_SUPPORTED_MODELS = Object.keys(OPENAI_IMAGE_MODEL_RULES)

function buildManifest(version: string, active: boolean): MediaProviderManifest {
  return {
    id: OPENAI_IMAGE_PLUGIN_ID,
    version,
    displayName: 'OpenAI Image Generation & Editing',
    modalities: ['image'],
    description: active
      ? 'OpenAI DALL-E / GPT Image generations and edits via the official API pinned to api.openai.com (compatible endpoints remain on legacy 1.0.0)'
      : 'OpenAI DALL-E / GPT Image generations and edits via official or compatible APIs',
    allowedHosts: [...OPENAI_ALLOWED_HOSTS],
    credentialSchemas: [...OPENAI_CREDENTIAL_SCHEMAS],
    models: [
      {
        id: 'gpt-image-2',
        modalities: ['image'],
        supportedAspectRatios: ['1024x1024', '1536x1024', '1024x1536'],
        maxBatchSize: 4,
        ...(active ? { maxInputImages: 4 } : {}),
      },
      {
        id: 'dall-e-3',
        modalities: ['image'],
        supportedAspectRatios: ['1024x1024', '1792x1024', '1024x1792'],
        maxBatchSize: 1,
        ...(active ? { maxInputImages: 0 } : {}),
      },
    ],
  }
}

export const openAiImageManifest: MediaProviderManifest = buildManifest(OPENAI_IMAGE_PLUGIN_VERSION, true)
export const legacyOpenAiImageManifest: MediaProviderManifest = buildManifest(LEGACY_OPENAI_IMAGE_PLUGIN_VERSION, false)

function invalidRequest(version: string, detail: string): NormalizedProviderError {
  return NormalizedProviderError.create(OPENAI_IMAGE_PLUGIN_ID, version, 'INVALID_REQUEST', detail)
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

export class OpenAiImagePlugin implements MediaProviderPlugin {
  readonly manifest = openAiImageManifest

  async probe(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult> {
    this.validateConfig(config)
    const start = Date.now()
    const baseUrl = this.resolveBaseUrl(config)
    const apiKey = this.resolveApiKey(config)
    const endpoint = `${baseUrl}/models`

    try {
      const res = await context.http.get(endpoint, {
        headers: { authorization: `Bearer ${apiKey}` },
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
        'OpenAI API key is missing in provider config',
      )
    }

    const effectiveBase = config.credential?.baseUrl || config.baseUrl || 'https://api.openai.com'
    try {
      const u = new URL(effectiveBase)
      if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'api.openai.com') {
        throw new Error(`baseUrl host must be api.openai.com, got '${u.hostname}'`)
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
    const version = this.manifest.version
    if (request.modality !== 'image') {
      throw invalidRequest(version, `Only image modality is supported, got '${request.modality}'`)
    }
    if (!request.prompt || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw invalidRequest(version, 'Prompt must be a non-empty string')
    }
    if (request.prompt.length > MAX_PROMPT_CHARS) {
      throw invalidRequest(version, `Prompt exceeds maximum length of ${MAX_PROMPT_CHARS} characters`)
    }

    const rule = OPENAI_IMAGE_MODEL_RULES[request.vendorModelId]
    if (!rule) {
      throw invalidRequest(
        version,
        `Unsupported model '${request.vendorModelId}'; supported models: ${OPENAI_IMAGE_SUPPORTED_MODELS.join(', ')}`,
      )
    }

    if (request.size !== undefined && !rule.sizes.includes(request.size)) {
      throw invalidRequest(
        version,
        `Invalid size '${request.size}' for model ${request.vendorModelId}; supported: ${rule.sizes.join(', ')}`,
      )
    }

    const count = request.count ?? 1
    if (!Number.isInteger(count) || count < 1 || count > rule.maxBatchSize) {
      throw invalidRequest(
        version,
        `count must be an integer between 1 and ${rule.maxBatchSize} for model ${request.vendorModelId}`,
      )
    }

    if (request.quality !== undefined && !rule.qualities.includes(request.quality)) {
      throw invalidRequest(
        version,
        `Invalid quality '${request.quality}' for model ${request.vendorModelId}; supported: ${rule.qualities.join(', ')}`,
      )
    }

    const images = request.inputImages ?? []
    if (images.length > 0 && request.vendorModelId === 'dall-e-3') {
      throw invalidRequest(version, 'Model dall-e-3 does not support reference images or edits')
    }
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

  async submit(
    request: MediaRequest,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    this.validateRequest(request)

    const apiKey = this.resolveApiKey(config)
    const baseUrl = this.resolveBaseUrl(config)
    const hasImages = Array.isArray(request.inputImages) && request.inputImages.length > 0

    const endpoint = `${baseUrl}/${hasImages ? 'images/edits' : 'images/generations'}`

    // Transport failures (temporary/timeout) propagate as thrown
    // NormalizedProviderError; only deterministic HTTP 4xx becomes failed.
    let response
    if (hasImages) {
      const form = this.buildEditFormData(request)
      response = await context.http.post(endpoint, form, {
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        timeoutMs: config.timeoutMs,
        allowedHosts: endpointAuthHosts(endpoint),
      })
    } else {
      const body = JSON.stringify(this.buildGenerationBody(request))
      response = await context.http.post(endpoint, body, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        timeoutMs: config.timeoutMs,
        allowedHosts: endpointAuthHosts(endpoint),
      })
    }

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

    type OpenAiResponsePayload = {
      data?: Array<{
        b64_json?: string
        url?: string
      }>
    }

    let json: OpenAiResponsePayload
    try {
      json = await response.json<OpenAiResponsePayload>()
    } catch {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'OpenAI returned an unreadable response payload',
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
          'OpenAI returned empty data array',
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
          'OpenAI returned no usable image outputs',
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
    const raw = (config.credential?.baseUrl || config.baseUrl || 'https://api.openai.com').replace(
      /\/$/,
      '',
    )
    return raw.endsWith('/v1') ? raw : `${raw}/v1`
  }

  private buildGenerationBody(request: MediaRequest): Record<string, unknown> {
    if (request.vendorModelId === 'dall-e-3') {
      return {
        model: request.vendorModelId,
        prompt: request.prompt,
        size: request.size || '1024x1024',
        ...(request.quality ? { quality: request.quality } : {}),
        response_format: 'b64_json',
        n: 1,
      }
    }
    return {
      model: request.vendorModelId,
      prompt: request.prompt,
      size: request.size || '1024x1024',
      ...(request.quality ? { quality: request.quality } : {}),
      output_format: 'png',
      n: request.count || 1,
    }
  }

  private buildEditFormData(request: MediaRequest): FormData {
    const inputImages = request.inputImages || []
    const form = new FormData()
    form.append('model', request.vendorModelId)
    form.append('prompt', request.prompt)
    form.append('size', request.size || '1024x1024')
    form.append('output_format', 'png')
    form.append('n', String(request.count || 1))
    if (request.quality) {
      form.append('quality', request.quality)
    }

    for (let index = 0; index < inputImages.length; index++) {
      const img = inputImages[index]
      const mimeType = img.mimeType || 'image/png'
      const extension = mimeType === 'image/png' ? 'png' : 'jpg'
      const rawData =
        typeof img.data === 'string'
          ? Buffer.from(img.data, 'base64')
          : img.data
      const blobBytes = rawData.buffer instanceof ArrayBuffer
        ? new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength)
        : Uint8Array.from(rawData)

      form.append(
        'image[]',
        new Blob([blobBytes], { type: mimeType }),
        `reference-${index + 1}.${extension}`,
      )
    }

    return form
  }
}

/**
 * Legacy 1.0.0 OpenAI image plugin retained verbatim for already-pinned
 * revisions. New presets/revisions must use the active 1.1.0 plugin.
 */
export class LegacyOpenAiImagePlugin implements MediaProviderPlugin {
  readonly manifest = legacyOpenAiImageManifest

  async probe(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult> {
    const start = Date.now()
    const baseUrl = this.resolveBaseUrl(config)
    const apiKey = this.resolveApiKey(config)
    const endpoint = `${baseUrl}/models`

    try {
      const res = await context.http.get(endpoint, {
        headers: { authorization: `Bearer ${apiKey}` },
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
        'OpenAI API key is missing in provider config',
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

    if (request.count !== undefined && (request.count < 1 || request.count > 10)) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'count must be between 1 and 10',
      )
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
    const hasImages = Array.isArray(request.inputImages) && request.inputImages.length > 0

    const endpoint = `${baseUrl}/${hasImages ? 'images/edits' : 'images/generations'}`

    let response
    if (hasImages) {
      const form = this.buildEditFormData(request)
      response = await context.http.post(endpoint, form, {
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        timeoutMs: config.timeoutMs,
      })
    } else {
      const body = JSON.stringify(this.buildGenerationBody(request))
      response = await context.http.post(endpoint, body, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        timeoutMs: config.timeoutMs,
      })
    }

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

    type OpenAiResponsePayload = {
      data?: Array<{
        b64_json?: string
        url?: string
      }>
    }

    const json = await response.json<OpenAiResponsePayload>()
    if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'OpenAI returned empty data array',
        ).diagnostic,
      }
    }

    const count = request.count || 1
    const sliced = json.data.slice(0, count)

    const outputs: OutputDescriptor[] = sliced.map((item, index) => ({
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
    const raw = (config.credential?.baseUrl || config.baseUrl || 'https://api.openai.com').replace(
      /\/$/,
      '',
    )
    return raw.endsWith('/v1') ? raw : `${raw}/v1`
  }

  private buildGenerationBody(request: MediaRequest): Record<string, unknown> {
    return {
      model: request.vendorModelId,
      prompt: request.prompt,
      size: request.size || '1024x1024',
      ...(request.quality ? { quality: request.quality } : {}),
      output_format: 'png',
      n: request.count || 1,
    }
  }

  private buildEditFormData(request: MediaRequest): FormData {
    const inputImages = request.inputImages || []
    const form = new FormData()
    form.append('model', request.vendorModelId)
    form.append('prompt', request.prompt)
    form.append('size', request.size || '1024x1024')
    form.append('output_format', 'png')
    form.append('n', String(request.count || 1))
    if (request.quality) {
      form.append('quality', request.quality)
    }

    for (let index = 0; index < inputImages.length; index++) {
      const img = inputImages[index]
      const mimeType = img.mimeType || 'image/png'
      const extension = mimeType === 'image/png' ? 'png' : 'jpg'
      const rawData =
        typeof img.data === 'string'
          ? Buffer.from(img.data, 'base64')
          : img.data
      const blobBytes = rawData.buffer instanceof ArrayBuffer
        ? new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength)
        : Uint8Array.from(rawData)

      form.append(
        'image[]',
        new Blob([blobBytes], { type: mimeType }),
        `reference-${index + 1}.${extension}`,
      )
    }

    return form
  }
}

export const openAiImagePlugin = new OpenAiImagePlugin()
export const legacyOpenAiImagePlugin = new LegacyOpenAiImagePlugin()
