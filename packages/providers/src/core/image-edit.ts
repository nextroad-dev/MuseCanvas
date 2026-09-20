import {
  clampEditSelection,
  MAX_MASK_BYTES,
  MASK_EDIT_ALPHA,
  MASK_KEEP_ALPHA,
  type EditSelection,
} from '@musecanvas/contracts'
import { MAX_INPUT_IMAGE_DIMENSION } from './image-input'
import type * as SharpModule from 'sharp'

/**
 * Alpha-mask rasterisation for region-select image editing ("局部修改").
 *
 * The vendor contract this encodes (OpenAI `POST /v1/images/edits`, and the same
 * convention other image editors use): the mask is a **PNG with an alpha
 * channel**, it must be **exactly the input image's pixel dimensions**, it must
 * stay **under 4 MB**, a **fully transparent pixel (alpha 0) marks what the model
 * may regenerate** and a **fully opaque pixel marks what it must preserve**.
 * Those four rules are why each function below is shaped the way it is.
 *
 * Placement mirrors ./thumbnail.ts: sharp belongs to THIS package, so the worker
 * and the API get the rasteriser without a new dependency, and the polarity stays
 * next to the plugin that talks to the vendor — a different provider may want an
 * inverted mask or an RGB map, and that is a provider decision, not a route one.
 *
 * Every export is async because sharp is loaded lazily (see ./thumbnail.ts and
 * ./output-image.ts): `core/index.ts` is re-exported into API code paths that
 * must never traverse the native binding.
 */

async function loadSharp(): Promise<typeof SharpModule.default> {
  // Dynamic import with webpackIgnore (never a static import), mirroring
  // ./output-image.ts: bundlers must not traverse the native binding, and Node
  // resolves and caches it at runtime on mask creation only.
  const sharpPackage = ['sh', 'arp'].join('')
  const sharpModule = await import(/* webpackIgnore: true */ sharpPackage) as typeof SharpModule
  return sharpModule.default
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * A mask is only ever as large as the image it masks, and this package already
 * refuses input images beyond `MAX_INPUT_IMAGE_DIMENSION` per side (see
 * ./image-input.ts). Reusing that bound keeps the two ends consistent and stops a
 * caller with a bogus size from asking for an unbounded `Buffer.alloc`.
 */
function assertMaskTargetSize(imageWidth: number, imageHeight: number): void {
  const size = `${String(imageWidth)}x${String(imageHeight)}`
  if (!isPositiveSafeInteger(imageWidth) || !isPositiveSafeInteger(imageHeight)) {
    throw new Error(
      `MASK_TARGET_DIMENSIONS_INVALID: mask target must be positive integer pixels, got ${size}`,
    )
  }
  if (imageWidth > MAX_INPUT_IMAGE_DIMENSION || imageHeight > MAX_INPUT_IMAGE_DIMENSION) {
    throw new Error(
      `MASK_TARGET_DIMENSIONS_EXCEEDED: ${size} exceeds the ${MAX_INPUT_IMAGE_DIMENSION}px input-image bound`,
    )
  }
}

function assertWithinMaskByteLimit(bytes: Buffer, label: string): Buffer {
  if (bytes.length > MAX_MASK_BYTES) {
    throw new Error(
      `MASK_BYTE_LIMIT_EXCEEDED: ${label} mask is ${bytes.length} bytes, vendor maximum is ${MAX_MASK_BYTES} bytes`,
    )
  }
  return bytes
}

/**
 * Rasterise a source-pixel selection into the vendor's alpha mask.
 *
 * The selection is clamped here rather than trusted: `clampEditSelection` folds
 * reversed drags, clips to the image and fixes the far edge before deriving the
 * width, which is exactly what keeps `x + width` from ever exceeding the image
 * (the one bug that produces a mask bigger than its own image). Anything it
 * rejects — sub-`MIN_EDIT_SELECTION_PX`, fully out of bounds, non-finite — is a
 * region the caller must not send at all, so this throws instead of quietly
 * editing a smaller area than the user drew.
 *
 * Built from a raw RGBA buffer rather than `.composite()` because Porter-Duff
 * `over` can only add ink on top of an opaque base: it cannot punch the
 * transparency hole that *is* the edit area.
 */
export async function createEditMask(input: {
  imageWidth: number
  imageHeight: number
  selection: EditSelection
}): Promise<Buffer> {
  const { imageWidth, imageHeight, selection } = input
  assertMaskTargetSize(imageWidth, imageHeight)

  const region = clampEditSelection(selection, imageWidth, imageHeight)
  if (!region) {
    throw new Error(
      `EDIT_SELECTION_REJECTED: selection ${JSON.stringify(selection)} is not an editable region of a ${imageWidth}x${imageHeight} image`,
    )
  }

  // One opaque-white row, copied per scanline: the whole mask is white except
  // for the alpha of the selection.
  const rowBytes = imageWidth * 4
  const templateRow = Buffer.alloc(rowBytes)
  for (let x = 0; x < imageWidth; x++) {
    const offset = x * 4
    templateRow[offset] = 255
    templateRow[offset + 1] = 255
    templateRow[offset + 2] = 255
    templateRow[offset + 3] = MASK_KEEP_ALPHA
  }
  const raw = Buffer.alloc(rowBytes * imageHeight)
  for (let y = 0; y < imageHeight; y++) {
    templateRow.copy(raw, y * rowBytes)
  }
  for (let y = region.y; y < region.y + region.height; y++) {
    const rowStart = y * rowBytes
    for (let x = region.x; x < region.x + region.width; x++) {
      raw[rowStart + x * 4 + 3] = MASK_EDIT_ALPHA
    }
  }

  const sharp = await loadSharp()
  const png = await sharp(raw, {
    raw: { width: imageWidth, height: imageHeight, channels: 4 },
  })
    .png()
    .toBuffer()
  return assertWithinMaskByteLimit(png, 'generated')
}

/**
 * Normalise a caller-supplied mask (the `{ type: 'mask' }` region kind: brush,
 * lasso, polygon, auto-segmentation) into bytes this vendor can accept.
 *
 * A mask without an alpha channel carries no information at all — opaque-only
 * would mean "edit nothing", which is never what the caller meant — so anything
 * that is not a PNG with alpha is rejected loudly rather than resized into a
 * guess. Dimension drift is corrected, because the vendor requires the mask to be
 * the *same* size as the image; `fit: 'fill'` with the `nearest` kernel is on
 * purpose: a smoothing kernel would invent semi-transparent fringe pixels whose
 * meaning ("partially edit this?") is undefined to the vendor.
 */
export async function normalizeAlphaMask(
  mask: Buffer,
  imageWidth: number,
  imageHeight: number,
): Promise<Buffer> {
  assertMaskTargetSize(imageWidth, imageHeight)
  if (!Buffer.isBuffer(mask) || mask.length === 0) {
    throw new Error('MASK_BYTES_INVALID: mask bytes are empty')
  }
  if (mask.length > MAX_MASK_BYTES) {
    throw new Error(
      `MASK_BYTE_LIMIT_EXCEEDED: incoming mask is ${mask.length} bytes, vendor maximum is ${MAX_MASK_BYTES} bytes`,
    )
  }

  const sharp = await loadSharp()
  const sharpOptions = { failOn: 'error' as const, animated: false }
  let meta: {
    format?: string
    width?: number
    height?: number
    channels?: number
    hasAlpha?: boolean
  }
  try {
    meta = await sharp(mask, sharpOptions).metadata()
  } catch {
    throw new Error('MASK_DECODE_FAILED: mask bytes are not a decodable image')
  }
  if (meta.format !== 'png') {
    throw new Error(
      `MASK_FORMAT_INVALID: the edit mask must be a PNG, decoder reported '${String(meta.format)}'`,
    )
  }
  if (meta.hasAlpha !== true || (meta.channels ?? 0) < 4) {
    throw new Error(
      `MASK_ALPHA_MISSING: the edit mask needs an alpha channel (alpha ${MASK_EDIT_ALPHA} edits, alpha ${MASK_KEEP_ALPHA} preserves), decoded ${String(meta.channels)} channel(s)`,
    )
  }
  if (!isPositiveSafeInteger(meta.width ?? NaN) || !isPositiveSafeInteger(meta.height ?? NaN)) {
    throw new Error('MASK_DECODE_FAILED: mask dimensions are unreadable')
  }

  const resized = meta.width !== imageWidth || meta.height !== imageHeight
  let pipeline = sharp(mask, sharpOptions)
  if (resized) {
    pipeline = pipeline.resize(imageWidth, imageHeight, { fit: 'fill', kernel: 'nearest' })
  }
  const png = await pipeline.png().toBuffer()
  return assertWithinMaskByteLimit(png, resized ? 'resized' : 'normalised')
}

/** A vendor size literal: `WIDTHxHEIGHT`, the separator being the vendor's own `x`. */
const ALLOWED_SIZE_PATTERN = /^(\d+)x(\d+)$/i

/**
 * The model's allowed output size nearest the source image's aspect ratio.
 *
 * An edit of a full-size photo rarely lands on one of the model's fixed sizes,
 * so the caller needs the closest legal option. Distance is compared in **log
 * space**, so 2:3 and 3:2 are exactly as far from 1:1 — a linear comparison would
 * treat the landscape twin as further away and skew every square source toward
 * portrait output. Ties go to the larger frame: more pixels downsample better
 * than fewer upscaled ones.
 *
 * The winner is returned unchanged, so it always satisfies the caller's own
 * `sizes.includes(result)` whitelist check. `undefined` for an empty or garbage
 * list (or unusable source dimensions) leaves the caller's default — usually the
 * model's own default size — in place.
 */
export function pickClosestAllowedSize(
  sizes: string[],
  imageWidth: number,
  imageHeight: number,
): string | undefined {
  if (!Array.isArray(sizes) || sizes.length === 0) return undefined
  if (!isPositiveSafeInteger(imageWidth) || !isPositiveSafeInteger(imageHeight)) return undefined

  const targetRatio = Math.log(imageWidth / imageHeight)
  let best: { value: string; distance: number; pixels: number } | undefined

  for (const entry of sizes) {
    if (typeof entry !== 'string') continue
    const match = ALLOWED_SIZE_PATTERN.exec(entry.trim())
    if (!match) continue
    const width = Number(match[1])
    const height = Number(match[2])
    if (!isPositiveSafeInteger(width) || !isPositiveSafeInteger(height)) continue

    const distance = Math.abs(Math.log(width / height) - targetRatio)
    const pixels = width * height
    if (!best || distance < best.distance || (distance === best.distance && pixels > best.pixels)) {
      best = { value: entry, distance, pixels }
    }
  }

  return best?.value
}
