/**
 * Shared input-image byte validation for image providers.
 *
 * Byte-level PNG/JPEG inspection and upload bounds shared by the hardened
 * image plugins and their Worker/API callers. Throws plain errors with
 * `INVALID_INPUT_IMAGE` / `INVALID_INPUT_IMAGE_SIZE` messages; plugin
 * `validateRequest` maps these to `INVALID_REQUEST` diagnostics.
 */

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

export const MAX_UPLOAD_IMAGE_BYTES = 100_000_000
export const MAX_UPLOAD_TOTAL_BYTES = 200_000_000
export const MAX_INPUT_IMAGES = 32
export const MIN_INPUT_IMAGE_DIMENSION = 32
export const MAX_INPUT_IMAGE_DIMENSION = 6000
export const MAX_INPUT_IMAGE_ASPECT_RATIO = 16

/**
 * Canonical runtime input limits `{maxImageBytes,maxTotalBytes,maxInputs}`.
 * API/worker pass resolved DB values; provider/plugin fallback uses the
 * absolute configured ceilings above so a valid runtime setting is never
 * contradicted. All fields optional for backward-compatible callsites.
 */
export interface InputLimits {
  maxImageBytes?: number
  maxTotalBytes?: number
  maxInputs?: number
}

export type InspectedImageBytes = {
  width: number
  height: number
  mimeType: 'image/png' | 'image/jpeg'
}

/**
 * No-allocation structural PNG/JPEG inspector: validates magic bytes and
 * decodes container dimensions straight from the input buffer without
 * copying image bytes and without applying any dimension/total-size policy.
 * Throws plain `INVALID_INPUT_IMAGE` on non-image or truncated input.
 */
export function inspectImageBytes(data: Buffer): InspectedImageBytes {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new Error('INVALID_INPUT_IMAGE')
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
    if (data[12] !== 0x49 || data[13] !== 0x48 || data[14] !== 0x44 || data[15] !== 0x52) {
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

  if (mimeType === null || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new Error('INVALID_INPUT_IMAGE')
  }

  return {
    width,
    height,
    mimeType,
  }
}

export function inspectInputImage(data: Buffer, limits?: InputLimits): InspectedInputImage {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new Error('INVALID_INPUT_IMAGE')
  }
  const maxSingle = limits?.maxImageBytes ?? MAX_UPLOAD_IMAGE_BYTES
  if (data.length > maxSingle) {
    throw new Error('INVALID_INPUT_IMAGE_SIZE')
  }

  const inspected = inspectImageBytes(data)
  const { width, height, mimeType } = inspected

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
  limits?: InputLimits,
): InspectedInputImage[] {
  if (!inputImages || inputImages.length === 0) return []
  const maxCount = limits?.maxInputs ?? MAX_INPUT_IMAGES
  if (inputImages.length > maxCount) {
    throw new Error('INVALID_INPUT_IMAGE')
  }
  const maxTotal = limits?.maxTotalBytes ?? MAX_UPLOAD_TOTAL_BYTES
  let totalBytes = 0
  const inspectedList: InspectedInputImage[] = []
  for (const img of inputImages) {
    if (!img || !img.data || !Buffer.isBuffer(img.data)) {
      throw new Error('INVALID_INPUT_IMAGE')
    }
    totalBytes += img.data.length
    if (totalBytes > maxTotal) {
      throw new Error('INVALID_INPUT_IMAGE_SIZE')
    }
    const inspected = inspectInputImage(img.data, limits)
    inspectedList.push(inspected)
  }
  return inspectedList
}
