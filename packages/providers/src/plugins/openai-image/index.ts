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

export const OPENAI_IMAGE_PLUGIN_ID = 'openai-image'
export const OPENAI_IMAGE_PLUGIN_VERSION = '1.0.0'

export const openAiImageManifest: MediaProviderManifest = {
  id: OPENAI_IMAGE_PLUGIN_ID,
  version: OPENAI_IMAGE_PLUGIN_VERSION,
  displayName: 'OpenAI Image Generation & Editing',
  modalities: ['image'],
  description: 'OpenAI DALL-E / GPT Image generations and edits via official or compatible APIs',
  allowedHosts: [
    'api.openai.com',
    '*.openai.com',
    'oaidalleapiprodscus.blob.core.windows.net',
    '*.blob.core.windows.net',
  ],
  credentialSchemas: ['legacy-api-key-v1', 'json-v1'],
  models: [
    {
      id: 'gpt-image-2',
      modalities: ['image'],
      supportedAspectRatios: ['1024x1024', '1536x1024', '1024x1536'],
      maxBatchSize: 4,
    },
    {
      id: 'dall-e-3',
      modalities: ['image'],
      supportedAspectRatios: ['1024x1024', '1792x1024', '1024x1792'],
      maxBatchSize: 1,
    },
  ],
}

export class OpenAiImagePlugin implements MediaProviderPlugin {
  readonly manifest = openAiImageManifest

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
