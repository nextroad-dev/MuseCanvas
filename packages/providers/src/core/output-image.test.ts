import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  inspectDecodedImageOutput,
  MAX_DECODED_IMAGE_ASPECT_RATIO,
  MAX_DECODED_IMAGE_DIMENSION,
  MAX_DECODED_IMAGE_PIXELS,
  NormalizedProviderError,
} from './index'

async function realPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } },
  }).png().toBuffer()
}

async function realJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  }).jpeg().toBuffer()
}

function pngHeaderOnly(width: number, height: number, totalLength = 33): Buffer {
  const buf = Buffer.alloc(totalLength)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'latin1')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf[24] = 8
  buf[25] = 6
  return buf
}

async function rejectsOutput(
  data: Buffer,
  mimeType: string,
  detailMatch?: RegExp,
): Promise<void> {
  await assert.rejects(() => inspectDecodedImageOutput(data, mimeType), (err: unknown) => {
    assert.ok(err instanceof NormalizedProviderError)
    assert.equal(err.diagnostic.code, 'OUTPUT_READ_FAILED')
    if (detailMatch) assert.match(err.diagnostic.detail, detailMatch)
    return true
  })
}

test('decodes valid PNG and JPEG with detected dimensions', async () => {
  assert.equal(MAX_DECODED_IMAGE_DIMENSION, 8000)
  assert.equal(MAX_DECODED_IMAGE_PIXELS, 25_000_000)
  assert.equal(MAX_DECODED_IMAGE_ASPECT_RATIO, 16)

  const png = await realPng(64, 48)
  assert.deepEqual(await inspectDecodedImageOutput(png, 'image/png'), {
    width: 64,
    height: 48,
    mimeType: 'image/png',
  })

  const jpeg = await realJpeg(32, 32)
  assert.deepEqual(await inspectDecodedImageOutput(jpeg, 'image/jpeg'), {
    width: 32,
    height: 32,
    mimeType: 'image/jpeg',
  })
})

test('rejects header-only 24-byte fake PNG', async () => {
  const fake = pngHeaderOnly(100, 100, 24)
  assert.equal(fake.length, 24)
  await rejectsOutput(fake, 'image/png', /truncated/)
})

test('rejects truncated JPEG scan data', async () => {
  const full = await realJpeg(64, 64)
  const truncated = full.subarray(0, Math.floor(full.length * 0.6))
  assert.ok(!truncated.subarray(-2).equals(Buffer.from([0xff, 0xd9])))
  await rejectsOutput(Buffer.from(truncated), 'image/jpeg', /truncated/)
})

test('rejects oversized dimensions and pixel-count bombs before decode', async () => {
  await rejectsOutput(pngHeaderOnly(20000, 100), 'image/png', /bounds/)
  await rejectsOutput(pngHeaderOnly(9000, 9000), 'image/png', /bounds|pixel count/)
  await rejectsOutput(pngHeaderOnly(8000, 100), 'image/png', /aspect ratio/)
})

test('rejects MIME mismatches and non-images', async () => {
  const jpeg = await realJpeg(32, 32)
  await rejectsOutput(jpeg, 'image/png', /MIME mismatch/)
  const png = await realPng(32, 32)
  await rejectsOutput(png, 'image/jpeg', /MIME mismatch/)
  await rejectsOutput(Buffer.from('not an image at all'), 'image/png', /not a PNG\/JPEG/)
  await rejectsOutput(Buffer.alloc(0), 'image/png', /empty/)
  await rejectsOutput(png, 'text/plain', /Only PNG\/JPEG/)
})
