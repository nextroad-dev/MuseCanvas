import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectInputImage, validateInputImages } from '../../../../packages/providers/src/core/image-input'
import { isSynchronousPlugin, validateStoredInputImage } from './index'

// Create helper PNG buffer with valid IHDR
function createValidPng(width = 100, height = 100): Buffer {
  const buf = Buffer.alloc(33)
  // PNG signature
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  // IHDR chunk length (13)
  buf.writeUInt32BE(13, 8)
  // IHDR type
  buf.write('IHDR', 12, 'latin1')
  // width and height
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  // bit depth, color type, compression, filter, interlace
  buf.set([8, 2, 0, 0, 0], 24)
  // CRC dummy
  buf.writeUInt32BE(0, 29)
  return buf
}

// Create helper JPEG buffer with SOF0
function createValidJpeg(width = 100, height = 100): Buffer {
  const buf = Buffer.alloc(23)
  // SOI
  buf.set([0xff, 0xd8], 0)
  // SOF0 marker
  buf.set([0xff, 0xc0], 2)
  // Length (8 + 3*channels = 11)
  buf.writeUInt16BE(11, 4)
  // Precision
  buf.writeUInt8(8, 6)
  // Height and width
  buf.writeUInt16BE(height, 7)
  buf.writeUInt16BE(width, 9)
  // Number of components
  buf.writeUInt8(3, 11)
  // Dummy component specs
  buf.set([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0], 12)
  // EOI
  buf.set([0xff, 0xd9], 21)
  return buf
}

test('inspectInputImage correctly inspects PNG and JPEG', () => {
  const png = createValidPng(200, 300)
  const inspectedPng = inspectInputImage(png)
  assert.equal(inspectedPng.mimeType, 'image/png')
  assert.equal(inspectedPng.width, 200)
  assert.equal(inspectedPng.height, 300)
  assert.equal(inspectedPng.sizeBytes, png.length)

  const jpeg = createValidJpeg(400, 500)
  const inspectedJpeg = inspectInputImage(jpeg)
  assert.equal(inspectedJpeg.mimeType, 'image/jpeg')
  assert.equal(inspectedJpeg.width, 400)
  assert.equal(inspectedJpeg.height, 500)
  assert.equal(inspectedJpeg.sizeBytes, jpeg.length)
})

test('inspectInputImage rejects invalid formats and sizes', () => {
  assert.throws(() => inspectInputImage(Buffer.from('not an image')), /INVALID_INPUT_IMAGE/)
  assert.throws(() => inspectInputImage(Buffer.alloc(0)), /INVALID_INPUT_IMAGE/)

  // Dimension too small
  const small = createValidPng(10, 10)
  assert.throws(() => inspectInputImage(small), /INVALID_INPUT_IMAGE_SIZE/)

  // Dimension too large
  const large = createValidPng(7000, 100)
  assert.throws(() => inspectInputImage(large), /INVALID_INPUT_IMAGE_SIZE/)

  // Aspect ratio > 16
  const wide = createValidPng(3200, 100) // 32:1 > 16
  assert.throws(() => inspectInputImage(wide), /INVALID_INPUT_IMAGE_SIZE/)
})

test('validateInputImages enforces caps and ordering', () => {
  const png1 = createValidPng(100, 100)
  const png2 = createValidPng(200, 200)
  const list = validateInputImages([{ data: png1 }, { data: png2 }])
  assert.equal(list.length, 2)
  assert.equal(list[0].width, 100)
  assert.equal(list[1].width, 200)

  // More than MAX_INPUT_IMAGES (4)
  assert.throws(
    () =>
      validateInputImages([
        { data: png1 },
        { data: png1 },
        { data: png1 },
        { data: png1 },
        { data: png1 },
      ]),
    /INVALID_INPUT_IMAGE/,
  )
})

test('validateStoredInputImage rejects post-completion object changes', () => {
  const data = createValidPng(256, 256)
  const checksum = createHash('sha256').update(data).digest('hex')
  const inspected = validateStoredInputImage(data, {
    mimeType: 'image/png',
    sizeBytes: data.length,
    checksum,
  })
  assert.equal(inspected.width, 256)

  assert.throws(
    () => validateStoredInputImage(data, {
      mimeType: 'image/png',
      sizeBytes: data.length + 1,
      checksum,
    }),
    /INVALID_INPUT_IMAGE_SIZE/,
  )
  assert.throws(
    () => validateStoredInputImage(data, {
      mimeType: 'image/jpeg',
      sizeBytes: data.length,
      checksum,
    }),
    /INVALID_INPUT_IMAGE/,
  )
  assert.throws(
    () => validateStoredInputImage(data, {
      mimeType: 'image/png',
      sizeBytes: data.length,
      checksum: '0'.repeat(64),
    }),
    /INVALID_INPUT_IMAGE/,
  )
})

test('isSynchronousPlugin distinguishes image-style and video-style plugins', () => {
  assert.equal(isSynchronousPlugin({}), true)
  assert.equal(isSynchronousPlugin({ poll: undefined }), true)
  assert.equal(isSynchronousPlugin({ poll: async () => ({ status: 'waiting' as const }) }), false)
})
