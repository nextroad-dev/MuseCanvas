import {
  globalProviderRegistry,
  type BoundedOutput,
  type MediaInputImage,
  type MediaRequest,
  type ProviderConfig,
} from './plugins/index'
import { OPENAI_IMAGE_PLUGIN_ID, OPENAI_IMAGE_PLUGIN_VERSION } from './plugins/openai-image/index'
import {
  SEEDREAM_IMAGE_PLUGIN_ID,
  SEEDREAM_IMAGE_PLUGIN_VERSION,
  normalizeSeedreamSize as pluginNormalizeSeedreamSize,
} from './plugins/seedream-image/index'

export type InputImage = {
  data: Buffer
  mimeType?: 'image/png' | 'image/jpeg'
  width?: number
  height?: number
  sizeBytes?: number
}

export type InspectedInputImage = {
  width: number
  height: number
  mimeType: 'image/png' | 'image/jpeg'
  sizeBytes: number
}

export type GenerateInput = {
  adapter: 'openai' | 'seedream'
  vendorModelId: string
  baseUrl?: string
  apiKey?: string
  prompt: string
  size: string
  quality?: string
  count: number
  watermark: boolean
  inputImages?: InputImage[]
}

export type GeneratedImage = {
  data: Buffer
  mimeType: string
  width: number
  height: number
}

export type ImageGenerationBody = Record<string, unknown>

export type ProviderErrorDiagnostic = {
  adapter: GenerateInput['adapter']
  status: number
  statusText: string
  endpoint: string
  detail: string
  occurredAt: string
  providerReferenceId?: string
}

export const MAX_UPLOAD_IMAGE_BYTES = 10_000_000
export const MAX_UPLOAD_TOTAL_BYTES = 20_000_000
export const MAX_INPUT_IMAGES = 4
export const MIN_INPUT_IMAGE_DIMENSION = 32
export const MAX_INPUT_IMAGE_DIMENSION = 6000
export const MAX_INPUT_IMAGE_ASPECT_RATIO = 16

export class ProviderHttpError extends Error {
  diagnostic: ProviderErrorDiagnostic
  constructor(code: 'PROVIDER_TEMPORARY_ERROR' | 'PROVIDER_REJECTED', diagnostic: ProviderErrorDiagnostic) {
    super(code)
    this.name = 'ProviderHttpError'
    this.diagnostic = diagnostic
  }
}

export function inspectInputImage(data: Buffer): InspectedInputImage {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new Error('INVALID_INPUT_IMAGE')
  }
  if (data.length > MAX_UPLOAD_IMAGE_BYTES) {
    throw new Error('INVALID_INPUT_IMAGE_SIZE')
  }

  let mimeType: 'image/png' | 'image/jpeg' | null = null
  let width = 0
  let height = 0

  if (
    data.length >= 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    if (data.subarray(12, 16).toString('latin1') !== 'IHDR') {
      throw new Error('INVALID_INPUT_IMAGE')
    }
    mimeType = 'image/png'
    width = data.readUInt32BE(16)
    height = data.readUInt32BE(20)
  } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    mimeType = 'image/jpeg'
    let offset = 2
    let found = false
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = data[offset + 1]
      if (marker === 0xff) {
        offset++
        continue
      }
      if (marker === 0xd9) break
      if (marker >= 0xd0 && marker <= 0xd7) {
        offset += 2
        continue
      }
      if (offset + 3 >= data.length) break
      const length = data.readUInt16BE(offset + 2)
      if (length < 2) break
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (offset + 9 <= data.length) {
          height = data.readUInt16BE(offset + 5)
          width = data.readUInt16BE(offset + 7)
          found = true
          break
        }
      }
      offset += 2 + length
    }
    if (!found) {
      throw new Error('INVALID_INPUT_IMAGE')
    }
  } else {
    throw new Error('INVALID_INPUT_IMAGE')
  }

  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < MIN_INPUT_IMAGE_DIMENSION ||
    width > MAX_INPUT_IMAGE_DIMENSION ||
    height < MIN_INPUT_IMAGE_DIMENSION ||
    height > MAX_INPUT_IMAGE_DIMENSION
  ) {
    throw new Error('INVALID_INPUT_IMAGE_SIZE')
  }

  const aspectRatio = Math.max(width / height, height / width)
  if (aspectRatio > MAX_INPUT_IMAGE_ASPECT_RATIO) {
    throw new Error('INVALID_INPUT_IMAGE_SIZE')
  }

  return {
    width,
    height,
    mimeType,
    sizeBytes: data.length,
  }
}

export function validateInputImages(
  inputImages?: InputImage[],
): InspectedInputImage[] {
  if (!inputImages || inputImages.length === 0) return []
  if (inputImages.length > MAX_INPUT_IMAGES) {
    throw new Error('INVALID_INPUT_IMAGE')
  }
  let totalBytes = 0
  const inspectedList: InspectedInputImage[] = []
  for (const img of inputImages) {
    if (!img || !img.data || !Buffer.isBuffer(img.data)) {
      throw new Error('INVALID_INPUT_IMAGE')
    }
    totalBytes += img.data.length
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      throw new Error('INVALID_INPUT_IMAGE_SIZE')
    }
    const inspected = inspectInputImage(img.data)
    inspectedList.push(inspected)
  }
  return inspectedList
}

export function providerEndpoint(
  adapter: GenerateInput['adapter'],
  configuredBaseUrl?: string,
  modeOrInputImages?: 'generations' | 'edits' | boolean | unknown[],
): string {
  const isEdits =
    modeOrInputImages === 'edits' ||
    modeOrInputImages === true ||
    (Array.isArray(modeOrInputImages) && modeOrInputImages.length > 0)
  const fallback =
    adapter === 'openai'
      ? process.env.OPENAI_BASE_URL || 'https://api.openai.com'
      : process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com'
  const base = (configuredBaseUrl || fallback).replace(/\/$/, '')
  if (adapter === 'openai') {
    const path = isEdits ? 'images/edits' : 'images/generations'
    return `${base.endsWith('/v1') ? base : `${base}/v1`}/${path}`
  }
  return `${base.endsWith('/api/v3') ? base : `${base}/api/v3`}/images/generations`
}

export function providerModelsEndpoint(configuredBaseUrl?: string): string {
  const base = (configuredBaseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '')
  return `${base.endsWith('/v1') ? base : `${base}/v1`}/models`
}

export function limitGeneratedImages<T>(images: T[], count: number): T[] {
  return images.slice(0, Math.max(1, count))
}

export function normalizeSeedreamSize(size: string, vendorModelId?: string): string {
  return pluginNormalizeSeedreamSize(size, vendorModelId)
}

export function imageGenerationBody(input: GenerateInput): ImageGenerationBody {
  if (input.adapter === 'openai') {
    return {
      model: input.vendorModelId,
      prompt: input.prompt,
      size: input.size,
      ...(input.quality ? { quality: input.quality } : {}),
      output_format: 'png',
      n: input.count,
    }
  }

  const hasImages = Array.isArray(input.inputImages) && input.inputImages.length > 0
  let imageField: string | string[] | undefined
  if (hasImages) {
    const inspected = validateInputImages(input.inputImages)
    const urls = input.inputImages!.map((img, index) => {
      return `data:${inspected[index].mimeType};base64,${img.data.toString('base64')}`
    })
    imageField = urls.length === 1 ? urls[0] : urls
  }

  return {
    model: input.vendorModelId,
    prompt: input.prompt,
    ...(imageField !== undefined ? { image: imageField } : {}),
    size: normalizeSeedreamSize(input.size, input.vendorModelId),
    response_format: 'url',
    watermark: input.watermark,
    stream: false,
    ...(input.count > 1
      ? {
          sequential_image_generation: 'auto',
          sequential_image_generation_options: { max_images: input.count },
        }
      : {}),
  }
}

/**
 * Compatibility wrapper implemented through the static registry.
 */
export async function generateImages(input: GenerateInput): Promise<GeneratedImage[]> {
  const pluginId =
    input.adapter === 'openai' ? OPENAI_IMAGE_PLUGIN_ID : SEEDREAM_IMAGE_PLUGIN_ID
  const version =
    input.adapter === 'openai' ? OPENAI_IMAGE_PLUGIN_VERSION : SEEDREAM_IMAGE_PLUGIN_VERSION

  const plugin = globalProviderRegistry.get(pluginId, version)

  const resolveApiKey = (envKey: string): string => {
    if (input.apiKey) return input.apiKey
    if (process.env.ALLOW_PROVIDER_ENV_FALLBACK === 'true') {
      return process.env[envKey] || ''
    }
    throw new Error('PROVIDER_NOT_CONFIGURED')
  }

  const envKey = input.adapter === 'openai' ? 'OPENAI_API_KEY' : 'ARK_API_KEY'
  const apiKey = resolveApiKey(envKey)
  if (!apiKey) {
    throw new Error('PROVIDER_NOT_CONFIGURED')
  }

  const envBaseUrl =
    input.adapter === 'openai'
      ? process.env.OPENAI_BASE_URL || 'https://api.openai.com'
      : process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com'

  const baseUrl = input.baseUrl || envBaseUrl

  // Inspect and validate inputImages if present
  let inputImages: MediaInputImage[] | undefined
  if (input.inputImages && input.inputImages.length > 0) {
    const inspected = validateInputImages(input.inputImages)
    inputImages = input.inputImages.map((img, index) => ({
      data: img.data,
      mimeType: inspected[index].mimeType,
      width: inspected[index].width,
      height: inspected[index].height,
      sizeBytes: inspected[index].sizeBytes,
    }))
  }

  const config: ProviderConfig = {
    baseUrl,
    credential: {
      schema: 'legacy-api-key-v1',
      apiKey,
      baseUrl,
    },
    timeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS || 300_000),
    maxBytes: Number(process.env.MAX_IMAGE_BYTES || 25_000_000),
  }

  const context = globalProviderRegistry.createExecutionContext(pluginId, version, {
    config,
    fetchImpl: globalThis.fetch,
  })

  const request: MediaRequest = {
    modality: 'image',
    vendorModelId: input.vendorModelId,
    prompt: input.prompt,
    size: input.size,
    quality: input.quality,
    count: input.count,
    watermark: input.watermark,
    inputImages,
  }

  const result = await plugin.submit(request, config, context)

  if (result.status === 'failed' || !result.outputs) {
    const err = result.error
    if (err) {
      if (err.code === 'PROVIDER_NOT_CONFIGURED') {
        throw new Error('PROVIDER_NOT_CONFIGURED')
      }
      if (err.code === 'PROVIDER_EMPTY_RESULT') {
        throw new Error('PROVIDER_EMPTY_RESULT')
      }
      if (err.code === 'PROVIDER_TEMPORARY_ERROR' || err.code === 'PROVIDER_REJECTED') {
        throw new ProviderHttpError(err.code, {
          adapter: input.adapter,
          status: err.status || 500,
          statusText: err.statusText || 'Error',
          endpoint: err.endpoint || '',
          detail: err.detail,
          occurredAt: err.occurredAt,
          providerReferenceId: err.providerReferenceId,
        })
      }
      throw new Error(err.code)
    }
    throw new Error('PROVIDER_EMPTY_RESULT')
  }

  const outputs = result.outputs
  if (outputs.length === 0) {
    throw new Error('PROVIDER_EMPTY_RESULT')
  }

  const generatedImages: GeneratedImage[] = await Promise.all(
    outputs.map(async desc => {
      let bounded: BoundedOutput
      try {
        if (plugin.openOutput) {
          bounded = await plugin.openOutput(desc, config, context)
        } else {
          bounded = await context.readOutput(desc, {
            maxBytes: config.maxBytes,
            timeoutMs: config.timeoutMs,
          })
        }
      } catch (e: unknown) {
        if (e instanceof Error) {
          if (e.message.includes('INVALID_IMAGE_SIZE') || e.message.includes('exceeds')) {
            throw new Error('INVALID_IMAGE_SIZE')
          }
          if (e.message.includes('UNSAFE_URL') || e.message.includes('Insecure protocol')) {
            throw new Error('UNSAFE_PROVIDER_URL')
          }
        }
        throw new Error('PROVIDER_DOWNLOAD_FAILED')
      }

      if (bounded.data.length === 0 || bounded.data.length > (config.maxBytes as number)) {
        throw new Error('INVALID_IMAGE_SIZE')
      }

      return {
        data: bounded.data,
        mimeType: bounded.mimeType,
        width: bounded.width || 0,
        height: bounded.height || 0,
      }
    }),
  )

  return limitGeneratedImages(generatedImages, input.count)
}
