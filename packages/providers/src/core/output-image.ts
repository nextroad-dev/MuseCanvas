import { NormalizedProviderError } from './errors'
import { inspectImageBytes } from './image-input'
import type * as SharpModule from 'sharp'

/**
 * Decoder-backed bounds for persisted image outputs. Sized to admit real
 * provider outputs (up to ~6240px / ~16.6MP way-two sizes) while rejecting
 * decompression bombs well before allocation.
 */
export const MAX_DECODED_IMAGE_DIMENSION = 8000
export const MAX_DECODED_IMAGE_PIXELS = 25_000_000
export const MAX_DECODED_IMAGE_ASPECT_RATIO = 16

export type DecodedImageInfo = {
  width: number
  height: number
  mimeType: 'image/png' | 'image/jpeg'
}

// Fixed 12-byte IEND trailer every valid PNG ends with (length 0 + 'IEND' + CRC of 'IEND').
const PNG_IEND_TAIL = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]

function hasCompleteTrailer(data: Buffer, mimeType: 'image/png' | 'image/jpeg'): boolean {
  if (mimeType === 'image/png') {
    if (data.length < 12) return false
    const tailStart = data.length - 12
    for (let index = 0; index < PNG_IEND_TAIL.length; index++) {
      if (data[tailStart + index] !== PNG_IEND_TAIL[index]) return false
    }
    return true
  }
  if (data.length < 2) return false
  return data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9
}

export type InspectDecodedImageOptions = {
  pluginId?: string
  version?: string
}

/**
 * Fully validates rendered output bytes before persistence: structural
 * header parse, exact declared-MIME equality, header bounds (bomb guard),
 * container-trailer completeness, decoder metadata cross-check, and a forced
 * full pixel decode (no pixel buffer returned). Rejects truncated, polyglot,
 * animated/multi-page, and non-decodable bytes via OUTPUT_READ_FAILED.
 */
export async function inspectDecodedImageOutput(
  data: Buffer,
  declaredMimeType: string,
  options: InspectDecodedImageOptions = {},
): Promise<DecodedImageInfo> {
  const pluginId = options.pluginId ?? 'core'
  const version = options.version ?? '1.0.0'
  const fail = (detail: string): NormalizedProviderError =>
    NormalizedProviderError.create(pluginId, version, 'OUTPUT_READ_FAILED', detail)

  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw fail('Output image data is empty')
  }
  if (declaredMimeType !== 'image/png' && declaredMimeType !== 'image/jpeg') {
    throw fail(`Only PNG/JPEG outputs can be opened, got mimeType '${declaredMimeType}'`)
  }

  let header: { width: number; height: number; mimeType: 'image/png' | 'image/jpeg' }
  try {
    header = inspectImageBytes(data)
  } catch {
    throw fail('Output is not a PNG/JPEG image')
  }
  if (header.mimeType !== declaredMimeType) {
    throw fail(`Output MIME mismatch: declared '${declaredMimeType}' but detected '${header.mimeType}'`)
  }

  if (
    !Number.isSafeInteger(header.width) ||
    !Number.isSafeInteger(header.height) ||
    header.width < 1 ||
    header.height < 1 ||
    header.width > MAX_DECODED_IMAGE_DIMENSION ||
    header.height > MAX_DECODED_IMAGE_DIMENSION
  ) {
    throw fail(`Output image dimensions ${header.width}x${header.height} exceed bounds`)
  }
  const pixels = header.width * header.height
  if (pixels > MAX_DECODED_IMAGE_PIXELS) {
    throw fail(`Output image pixel count ${pixels} exceeds maximum of ${MAX_DECODED_IMAGE_PIXELS}`)
  }
  if (Math.max(header.width / header.height, header.height / header.width) > MAX_DECODED_IMAGE_ASPECT_RATIO) {
    throw fail('Output image aspect ratio exceeds maximum')
  }

  if (!hasCompleteTrailer(data, header.mimeType)) {
    throw fail('Output image is truncated')
  }

  const sharpOptions = { failOn: 'error' as const, limitInputPixels: MAX_DECODED_IMAGE_PIXELS }
  // Dynamic import with webpackIgnore (never a static import): API processes
  // import the provider registry but never decode outputs, and bundlers must
  // neither traverse the native binding nor warn. Node resolves and caches it
  // at runtime on output ingestion only.
  const sharpPackage = ['sh', 'arp'].join('')
  const sharpModule: typeof SharpModule = await import(/* webpackIgnore: true */ sharpPackage)
  const sharp = sharpModule.default
  let meta: { format?: string; width?: number; height?: number; pages?: number }
  try {
    meta = await sharp(data, sharpOptions).metadata()
  } catch {
    throw fail('Output image failed to decode')
  }
  const decodedMime = meta.format === 'png' ? 'image/png' : meta.format === 'jpeg' ? 'image/jpeg' : null
  if (decodedMime === null || decodedMime !== declaredMimeType) {
    throw fail(`Output decoder format mismatch: declared '${declaredMimeType}'`)
  }
  if ((meta.pages ?? 1) > 1) {
    throw fail('Animated/multi-page outputs are not supported')
  }
  if (meta.width !== header.width || meta.height !== header.height) {
    throw fail('Output image dimensions mismatch')
  }

  try {
    await sharp(data, sharpOptions).stats()
  } catch {
    throw fail('Output image pixel data failed to decode')
  }

  return { width: meta.width as number, height: meta.height as number, mimeType: decodedMime }
}
