import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectInputImage, validateInputImages } from '../../../../packages/providers/src/core/image-input'
import { NormalizedProviderError } from '../../../../packages/providers/src/index'
import { resolveMediaPlugin } from '../plugins/availability'
import { classifySubmitError, isSynchronousPlugin, validateStoredInputImage } from './index'

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

  // More than MAX_INPUT_IMAGES (32 absolute ceiling)
  assert.throws(
    () =>
      validateInputImages(Array.from({ length: 33 }, () => ({ data: png1 }))),
    /INVALID_INPUT_IMAGE/,
  )
  // Resolved runtime limits are enforced, including lowered values.
  assert.throws(() => validateInputImages([{ data: png1 }, { data: png1 }], { maxInputs: 1 }), /INVALID_INPUT_IMAGE/)
  assert.equal(validateInputImages([{ data: png1 }, { data: png1 }], { maxInputs: 32 }).length, 2)
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
  assert.throws(
    () => validateStoredInputImage(data, {
      mimeType: 'image/png',
      sizeBytes: data.length,
      checksum,
    }, { maxImageBytes: data.length - 1 }),
    /INVALID_INPUT_IMAGE_SIZE/,
  )
})

test('isSynchronousPlugin distinguishes image-style and video-style plugins', () => {
  assert.equal(isSynchronousPlugin({}), true)
  assert.equal(isSynchronousPlugin({ poll: undefined }), true)
  assert.equal(isSynchronousPlugin({ poll: async () => ({ status: 'waiting' as const }) }), false)
})

test('classifySubmitError keeps the diagnostic an uploaded bundle carries', () => {
  const diagnostic = { status: 429, endpoint: '/v1/images/generations', detail: 'rate limited' }
  // A bundle cannot import NormalizedProviderError, so it signals with a plain Error.
  const temporary = classifySubmitError(Object.assign(new Error('PROVIDER_TEMPORARY_ERROR'), { diagnostic }), 'uploaded')
  assert.equal(temporary.code, 'PROVIDER_TEMPORARY_ERROR')
  assert.equal(temporary.retryable, true)
  assert.deepEqual(temporary.diagnostic, diagnostic)

  const rejected = classifySubmitError(Object.assign(new Error('PROVIDER_REJECTED'), { diagnostic }), 'uploaded')
  assert.equal(rejected.retryable, false, 'a rejection must never map to a retry')
  assert.deepEqual(rejected.diagnostic, diagnostic)

  const unnamed = classifySubmitError(Object.assign(new Error('boom'), { diagnostic }), 'uploaded')
  assert.equal(unnamed.code, 'GENERATION_FAILED')
  assert.deepEqual(unnamed.diagnostic, diagnostic)

  assert.equal(Array.isArray(classifySubmitError(Object.assign(new Error('PROVIDER_BUSY'), { diagnostic: [1, 2] }), 'uploaded').diagnostic), false)
  assert.deepEqual(classifySubmitError(new Error('PROVIDER_BUSY'), 'uploaded'), { code: 'PROVIDER_BUSY', retryable: true, diagnostic: null })
  assert.deepEqual(classifySubmitError(new Error('boom'), 'uploaded'), { code: 'GENERATION_FAILED', retryable: false, diagnostic: null })
  assert.deepEqual(classifySubmitError('PROVIDER_TIMEOUT', 'uploaded'), { code: 'GENERATION_FAILED', retryable: false, diagnostic: null })

  // The typed branches keep their own (narrower) retryable sets.
  const normalized = classifySubmitError(NormalizedProviderError.create('p', '1.0.0', 'OUTPUT_READ_FAILED', 'read failed'), 'p')
  assert.equal(normalized.code, 'OUTPUT_READ_FAILED')
  assert.equal(normalized.retryable, true)
  const notConfigured = classifySubmitError(NormalizedProviderError.create('p', '1.0.0', 'PROVIDER_NOT_CONFIGURED', 'disabled'), 'p')
  assert.equal(notConfigured.retryable, false)
  const providerDownload = classifySubmitError(NormalizedProviderError.create('p', '1.0.0', 'UNKNOWN_ERROR', 'flaked'), 'p')
  assert.equal(providerDownload.retryable, false, 'the NormalizedProviderError branch keeps its own narrow retryable set')

  // The availability gate throws this same error for a disabled plugin, so a disabled
  // install is a terminal PROVIDER_NOT_CONFIGURED here rather than a retry loop.
  let gated: unknown
  try {
    resolveMediaPlugin('jobs-test-unseen-plugin', '1.0.0')
    throw new Error('expected the gate to throw')
  } catch (error) {
    gated = error
  }
  assert.deepEqual(classifySubmitError(gated, 'jobs-test-unseen-plugin'), {
    code: 'PROVIDER_NOT_CONFIGURED',
    retryable: false,
    diagnostic: { ...normalizeDiagnostic(gated) },
  })
})

function normalizeDiagnostic(error: unknown): Record<string, unknown> {
  return (error as NormalizedProviderError).diagnostic as Record<string, unknown>
}
