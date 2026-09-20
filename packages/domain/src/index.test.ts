import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type ModelValidationConfig,
  normalizeGenerationRequest,
  prepareRequestDigestInput,
  serializeCanonicalGenerationRequest,
  serializeCanonicalJson,
  validateGenerationRequest,
} from './index'
import {
  type CreateGenerationRequest,
  type GenerationOutput,
  type ImageGenerationOutput,
  type ModelCapabilities,
  type VideoGenerationOutput,
} from '@musecanvas/contracts'

// `validateModelInput` and the Seedream pixel-band table it depended on were
// deleted: they had no production caller, and the same rules are now declared by
// the seedream-image plugin's own `image-size` descriptor and enforced through
// `validateGenerationRequest` (see `media-capabilities.test.ts`).

test('contracts generation outputs form a typed discriminated union', () => {
  const imageOutput: GenerationOutput = {
    mediaKind: 'image',
    assetId: 'asset-img-1',
    url: 'https://example.com/image.png',
    downloadUrl: 'https://example.com/image.png?dl=1',
    metadata: {
      width: 1024,
      height: 1024,
      format: 'png',
      aspectRatio: '1:1',
      sizeBytes: 102400,
      seed: 42,
    },
  }

  const videoOutput: GenerationOutput = {
    mediaKind: 'video',
    assetId: 'asset-vid-1',
    url: 'https://example.com/video.mp4',
    downloadUrl: null,
    metadata: {
      width: 1920,
      height: 1080,
      durationSeconds: 5,
      fps: 30,
      format: 'mp4',
      codec: 'h264',
      hasAudio: false,
      posterUrl: 'https://example.com/poster.jpg',
    },
  }

  function inspectOutput(output: GenerationOutput): string {
    if (output.mediaKind === 'image') {
      const img: ImageGenerationOutput = output
      return `image:${img.metadata.width}x${img.metadata.height}`
    }
    const vid: VideoGenerationOutput = output
    return `video:${vid.metadata.durationSeconds}s`
  }

  assert.equal(inspectOutput(imageOutput), 'image:1024x1024')
  assert.equal(inspectOutput(videoOutput), 'video:5s')
})

test('descriptor-driven validation accepts valid image and video generation requests', () => {
  const capabilities: ModelCapabilities = {
    modes: ['text_to_image', 'image_to_image'],
    parameters: [
      {
        type: 'enum',
        name: 'size',
        required: true,
        options: ['1024x1024', '1280x720', '720x1280'],
        defaultValue: '1024x1024',
      },
      {
        type: 'integer',
        name: 'count',
        required: false,
        min: 1,
        max: 4,
        defaultValue: 1,
      },
      {
        type: 'boolean',
        name: 'watermark',
        required: false,
        defaultValue: false,
      },
      {
        type: 'text',
        name: 'negativePrompt',
        required: false,
        maxLength: 200,
      },
    ],
    inputSlots: [
      {
        role: 'reference_image',
        required: false,
        minCount: 0,
        maxCount: 2,
        allowedMediaKinds: ['image'],
      },
    ],
    maxCount: 4,
  }

  const validRequest: CreateGenerationRequest = {
    modelId: 'seedream-4-5',
    prompt: 'A futuristic city in mist',
    parameters: {
      size: '1280x720',
      count: 2,
      watermark: true,
      negativePrompt: 'blurry, distorted',
    },
    inputs: [
      {
        uploadId: 'upload-1',
        role: 'reference_image',
        position: 0,
      },
    ],
  }

  const result = validateGenerationRequest(capabilities, validRequest)
  assert.equal(result.valid, true)
  if (result.valid) {
    assert.equal(result.value.modelId, 'seedream-4-5')
    assert.equal(result.value.prompt, 'A futuristic city in mist')
    assert.equal(result.value.mode, 'image_to_image')
    assert.deepEqual(result.value.parameters, {
      size: '1280x720',
      count: 2,
      watermark: true,
      negativePrompt: 'blurry, distorted',
    })
    assert.equal(result.value.inputs.length, 1)
  }

  // Text to video capability check
  const videoCapabilities: ModelCapabilities = {
    modes: ['text_to_video', 'image_to_video'],
    supportedMediaKinds: ['video'],
    parameters: [
      {
        type: 'enum',
        name: 'aspectRatio',
        options: ['16:9', '9:16', '1:1'],
        defaultValue: '16:9',
      },
      {
        type: 'integer',
        name: 'durationSeconds',
        min: 3,
        max: 10,
        step: 1,
        defaultValue: 5,
      },
      {
        type: 'boolean',
        name: 'generateAudio',
        defaultValue: false,
      },
    ],
    inputSlots: [
      {
        role: 'first_frame',
        required: false,
        minCount: 0,
        maxCount: 1,
        allowedMediaKinds: ['image'],
      },
      {
        role: 'last_frame',
        required: false,
        minCount: 0,
        maxCount: 1,
        allowedMediaKinds: ['image'],
      },
    ],
  }

  const textToVideoRequest: CreateGenerationRequest = {
    modelId: 'veo-v2',
    prompt: 'A red sports car speeding through desert dunes at dusk',
    parameters: {
      durationSeconds: 5,
    },
  }

  const videoResult = validateGenerationRequest(videoCapabilities, textToVideoRequest)
  assert.equal(videoResult.valid, true)
  if (videoResult.valid) {
    assert.equal(videoResult.value.mode, 'text_to_video')
    // Defaults filled
    assert.equal(videoResult.value.parameters.aspectRatio, '16:9')
    assert.equal(videoResult.value.parameters.generateAudio, false)
    assert.equal(videoResult.value.parameters.durationSeconds, 5)
  }
})

test('descriptor-driven validation rejects unknown parameters and type/bounds violations', () => {
  const capabilities: ModelCapabilities = {
    modes: ['text_to_image'],
    parameters: [
      {
        type: 'enum',
        name: 'quality',
        options: ['standard', 'hd'],
        required: true,
      },
      {
        type: 'integer',
        name: 'steps',
        min: 10,
        max: 50,
        step: 5,
      },
      {
        type: 'boolean',
        name: 'enableTiling',
      },
      {
        type: 'text',
        name: 'style',
        pattern: '^[a-z_]+$',
        maxLength: 10,
      },
    ],
    inputSlots: [],
  }

  // Unknown parameter
  const unknownParamResult = validateGenerationRequest(capabilities, {
    modelId: 'model-1',
    prompt: 'hello',
    parameters: {
      quality: 'standard',
      rogueField: 'forbidden',
    },
  })
  assert.equal(unknownParamResult.valid, false)
  if (!unknownParamResult.valid) {
    assert.equal(unknownParamResult.errorCode, 'UNKNOWN_PARAMETER')
  }

  // Invalid enum value
  const invalidEnumResult = validateGenerationRequest(capabilities, {
    modelId: 'model-1',
    prompt: 'hello',
    parameters: {
      quality: 'ultra',
    },
  })
  assert.equal(invalidEnumResult.valid, false)
  if (!invalidEnumResult.valid) {
    // Renamed deliberately: a value the model simply does not offer is a
    // capability statement, not a schema violation, and the user asked for an
    // error that says so. `INVALID_PARAMETER_VALUE` remains in
    // `GenerationErrorCode` because historical job rows still carry it.
    assert.equal(invalidEnumResult.errorCode, 'UNSUPPORTED_MEDIA_PARAMETER')
  }

  // Integer out of bounds
  const intOutOfRangeResult = validateGenerationRequest(capabilities, {
    modelId: 'model-1',
    prompt: 'hello',
    parameters: {
      quality: 'standard',
      steps: 100,
    },
  })
  assert.equal(intOutOfRangeResult.valid, false)
  if (!intOutOfRangeResult.valid) {
    assert.equal(intOutOfRangeResult.errorCode, 'PARAMETER_OUT_OF_RANGE')
  }

  // Integer step mismatch
  const intStepMismatchResult = validateGenerationRequest(capabilities, {
    modelId: 'model-1',
    prompt: 'hello',
    parameters: {
      quality: 'standard',
      steps: 12,
    },
  })
  assert.equal(intStepMismatchResult.valid, false)
  if (!intStepMismatchResult.valid) {
    assert.equal(intStepMismatchResult.errorCode, 'PARAMETER_STEP_MISMATCH')
  }

  // Invalid boolean type
  const badBoolResult = validateGenerationRequest(capabilities, {
    modelId: 'model-1',
    prompt: 'hello',
    parameters: {
      quality: 'standard',
      enableTiling: 'yes' as unknown as boolean,
    },
  })
  assert.equal(badBoolResult.valid, false)
  if (!badBoolResult.valid) {
    assert.equal(badBoolResult.errorCode, 'INVALID_PARAMETER_TYPE')
  }

  // Text pattern mismatch
  const badPatternResult = validateGenerationRequest(capabilities, {
    modelId: 'model-1',
    prompt: 'hello',
    parameters: {
      quality: 'standard',
      style: 'BAD!',
    },
  })
  assert.equal(badPatternResult.valid, false)
  if (!badPatternResult.valid) {
    assert.equal(badPatternResult.errorCode, 'TEXT_PATTERN_MISMATCH')
  }

  // Missing required parameter
  const missingReqResult = validateGenerationRequest(capabilities, {
    modelId: 'model-1',
    prompt: 'hello',
    parameters: {},
  })
  assert.equal(missingReqResult.valid, false)
  if (!missingReqResult.valid) {
    assert.equal(missingReqResult.errorCode, 'MISSING_REQUIRED_PARAMETER')
  }
})

test('ordered input slots validation rejects invalid roles, counts, and duplicates', () => {
  const capabilities: ModelCapabilities = {
    modes: ['image_to_video'],
    supportedMediaKinds: ['video'],
    parameters: [],
    inputSlots: [
      {
        role: 'first_frame',
        required: true,
        minCount: 1,
        maxCount: 1,
        allowedMediaKinds: ['image'],
      },
      {
        role: 'reference_image',
        required: false,
        minCount: 0,
        maxCount: 2,
        allowedMediaKinds: ['image'],
      },
    ],
  }

  // Unknown role
  const unknownRoleResult = validateGenerationRequest(capabilities, {
    modelId: 'vid-1',
    prompt: 'motion test',
    parameters: {},
    inputs: [
      { uploadId: 'u-1', role: 'random_role', position: 0 },
    ],
  })
  assert.equal(unknownRoleResult.valid, false)
  if (!unknownRoleResult.valid) {
    assert.equal(unknownRoleResult.errorCode, 'UNKNOWN_INPUT_ROLE')
  }

  // Missing required input slot
  const missingSlotResult = validateGenerationRequest(capabilities, {
    modelId: 'vid-1',
    prompt: 'motion test',
    parameters: {},
    inputs: [
      { uploadId: 'u-2', role: 'reference_image', position: 0 },
    ],
  })
  assert.equal(missingSlotResult.valid, false)
  if (!missingSlotResult.valid) {
    assert.equal(missingSlotResult.errorCode, 'MISSING_REQUIRED_INPUT')
  }

  // Exceeded maxCount for role
  const exceededCountResult = validateGenerationRequest(capabilities, {
    modelId: 'vid-1',
    prompt: 'motion test',
    parameters: {},
    inputs: [
      { uploadId: 'u-1', role: 'first_frame', position: 0 },
      { uploadId: 'u-2', role: 'reference_image', position: 1 },
      { uploadId: 'u-3', role: 'reference_image', position: 2 },
      { uploadId: 'u-4', role: 'reference_image', position: 3 },
    ],
  })
  assert.equal(exceededCountResult.valid, false)
  if (!exceededCountResult.valid) {
    assert.equal(exceededCountResult.errorCode, 'INPUT_COUNT_EXCEEDED')
  }

  // Duplicate position
  const duplicatePosResult = validateGenerationRequest(capabilities, {
    modelId: 'vid-1',
    prompt: 'motion test',
    parameters: {},
    inputs: [
      { uploadId: 'u-1', role: 'first_frame', position: 0 },
      { uploadId: 'u-2', role: 'reference_image', position: 0 },
    ],
  })
  assert.equal(duplicatePosResult.valid, false)
  if (!duplicatePosResult.valid) {
    assert.equal(duplicatePosResult.errorCode, 'DUPLICATE_INPUT_POSITION')
  }

  // Normalization sorts inputs by position ascending
  const normalized = normalizeGenerationRequest(capabilities, {
    modelId: 'vid-1',
    prompt: 'motion test',
    parameters: {},
    inputs: [
      { uploadId: 'u-ref', role: 'reference_image', position: 1 },
      { uploadId: 'u-first', role: 'first_frame', position: 0 },
    ],
  })
  assert.equal(normalized.inputs[0].position, 0)
  assert.equal(normalized.inputs[0].uploadId, 'u-first')
  assert.equal(normalized.inputs[1].position, 1)
  assert.equal(normalized.inputs[1].uploadId, 'u-ref')
})

test('cross-field constraints validate max_product, requires, and mutually_exclusive', () => {
  const config: ModelValidationConfig = {
    modes: ['text_to_image'],
    parameters: [
      { type: 'integer', name: 'width', min: 256, max: 4096 },
      { type: 'integer', name: 'height', min: 256, max: 4096 },
      { type: 'enum', name: 'hdrMode', options: ['on', 'off'] },
      { type: 'text', name: 'colorProfile' },
      { type: 'boolean', name: 'fastMode' },
      { type: 'boolean', name: 'highQualityMode' },
    ],
    inputSlots: [],
    crossFieldConstraints: [
      {
        type: 'max_product',
        parameters: ['width', 'height'],
        parameter: 'width',
        maxProduct: 4096 * 2048,
        message: 'Total pixels must not exceed 8,388,608',
      },
      {
        type: 'requires',
        parameter: 'hdrMode',
        whenValueEquals: 'on',
        targetParameter: 'colorProfile',
        message: 'colorProfile is required when hdrMode is on',
      },
      {
        type: 'mutually_exclusive',
        parameter: 'fastMode',
        parameters: ['fastMode', 'highQualityMode'],
        message: 'fastMode and highQualityMode cannot both be enabled',
      },
    ],
  }

  // max_product failure
  const productFail = validateGenerationRequest(config, {
    modelId: 'm-1',
    prompt: 'test',
    parameters: { width: 4096, height: 4096 },
  })
  assert.equal(productFail.valid, false)
  if (!productFail.valid) {
    assert.equal(productFail.errorCode, 'MAX_PRODUCT_EXCEEDED')
  }

  // max_product success
  const productOk = validateGenerationRequest(config, {
    modelId: 'm-1',
    prompt: 'test',
    parameters: { width: 2048, height: 2048 },
  })
  assert.equal(productOk.valid, true)

  // requires constraint failure
  const reqFail = validateGenerationRequest(config, {
    modelId: 'm-1',
    prompt: 'test',
    parameters: { hdrMode: 'on' },
  })
  assert.equal(reqFail.valid, false)
  if (!reqFail.valid) {
    assert.equal(reqFail.errorCode, 'REQUIRED_FIELD_MISSING')
  }

  // mutually_exclusive failure
  const mutexFail = validateGenerationRequest(config, {
    modelId: 'm-1',
    prompt: 'test',
    parameters: { fastMode: true, highQualityMode: true },
  })
  assert.equal(mutexFail.valid, false)
  if (!mutexFail.valid) {
    assert.equal(mutexFail.errorCode, 'MUTUALLY_EXCLUSIVE_PARAMETERS')
  }
})

test('canonical normalization and serialization is strictly deterministic', () => {
  const req1: CreateGenerationRequest = {
    modelId: 'seedream-4-5',
    prompt: '  A peaceful mountain lake at sunrise   ',
    parameters: {
      z: 10,
      a: 1,
      m: 'middle',
      nested: { beta: 2, alpha: 1 },
    },
    inputs: [
      { uploadId: 'u-2', role: 'reference_image', position: 1 },
      { uploadId: 'u-1', role: 'first_frame', position: 0 },
    ],
  }

  const req2: CreateGenerationRequest = {
    prompt: 'A peaceful mountain lake at sunrise',
    modelId: 'seedream-4-5',
    parameters: {
      a: 1,
      nested: { alpha: 1, beta: 2 },
      m: 'middle',
      z: 10,
    },
    inputs: [
      { uploadId: 'u-1', role: 'first_frame', position: 0 },
      { uploadId: 'u-2', role: 'reference_image', position: 1 },
    ],
  }

  const serialized1 = serializeCanonicalGenerationRequest(req1)
  const serialized2 = serializeCanonicalGenerationRequest(req2)
  const digest1 = prepareRequestDigestInput(req1)
  const digest2 = prepareRequestDigestInput(req2)

  assert.equal(serialized1, serialized2)
  assert.equal(digest1, digest2)

  // Ensure JSON keys are sorted
  const canonicalJson = serializeCanonicalJson({ z: 1, b: 2, a: 3 })
  assert.equal(canonicalJson, '{"a":3,"b":2,"z":1}')
})

const assetRefCapabilities: ModelValidationConfig = {
  modes: ['text_to_image', 'image_to_image'],
  supportedMediaKinds: ['image'],
  parameters: [],
  inputSlots: [
    { role: 'reference_image', required: false, minCount: 0, maxCount: 4, allowedMediaKinds: ['image'] },
  ],
  maxCount: 4,
}

function assetRefRequest(inputs: CreateGenerationRequest['inputs']): CreateGenerationRequest {
  return { modelId: 'seedream-4-5', prompt: 'reuse my gallery image', parameters: {}, inputs }
}

test('a gallery assetId is accepted as the only reference on an input', () => {
  const result = validateGenerationRequest(
    assetRefCapabilities,
    assetRefRequest([{ assetId: '2f1c9b7e-3a4d-4c8e-9b2a-1d0e7c5b8a44', role: 'reference_image', position: 0 }]),
  )

  assert.equal(result.valid, true)
  if (result.valid) {
    assert.equal(result.value.mode, 'image_to_image', 'an asset input is still an image-to-image request')
    assert.equal(result.value.inputs[0].assetId, '2f1c9b7e-3a4d-4c8e-9b2a-1d0e7c5b8a44')
    assert.equal(result.value.inputs[0].uploadId, undefined)
  }
})

test('uploads and gallery assets mix freely inside one request', () => {
  const result = validateGenerationRequest(
    assetRefCapabilities,
    assetRefRequest([
      { uploadId: 'u-1', role: 'reference_image', position: 0 },
      { assetId: 'a-1', role: 'reference_image', position: 1 },
    ]),
  )

  assert.equal(result.valid, true)
})

test('an input must carry exactly one reference', () => {
  const both = validateGenerationRequest(
    assetRefCapabilities,
    assetRefRequest([{ uploadId: 'u-1', assetId: 'a-1', role: 'reference_image', position: 0 }]),
  )
  assert.equal(both.valid, false)
  if (!both.valid) {
    assert.equal(both.errorCode, 'INVALID_INPUT_REF')
  }

  const neither = validateGenerationRequest(
    assetRefCapabilities,
    assetRefRequest([{ role: 'reference_image', position: 0 }]),
  )
  assert.equal(neither.valid, false)
  if (!neither.valid) {
    // Kept as the historical code so existing client-side error copy still matches.
    assert.equal(neither.errorCode, 'INVALID_INPUT_UPLOAD_ID')
  }
})

test('the same image cannot occupy two slots, but upload and asset ids never collide', () => {
  const sameAssetTwice = validateGenerationRequest(
    assetRefCapabilities,
    assetRefRequest([
      { assetId: 'a-1', role: 'reference_image', position: 0 },
      { assetId: 'a-1', role: 'reference_image', position: 1 },
    ]),
  )
  assert.equal(sameAssetTwice.valid, false)
  if (!sameAssetTwice.valid) {
    assert.equal(sameAssetTwice.errorCode, 'DUPLICATE_INPUT_REF')
  }

  // The dedupe key is prefixed per kind, so one string used as both an upload id
  // and an asset id is still two distinct images.
  const mixedNamespaces = validateGenerationRequest(
    assetRefCapabilities,
    assetRefRequest([
      { uploadId: 'same-id', role: 'reference_image', position: 0 },
      { assetId: 'same-id', role: 'reference_image', position: 1 },
    ]),
  )
  assert.equal(mixedNamespaces.valid, true)
})

test('two different gallery picks hash to two different request digests', () => {
  const first = prepareRequestDigestInput(
    assetRefRequest([{ assetId: 'aaaaaaaa-1111-4111-8111-111111111111', role: 'reference_image', position: 0 }]),
  )
  const second = prepareRequestDigestInput(
    assetRefRequest([{ assetId: 'bbbbbbbb-1111-4111-8111-111111111111', role: 'reference_image', position: 0 }]),
  )

  assert.notEqual(first, second, 'a digest that ignores assetId would let one idempotency key swallow both jobs')
})

test('upload-only request digests are byte-identical after assetId was introduced', () => {
  const uploadOnly = prepareRequestDigestInput(
    assetRefRequest([{ uploadId: 'u-1', role: 'reference_image', position: 0 }]),
  )
  const uploadWithUndefinedAsset = prepareRequestDigestInput(
    assetRefRequest([{ uploadId: 'u-1', assetId: undefined, role: 'reference_image', position: 0 }]),
  )

  assert.equal(uploadOnly, uploadWithUndefinedAsset)
  assert.ok(!uploadOnly.includes('assetId'), 'undefined refs must stay out of the canonical form')
})
