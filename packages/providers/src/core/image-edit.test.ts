import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  clampEditSelection,
  MAX_MASK_BYTES,
  MASK_EDIT_ALPHA,
  MASK_KEEP_ALPHA,
  MIN_EDIT_SELECTION_PX,
} from '@musecanvas/contracts'
import {
  createEditMask,
  normalizeAlphaMask,
  pickClosestAllowedSize,
  NormalizedProviderError,
} from './index'

/** GPT-image's real allowed output sizes, straight from the plugin's rules. */
const GPT_IMAGE_SIZES = ['1024x1024', '1280x720', '720x1280', '1536x1024', '1024x1536']

/** Decode a PNG back to raw RGBA plus the geometry sharp actually read. */
async function decodeRgba(png: Buffer): Promise<{ width: number; height: number; channels: number; data: Buffer }> {
  const rendered = await sharp(png, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true })
  return {
    width: rendered.info.width,
    height: rendered.info.height,
    channels: rendered.info.channels,
    data: rendered.data,
  }
}

function alphaAt(pixels: { width: number; channels: number; data: Buffer }, x: number, y: number): number {
  return pixels.data[y * pixels.width * pixels.channels + x * pixels.channels + (pixels.channels - 1)]
}

function rgbAt(pixels: { width: number; channels: number; data: Buffer }, x: number, y: number): number[] {
  const offset = y * pixels.width * pixels.channels + x * pixels.channels
  return [pixels.data[offset], pixels.data[offset + 1], pixels.data[offset + 2]]
}

test('createEditMask: exact dimensions, opaque white outside the selection, transparent inside', async () => {
  const imageWidth = 40
  const imageHeight = 24
  const selection = { x: 8, y: 6, width: 12, height: 9 }
  const mask = await createEditMask({ imageWidth, imageHeight, selection })

  const meta = await sharp(mask).metadata()
  assert.equal(meta.format, 'png')
  assert.equal(meta.width, imageWidth)
  assert.equal(meta.height, imageHeight)
  assert.equal(meta.hasAlpha, true)
  assert.ok(mask.length <= MAX_MASK_BYTES)

  const pixels = await decodeRgba(mask)
  assert.equal(pixels.channels, 4, 'the mask must keep its alpha band through the encoder')

  // Inside the rectangle, including all four corners of it.
  for (const [x, y] of [[8, 6], [19, 14], [13, 10], [8, 14], [19, 6]] as const) {
    assert.equal(alphaAt(pixels, x, y), MASK_EDIT_ALPHA, `(${x},${y}) sits in the selection`)
  }
  // One pixel outside each edge — the off-by-one is the whole bug class here.
  for (const [x, y] of [[7, 6], [20, 6], [8, 5], [19, 15], [0, 0], [39, 23]] as const) {
    assert.equal(alphaAt(pixels, x, y), MASK_KEEP_ALPHA, `(${x},${y}) sits outside the selection`)
  }
  // The preserved area is white, so a viewer compositing the mask sees no tint.
  assert.deepEqual(rgbAt(pixels, 0, 0), [255, 255, 255])
  assert.deepEqual(rgbAt(pixels, 39, 23), [255, 255, 255])
  assert.deepEqual(rgbAt(pixels, 13, 10), [255, 255, 255])
})

test('createEditMask: a selection reaching the image edge stays inside the image', async () => {
  const clamped = clampEditSelection({ x: 30, y: 14, width: 100, height: 100 }, 40, 24)
  assert.deepEqual(clamped, { x: 30, y: 14, width: 10, height: 10 })
  const pixels = await decodeRgba(await createEditMask({ imageWidth: 40, imageHeight: 24, selection: clamped! }))
  assert.equal(pixels.width, 40)
  assert.equal(pixels.height, 24)
  assert.equal(alphaAt(pixels, 39, 23), MASK_EDIT_ALPHA)
  assert.equal(alphaAt(pixels, 30, 14), MASK_EDIT_ALPHA)
  assert.equal(alphaAt(pixels, 29, 14), MASK_KEEP_ALPHA)
  assert.equal(alphaAt(pixels, 30, 13), MASK_KEEP_ALPHA)
})

test('createEditMask: a whole-image selection is one big edit hole', async () => {
  const pixels = await decodeRgba(
    await createEditMask({ imageWidth: 20, imageHeight: 12, selection: { x: 0, y: 0, width: 20, height: 12 } }),
  )
  assert.equal(alphaAt(pixels, 0, 0), MASK_EDIT_ALPHA)
  assert.equal(alphaAt(pixels, 19, 11), MASK_EDIT_ALPHA)
})

test('createEditMask: a reversed drag rasterises the same pixels as the forward one', async () => {
  const forward = await createEditMask({
    imageWidth: 40,
    imageHeight: 24,
    selection: { x: 8, y: 6, width: 12, height: 9 },
  })
  const reversed = await createEditMask({
    imageWidth: 40,
    imageHeight: 24,
    // Dragged right-to-left / bottom-to-top: negative extents, same rectangle.
    selection: { x: 20, y: 15, width: -12, height: -9 },
  })
  assert.equal(reversed.equals(forward), true)
})

test('createEditMask: rejects sub-minimum, out-of-bounds and non-finite selections', async () => {
  const image = { imageWidth: 40, imageHeight: 24 }
  const cases = [
    { x: 4, y: 4, width: MIN_EDIT_SELECTION_PX - 1, height: 20 },
    { x: 4, y: 4, width: 20, height: MIN_EDIT_SELECTION_PX - 1 },
    { x: 100, y: 4, width: 20, height: 20 }, // entirely past the right edge
    { x: -50, y: -50, width: 20, height: 20 }, // entirely above/left of the image
    { x: 4, y: 4, width: 0, height: 12 },
    { x: Number.NaN, y: 4, width: 12, height: 12 },
    { x: 4, y: 4, width: Number.POSITIVE_INFINITY, height: 12 },
  ]
  for (const selection of cases) {
    await assert.rejects(
      () => createEditMask({ ...image, selection }),
      /EDIT_SELECTION_REJECTED/,
      `expected a rejection for ${JSON.stringify(selection)}`,
    )
  }
})

test('createEditMask: rejects unusable image dimensions instead of allocating on a guess', async () => {
  const selection = { x: 0, y: 0, width: 12, height: 12 }
  for (const [imageWidth, imageHeight] of [[0, 24], [40, 0], [40.5, 24], [Number.NaN, 24], [-40, 24]] as const) {
    await assert.rejects(
      () => createEditMask({ imageWidth, imageHeight, selection }),
      /MASK_TARGET_DIMENSIONS_INVALID/,
      `expected a rejection for ${imageWidth}x${imageHeight}`,
    )
  }
  await assert.rejects(
    () => createEditMask({ imageWidth: 6001, imageHeight: 6001, selection }),
    /MASK_TARGET_DIMENSIONS_EXCEEDED/,
  )
})

test('normalizeAlphaMask: accepts an alpha PNG at the right size, rejects everything opaque', async () => {
  const mask = await createEditMask({
    imageWidth: 40,
    imageHeight: 24,
    selection: { x: 10, y: 10, width: 12, height: 10 },
  })
  const normalized = await normalizeAlphaMask(mask, 40, 24)
  const meta = await sharp(normalized).metadata()
  assert.equal(meta.format, 'png')
  assert.equal(meta.width, 40)
  assert.equal(meta.height, 24)
  assert.equal(meta.hasAlpha, true)

  const opaquePng = await sharp({
    create: { width: 40, height: 24, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer()
  await assert.rejects(() => normalizeAlphaMask(opaquePng, 40, 24), /MASK_ALPHA_MISSING/)

  const jpeg = await sharp({
    create: { width: 40, height: 24, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).jpeg().toBuffer()
  await assert.rejects(() => normalizeAlphaMask(jpeg, 40, 24), /MASK_FORMAT_INVALID/)

  await assert.rejects(() => normalizeAlphaMask(Buffer.from('not an image'), 40, 24), /MASK_DECODE_FAILED/)
  await assert.rejects(() => normalizeAlphaMask(Buffer.alloc(0), 40, 24), /MASK_BYTES_INVALID/)
  await assert.rejects(
    () => normalizeAlphaMask(Buffer.alloc(MAX_MASK_BYTES + 1, 0x20), 40, 24),
    /MASK_BYTE_LIMIT_EXCEEDED/,
  )
  await assert.rejects(() => normalizeAlphaMask(mask, 40, 0), /MASK_TARGET_DIMENSIONS_INVALID/)
})

test('normalizeAlphaMask: resizes a mismatched mask to the image exactly, keeping 4 channels', async () => {
  const small = await createEditMask({
    imageWidth: 20,
    imageHeight: 12,
    selection: { x: 0, y: 0, width: 10, height: 10 },
  })
  const scaled = await normalizeAlphaMask(small, 40, 24)
  const meta = await sharp(scaled).metadata()
  assert.equal(meta.width, 40)
  assert.equal(meta.height, 24)
  assert.equal(meta.hasAlpha, true)

  const pixels = await decodeRgba(scaled)
  assert.equal(pixels.channels, 4, 'resizing must not drop the alpha band')
  assert.equal(pixels.data.length, 40 * 24 * 4)
  // Nearest keeps the mask binary: every pixel is either edit or preserve, never a
  // semi-transparent fringe the vendor has no defined behaviour for.
  const alphas = new Set<number>()
  for (let i = 3; i < pixels.data.length; i += 4) alphas.add(pixels.data[i])
  assert.deepEqual([...alphas].sort((a, b) => a - b), [MASK_EDIT_ALPHA, MASK_KEEP_ALPHA])
})

test('pickClosestAllowedSize: matches the source aspect ratio in log space', () => {
  // 3:2 -> the 3:2 option, not the square one.
  assert.equal(pickClosestAllowedSize(GPT_IMAGE_SIZES, 1500, 1000), '1536x1024')
  // 9:16 -> the portrait option.
  assert.equal(pickClosestAllowedSize(GPT_IMAGE_SIZES, 1080, 1920), '720x1280')
  // Exact 1:1.
  assert.equal(pickClosestAllowedSize(GPT_IMAGE_SIZES, 1024, 1024), '1024x1024')
  // 4:5 sits nearer the 2:3 portrait frame than the square one
  // (|log 0.8 - log (2/3)| = 0.182 < |log 0.8 - log 1| = 0.223).
  assert.equal(pickClosestAllowedSize(GPT_IMAGE_SIZES, 800, 1000), '1024x1536')
})

test('pickClosestAllowedSize: log space, not linear space, and ties go to more pixels', () => {
  // A square source sits 0.5 away from 1:2 and 0.5 away from 3:2 *linearly*, which
  // is a dead tie broken by the larger frame; in log space 3:2 is clearly nearer.
  assert.equal(pickClosestAllowedSize(['2000x1000', '1536x1024'], 1024, 1024), '1536x1024')
  // A genuine tie (both 1:1, distance exactly 0) resolves to the bigger frame in
  // either input order, so it is not merely 'first wins'.
  assert.equal(pickClosestAllowedSize(['512x512', '1024x1024'], 900, 900), '1024x1024')
  assert.equal(pickClosestAllowedSize(['1024x1024', '512x512'], 900, 900), '1024x1024')
})

test('pickClosestAllowedSize: empty, garbage and unreadable input yield undefined', () => {
  assert.equal(pickClosestAllowedSize([], 1024, 1024), undefined)
  assert.equal(pickClosestAllowedSize(['bogus', '1024', 'x', '0x0', '1024x0'], 1024, 1024), undefined)
  assert.equal(pickClosestAllowedSize(['1024x1024'], 0, 1024), undefined)
  assert.equal(pickClosestAllowedSize(['1024x1024'], Number.NaN, 1024), undefined)
  // One bad entry must not sink the list, and the winner comes back verbatim so it
  // always passes the plugin's own `sizes.includes(request.size)` whitelist.
  assert.equal(pickClosestAllowedSize(['bogus', '1024x1536', '1024'], 500, 900), '1024x1536')
})

test('createEditMask failures are plain UPPERCASE-code errors, not provider diagnostics', async () => {
  // These run in the worker/API before a plugin is even chosen, so they must not
  // pretend to be one; the message style matches the rest of this package.
  await assert.rejects(
    () => createEditMask({ imageWidth: 40, imageHeight: 24, selection: { x: 0, y: 0, width: 2, height: 2 } }),
    (err: unknown) => {
      assert.equal(err instanceof Error, true)
      assert.equal(err instanceof NormalizedProviderError, false)
      assert.match((err as Error).message, /^EDIT_SELECTION_REJECTED/)
      return true
    },
  )
})
