import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertSafeCredits,
  isSafeCreditAmount,
  MAX_SAFE_CREDITS,
  type ModelValidationConfig,
  normalizeGenerationRequest,
  prepareRequestDigestInput,
  quoteGenerationCredits,
  quoteMediaGenerationCredits,
  serializeCanonicalGenerationRequest,
  serializeCanonicalJson,
  validateGenerationRequest,
  validateModelInput,
  validateSafeCredits,
} from './index'
import {
  BILLING_STATE_CONFLICT,
  BillingErrorCode,
  type CreateGenerationRequest,
  GENERATION_PRICE_CHANGED,
  type GenerationOutput,
  type ImageGenerationOutput,
  type ImagePricingV1,
  INSUFFICIENT_CREDITS,
  INVALID_CREDIT_AMOUNT,
  type ModelCapabilities,
  type VideoGenerationOutput,
  type VideoPricingV1,
} from '@musecanvas/contracts'

test('contracts export all expected billing error codes', () => {
  assert.equal(INSUFFICIENT_CREDITS, 'INSUFFICIENT_CREDITS')
  assert.equal(GENERATION_PRICE_CHANGED, 'GENERATION_PRICE_CHANGED')
  assert.equal(BILLING_STATE_CONFLICT, 'BILLING_STATE_CONFLICT')
  assert.equal(INVALID_CREDIT_AMOUNT, 'INVALID_CREDIT_AMOUNT')

  assert.equal(BillingErrorCode.INSUFFICIENT_CREDITS, 'INSUFFICIENT_CREDITS')
  assert.equal(BillingErrorCode.GENERATION_PRICE_CHANGED, 'GENERATION_PRICE_CHANGED')
  assert.equal(BillingErrorCode.BILLING_STATE_CONFLICT, 'BILLING_STATE_CONFLICT')
  assert.equal(BillingErrorCode.INVALID_CREDIT_AMOUNT, 'INVALID_CREDIT_AMOUNT')
})

test('validateSafeCredits / isSafeCreditAmount validates credit amounts correctly', () => {
  assert.equal(validateSafeCredits(0), true)
  assert.equal(validateSafeCredits(1), true)
  assert.equal(validateSafeCredits(100), true)
  assert.equal(validateSafeCredits(MAX_SAFE_CREDITS), true)

  // invalid amounts
  assert.equal(validateSafeCredits(-1), false)
  assert.equal(validateSafeCredits(1.5), false)
  assert.equal(validateSafeCredits(0.1), false)
  assert.equal(validateSafeCredits(NaN), false)
  assert.equal(validateSafeCredits(Infinity), false)
  assert.equal(validateSafeCredits(-Infinity), false)
  assert.equal(validateSafeCredits(MAX_SAFE_CREDITS + 1), false)
  assert.equal(validateSafeCredits('100'), false)
  assert.equal(validateSafeCredits(null), false)
  assert.equal(validateSafeCredits(undefined), false)
  assert.equal(validateSafeCredits({}), false)

  assert.equal(isSafeCreditAmount(50), true)
  assert.equal(isSafeCreditAmount(-5), false)
})

test('assertSafeCredits throws on invalid values', () => {
  assert.doesNotThrow(() => assertSafeCredits(0))
  assert.doesNotThrow(() => assertSafeCredits(10))
  assert.doesNotThrow(() => assertSafeCredits(MAX_SAFE_CREDITS))

  assert.throws(() => assertSafeCredits(-1), RangeError)
  assert.throws(() => assertSafeCredits(2.5), RangeError)
  assert.throws(() => assertSafeCredits(MAX_SAFE_CREDITS + 1), RangeError)
  assert.throws(() => assertSafeCredits(NaN), TypeError)
  assert.throws(() => assertSafeCredits(Infinity), TypeError)
  assert.throws(() => assertSafeCredits('100'), TypeError)
})

test('quoteGenerationCredits calculates fixed quote correctly', () => {
  // Object input
  const quote1 = quoteGenerationCredits({
    creditsPerImage: 2,
    count: 4,
    optimizationCredits: 1,
  })
  assert.deepEqual(quote1, {
    creditsPerImage: 2,
    count: 4,
    optimizationCredits: 1,
    imageCredits: 8,
    totalCredits: 9,
    quotedCredits: 9,
  })

  // Positional input without optimizationCredits
  const quote2 = quoteGenerationCredits(3, 2)
  assert.deepEqual(quote2, {
    creditsPerImage: 3,
    count: 2,
    optimizationCredits: 0,
    imageCredits: 6,
    totalCredits: 6,
    quotedCredits: 6,
  })

  // Zero creditsPerImage
  const quote3 = quoteGenerationCredits({
    creditsPerImage: 0,
    count: 2,
    optimizationCredits: 5,
  })
  assert.deepEqual(quote3, {
    creditsPerImage: 0,
    count: 2,
    optimizationCredits: 5,
    imageCredits: 0,
    totalCredits: 5,
    quotedCredits: 5,
  })
})

test('quoteGenerationCredits rejects invalid counts', () => {
  assert.throws(() => quoteGenerationCredits({ creditsPerImage: 1, count: 0 }), RangeError)
  assert.throws(() => quoteGenerationCredits({ creditsPerImage: 1, count: -1 }), RangeError)
  assert.throws(() => quoteGenerationCredits({ creditsPerImage: 1, count: 1.5 }), RangeError)
  assert.throws(() => quoteGenerationCredits({ creditsPerImage: 1, count: NaN }), TypeError)
  assert.throws(() => quoteGenerationCredits({ creditsPerImage: 1, count: Infinity }), TypeError)
})

test('quoteGenerationCredits rejects invalid creditsPerImage and optimizationCredits', () => {
  assert.throws(() => quoteGenerationCredits({ creditsPerImage: -1, count: 1 }), RangeError)
  assert.throws(() => quoteGenerationCredits({ creditsPerImage: 1.5, count: 1 }), RangeError)
  assert.throws(() => quoteGenerationCredits({ creditsPerImage: 1, count: 1, optimizationCredits: -1 }), RangeError)
  assert.throws(() => quoteGenerationCredits({ creditsPerImage: 1, count: 1, optimizationCredits: 0.5 }), RangeError)
  assert.throws(() => quoteGenerationCredits({ creditsPerImage: NaN, count: 1 }), TypeError)
})

test('quoteGenerationCredits rejects overflow beyond safe integer', () => {
  // Multiplication overflow
  assert.throws(
    () => quoteGenerationCredits({ creditsPerImage: Math.floor(MAX_SAFE_CREDITS / 2) + 1, count: 3 }),
    RangeError
  )

  // Addition overflow
  assert.throws(
    () => quoteGenerationCredits({ creditsPerImage: MAX_SAFE_CREDITS, count: 1, optimizationCredits: 1 }),
    RangeError
  )
})

test('legacy validateModelInput behaves correctly for existing models', () => {
  const model = {
    adapter: 'openai',
    vendorModelId: 'gpt-image-2',
    sizes: ['1024x1024', '1280x720'],
    qualityOptions: ['auto', 'low', 'medium', 'high'],
    maxCount: 4,
  }

  assert.equal(validateModelInput(model, { size: '1024x1024', quality: 'high', count: 1 }), null)
  assert.equal(validateModelInput(model, { size: '2K', quality: 'medium', count: 2 }), null)
  assert.equal(validateModelInput(model, { size: 'bad-size', quality: 'medium', count: 1 }), 'INVALID_SIZE')
  assert.equal(validateModelInput(model, { size: '1024x1024', quality: 'invalid-q', count: 1 }), 'INVALID_QUALITY')
  assert.equal(validateModelInput(model, { size: '1024x1024', quality: 'high', count: 0 }), 'INVALID_COUNT')
  assert.equal(validateModelInput(model, { size: '1024x1024', quality: 'high', count: 5 }), 'INVALID_COUNT')
})

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
    assert.equal(invalidEnumResult.errorCode, 'INVALID_PARAMETER_VALUE')
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
    constraints: [
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

test('quoteMediaGenerationCredits calculates image quotes with safe-integer checks', () => {
  const imagePricing: ImagePricingV1 = {
    scheme: 'per_image_v1',
    creditsPerImage: 5,
  }

  const quote = quoteMediaGenerationCredits({
    pricing: imagePricing,
    count: 3,
    optimizationCredits: 2,
  })

  assert.deepEqual(quote, {
    pricing: imagePricing,
    count: 3,
    durationSeconds: undefined,
    baseCredits: 15,
    optimizationCredits: 2,
    totalCredits: 17,
    quotedCredits: 17,
  })

  // Rejects invalid counts
  assert.throws(() => quoteMediaGenerationCredits({ pricing: imagePricing, count: 0 }), RangeError)
  assert.throws(() => quoteMediaGenerationCredits({ pricing: imagePricing, count: -2 }), RangeError)
  assert.throws(() => quoteMediaGenerationCredits({ pricing: imagePricing, count: 1.5 }), RangeError)
})

test('quoteMediaGenerationCredits calculates video quotes with safe-integer checks', () => {
  const videoPricing: VideoPricingV1 = {
    scheme: 'per_second_v1',
    creditsPerSecond: 10,
    minDurationSeconds: 2,
    maxDurationSeconds: 15,
  }

  const quote = quoteMediaGenerationCredits({
    pricing: videoPricing,
    durationSeconds: 5,
    count: 1,
    optimizationCredits: 1,
  })

  assert.deepEqual(quote, {
    pricing: videoPricing,
    count: 1,
    durationSeconds: 5,
    baseCredits: 50,
    optimizationCredits: 1,
    totalCredits: 51,
    quotedCredits: 51,
  })

  // Multiple outputs for video
  const multiQuote = quoteMediaGenerationCredits({
    pricing: videoPricing,
    durationSeconds: 4,
    count: 2,
    optimizationCredits: 0,
  })
  assert.equal(multiQuote.baseCredits, 80)
  assert.equal(multiQuote.totalCredits, 80)

  // Duration boundary violations
  assert.throws(
    () => quoteMediaGenerationCredits({ pricing: videoPricing, durationSeconds: 1 }),
    RangeError
  )
  assert.throws(
    () => quoteMediaGenerationCredits({ pricing: videoPricing, durationSeconds: 20 }),
    RangeError
  )
  assert.throws(
    () => quoteMediaGenerationCredits({ pricing: videoPricing, durationSeconds: 3.5 }),
    RangeError
  )

  // Overflow safety
  assert.throws(
    () =>
      quoteMediaGenerationCredits({
        pricing: { scheme: 'per_second_v1', creditsPerSecond: Math.floor(MAX_SAFE_CREDITS / 2) + 1 },
        durationSeconds: 3,
      }),
    RangeError
  )
})
