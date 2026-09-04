import type { BoundedOutput, OutputDescriptor, SafeHttpClient } from './types'
import { NormalizedProviderError } from './errors'

const DEFAULT_MAX_OUTPUT_BYTES = 25_000_000 // 25 MB
const DEFAULT_OUTPUT_TIMEOUT_MS = 60_000
export const MAX_OUTPUT_BYTES_HARD_CEILING = 100_000_000 // 100 MB hard ceiling

const CANONICAL_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

export function extractImageDimensions(data: Buffer): { width: number; height: number } {
  // PNG: signature 89 50 4E 47 0D 0A 1A 0A, IHDR starts at offset 12, width at 16, height at 20
  if (data.length > 24 && data.subarray(1, 4).toString('ascii') === 'PNG') {
    return {
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    }
  }

  // JPEG: starts with FF D8
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = data[offset + 1]
      const length = data.readUInt16BE(offset + 2)
      // SOF0 (0xC0) to SOF3 (0xC3) except SOF4
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: data.readUInt16BE(offset + 5),
          width: data.readUInt16BE(offset + 7),
        }
      }
      offset += 2 + length
    }
  }

  throw new Error('UNSUPPORTED_IMAGE_FORMAT')
}

export type ReadOutputOptions = {
  maxBytes?: number
  timeoutMs?: number
  allowedHosts?: string[]
}

/**
 * Reads and bounds an output descriptor (b64_json or remote url) into memory
 * without unnecessary copies on hot paths.
 */
export async function readBoundedOutput(
  descriptor: OutputDescriptor,
  http: SafeHttpClient,
  options: ReadOutputOptions = {},
  pluginId = 'core',
  version = '1.0.0',
): Promise<BoundedOutput> {
  const configuredMaxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (
    typeof configuredMaxBytes !== 'number' ||
    !Number.isSafeInteger(configuredMaxBytes) ||
    configuredMaxBytes <= 0 ||
    configuredMaxBytes > MAX_OUTPUT_BYTES_HARD_CEILING
  ) {
    throw NormalizedProviderError.create(
      pluginId,
      version,
      'OUTPUT_READ_FAILED',
      `Invalid maxBytes '${String(options.maxBytes)}': must be a positive safe integer up to ${MAX_OUTPUT_BYTES_HARD_CEILING} bytes`,
    )
  }
  const maxBytes = configuredMaxBytes
  const timeoutMs = options.timeoutMs ?? DEFAULT_OUTPUT_TIMEOUT_MS

  let data: Buffer
  let mimeType = descriptor.mimeType || 'image/png'

  if (descriptor.b64Json !== undefined) {
    const encoded = descriptor.b64Json
    if (encoded.length % 4 !== 0 || !CANONICAL_BASE64_RE.test(encoded)) {
      throw NormalizedProviderError.create(
        pluginId,
        version,
        'OUTPUT_READ_FAILED',
        'Output b64Json is not canonical base64',
      )
    }
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
    const decodedEstimate = (encoded.length / 4) * 3 - padding
    if (decodedEstimate > maxBytes) {
      throw NormalizedProviderError.create(
        pluginId,
        version,
        'OUTPUT_READ_FAILED',
        `Base64 output size ~${decodedEstimate} bytes exceeds maximum of ${maxBytes} bytes`,
      )
    }
    try {
      data = Buffer.from(encoded, 'base64')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid base64 payload'
      throw NormalizedProviderError.create(
        pluginId,
        version,
        'OUTPUT_READ_FAILED',
        `Failed to decode base64 output: ${message}`,
      )
    }

    if (data.length === 0 || data.length > maxBytes) {
      throw NormalizedProviderError.create(
        pluginId,
        version,
        'OUTPUT_READ_FAILED',
        `Base64 output size ${data.length} bytes is invalid or exceeds maximum of ${maxBytes} bytes`,
      )
    }
  } else if (descriptor.url !== undefined) {
    const res = await http.get(descriptor.url, {
      timeoutMs,
      maxBytes,
      allowedHosts: options.allowedHosts,
    })

    if (!res.ok) {
      throw NormalizedProviderError.create(
        pluginId,
        version,
        'OUTPUT_READ_FAILED',
        `Failed to download provider output from ${descriptor.url}: HTTP ${res.status} ${res.statusText}`,
      )
    }

    const declaredMime = res.headers.get('content-type')?.split(';')[0]?.trim()
    data = await res.buffer()

    if (data.length === 0 || data.length > maxBytes) {
      throw NormalizedProviderError.create(
        pluginId,
        version,
        'OUTPUT_READ_FAILED',
        `Output from ${descriptor.url} size ${data.length} bytes is invalid or exceeds maximum of ${maxBytes} bytes`,
      )
    }

    if (declaredMime) {
      mimeType = declaredMime
    }
  } else {
    throw NormalizedProviderError.create(
      pluginId,
      version,
      'OUTPUT_READ_FAILED',
      'Output descriptor contains neither url nor b64Json',
    )
  }

  let width = descriptor.width
  let height = descriptor.height

  if (mimeType.startsWith('image/')) {
    try {
      const dim = extractImageDimensions(data)
      width = width ?? dim.width
      height = height ?? dim.height
      if (mimeType === 'application/octet-stream' || !mimeType) {
        mimeType = data[0] === 0xff ? 'image/jpeg' : 'image/png'
      }
    } catch {
      // If dimension parsing fails, let width and height stay as descriptor or undefined
    }
  }

  return {
    data,
    mimeType,
    width,
    height,
    sizeBytes: data.length,
    metadata: descriptor.metadata,
  }
}
