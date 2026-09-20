import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { ParameterDescriptor } from './index'
import {
  AUTO_SIZE_VALUE,
  describeImageSize,
  enumOptionValues,
  evaluateCrossFieldConstraints,
  imageConstraintViolations,
  isAdvancedParameter,
  isParameterVisible,
  normalizeParameterOptions,
  parseImageSize,
  reconcileParameters,
  reduceRatio,
  resolveParameterVisibility,
  sizeAspectRatio,
  validateImageSizeValue,
  validateModelCapabilities,
  validateParameterValue,
  MEDIA_PARAMETER_LIMITS,
} from './media-parameter-validation'
import { GenerationErrorCode } from './media-parameters'
import type { ImageSizeConstraints, ImageSizeParameterDescriptor } from './media-parameters'

/**
 * Unit coverage for the shared validator.
 *
 * `packages/contracts` is not in CI's per-package test filter, so the same
 * behaviour is additionally driven through `@musecanvas/domain` in
 * `packages/domain/src/media-capabilities.test.ts`. This file is the precise
 * per-rule coverage; that file is the guarantee CI actually executes it.
 */

const CONSTRAINTS: ImageSizeConstraints = {
  maxWidth: 3840,
  maxHeight: 3840,
  widthMultipleOf: 16,
  heightMultipleOf: 16,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxAspectRatio: 3,
}

function sizeDescriptor(overrides: Partial<ImageSizeParameterDescriptor> = {}): ImageSizeParameterDescriptor {
  return {
    type: 'image-size',
    name: 'size',
    presets: [
      { value: 'auto', label: '自动' },
      { value: '1024x1024', label: '1:1 · 1024 × 1024', width: 1024, height: 1024 },
    ],
    allowCustom: true,
    constraints: CONSTRAINTS,
    defaultValue: 'auto',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Options widening
// ---------------------------------------------------------------------------

test('bare-string options and rich options normalise to the same shape', () => {
  // Bare strings are what every persisted revision snapshot stores, so this is
  // backward compatibility with real data, not a convenience.
  assert.deepEqual(normalizeParameterOptions(['a', 'b']), [
    { value: 'a', label: 'a' },
    { value: 'b', label: 'b' },
  ])
  assert.deepEqual(enumOptionValues(['a', { value: 'b', label: 'B' }]), ['a', 'b'])
  assert.deepEqual(normalizeParameterOptions([{ value: 'x' }]), [{ value: 'x', label: 'x' }])
  assert.deepEqual(normalizeParameterOptions(undefined), [])
})

test('an enum accepts either spelling and rejects an unoffered value', () => {
  const descriptor: ParameterDescriptor = {
    type: 'enum', name: 'quality', options: ['auto', { value: 'max', label: 'Max' }],
  }
  assert.deepEqual(validateParameterValue(descriptor, 'auto'), [])
  assert.deepEqual(validateParameterValue(descriptor, 'max'), [])
  const rejection = validateParameterValue(descriptor, 'ultra')
  assert.equal(rejection[0]?.code, GenerationErrorCode.UNSUPPORTED_MEDIA_PARAMETER)
  // The message enumerates what *is* legal, using the raw values.
  assert.match(rejection[0]?.message ?? '', /auto, max/)
})

// ---------------------------------------------------------------------------
// Size geometry
// ---------------------------------------------------------------------------

test('parseImageSize accepts only positive WxH and nothing else', () => {
  assert.deepEqual(parseImageSize('1024x1024'), { width: 1024, height: 1024 })
  for (const bad of ['auto', '1024', '0x1024', '1024x0', '-1x1024', '1024 x 1024', 'x', '1e3x1024']) {
    assert.equal(parseImageSize(bad), null, `${bad} must not parse`)
  }
})

test('every declared constraint produces its own specific violation', () => {
  const cases: Array<[number, number, string]> = [
    [1537, 864, 'widthMultipleOf'],
    [1536, 865, 'heightMultipleOf'],
    [3856, 2160, 'maxWidth'],
    [2160, 3856, 'maxHeight'],
    [3840, 1024, 'maxAspectRatio'],
    [3840, 3840, 'maxPixels'],
    [640, 640, 'minPixels'],
  ]
  for (const [width, height, constraint] of cases) {
    const issues = imageConstraintViolations(CONSTRAINTS, width, height, 'size')
    assert.ok(issues.length > 0, `${width}x${height} must be rejected`)
    assert.equal(issues[0]?.constraint, constraint, `${width}x${height}: ${issues[0]?.message}`)
    assert.equal(issues[0]?.code, GenerationErrorCode.MEDIA_PARAMETER_CONSTRAINT_FAILED)
  }
})

test('a boundary-exact size is accepted, not merely close', () => {
  // Each of these sits exactly on a limit the vendor states inclusively; a `<`
  // where a `<=` belongs would reject a size the model really does support.
  assert.deepEqual(imageConstraintViolations(CONSTRAINTS, 3840, 2160, 'size'), [])
  assert.deepEqual(imageConstraintViolations(CONSTRAINTS, 1024, 640, 'size'), []) // 655,360 px
  assert.deepEqual(imageConstraintViolations(CONSTRAINTS, 3840, 1280, 'size'), []) // 3:1 exactly
})

test('min and max dimension floors are honoured when declared', () => {
  const constraints: ImageSizeConstraints = { minWidth: 512, minHeight: 512 }
  assert.equal(imageConstraintViolations(constraints, 256, 1024, 'size')[0]?.constraint, 'minWidth')
  assert.equal(imageConstraintViolations(constraints, 1024, 256, 'size')[0]?.constraint, 'minHeight')
})

test('aspect ratio is orientation-independent', () => {
  assert.equal(sizeAspectRatio(3840, 1280), 3)
  assert.equal(sizeAspectRatio(1280, 3840), 3)
  assert.equal(sizeAspectRatio(0, 100), Number.POSITIVE_INFINITY)
})

test('a preset is accepted without allowCustom, anything else is not', () => {
  const fixed = sizeDescriptor({ allowCustom: false, constraints: undefined })
  assert.deepEqual(validateImageSizeValue(fixed, '1024x1024'), [])
  const rejection = validateImageSizeValue(fixed, '2048x2048')
  assert.equal(rejection[0]?.code, GenerationErrorCode.UNSUPPORTED_MEDIA_PARAMETER)
  assert.match(rejection[0]?.message ?? '', /auto, 1024x1024/)
})

test('auto is a legal size that carries no geometry', () => {
  assert.equal(AUTO_SIZE_VALUE, 'auto')
  assert.deepEqual(validateImageSizeValue(sizeDescriptor(), 'auto'), [])
})

test('a custom size that is not parseable reports a format problem', () => {
  const issues = validateImageSizeValue(sizeDescriptor(), 'wide')
  assert.equal(issues[0]?.constraint, 'format')
})

test('non-string sizes are a type error, not a coercion', () => {
  assert.equal(validateImageSizeValue(sizeDescriptor(), 1024 as never)[0]?.code, GenerationErrorCode.INVALID_PARAMETER_TYPE)
})

test('preset geometry is labelled without the UI parsing the value', () => {
  assert.equal(describeImageSize({ value: 'auto', label: '自动' }), '自动')
  assert.equal(describeImageSize({ value: '1536x1024', label: 'x', width: 1536, height: 1024 }), '3:2 · 1536 × 1024')
  assert.equal(reduceRatio(2048, 1152), '16:9')
  assert.equal(reduceRatio(2160, 3840), '9:16')
})

// ---------------------------------------------------------------------------
// Numeric and visibility
// ---------------------------------------------------------------------------

test('number descriptors bound, step and precision-check independently', () => {
  const descriptor: ParameterDescriptor = { type: 'number', name: 'strength', min: 0, max: 1, step: 0.05 }
  assert.deepEqual(validateParameterValue(descriptor, 0.35), [])
  assert.equal(validateParameterValue(descriptor, 1.5)[0]?.code, GenerationErrorCode.PARAMETER_OUT_OF_RANGE)
  assert.equal(validateParameterValue(descriptor, 0.37)[0]?.code, GenerationErrorCode.PARAMETER_STEP_MISMATCH)
  assert.equal(validateParameterValue(descriptor, '0.35')[0]?.code, GenerationErrorCode.INVALID_PARAMETER_TYPE)
  assert.equal(validateParameterValue({ type: 'number', name: 'p', precision: 2 }, 0.123)[0]?.code,
    GenerationErrorCode.PARAMETER_STEP_MISMATCH)
})

test('dependsOn hides a parameter without failing it', () => {
  const descriptor: ParameterDescriptor = {
    type: 'integer', name: 'output_compression', min: 0, max: 100,
    dependsOn: { parameter: 'output_format', values: ['jpeg', 'webp'] },
  }
  assert.equal(isParameterVisible(descriptor, { output_format: 'jpeg' }), true)
  assert.equal(isParameterVisible(descriptor, { output_format: 'webp' }), true)
  assert.equal(isParameterVisible(descriptor, { output_format: 'png' }), false)
  // No controller value at all means the dependent control is not offerable.
  assert.equal(isParameterVisible(descriptor, {}), false)
  assert.equal(isParameterVisible(descriptor, undefined), false)
  assert.equal(resolveParameterVisibility([descriptor], { output_format: 'png' }).length, 0)
  assert.equal(isAdvancedParameter({ ui: { advanced: true } }), true)
  assert.equal(isAdvancedParameter({}), false)
})

test('string-vs-number controller values still match, as they do in the UI', () => {
  // Some providers declare an enum as '8' while normalization yields 8.
  const descriptor: ParameterDescriptor = {
    type: 'boolean', name: 'hd', dependsOn: { parameter: 'duration', values: [8] },
  }
  assert.equal(isParameterVisible(descriptor, { duration: '8' }), true)
  assert.equal(isParameterVisible(descriptor, { duration: 8 }), true)
  assert.equal(isParameterVisible(descriptor, { duration: 4 }), false)
})

// ---------------------------------------------------------------------------
// Model-switch reconciliation
// ---------------------------------------------------------------------------

test('reconciliation keeps legal picks and drops everything else', () => {
  const parameters: ParameterDescriptor[] = [
    { type: 'enum', name: 'quality', options: ['auto', 'high'] },
    { type: 'integer', name: 'count', min: 1, max: 2 },
    sizeDescriptor({ allowCustom: false, constraints: undefined }),
    { type: 'boolean', name: 'audio', dependsOn: { parameter: 'quality', values: ['high'] } },
  ]
  const reconciled = reconcileParameters(parameters, {
    quality: 'max',        // not offered by this model -> dropped
    count: 2,              // legal -> kept
    size: '1024x1024',     // legal preset -> kept
    audio: true,           // controller excludes it -> dropped
    steps: 30,             // not declared at all -> dropped
  })
  assert.deepEqual(reconciled, { count: 2, size: '1024x1024' })
})

test('reconciliation is idempotent, so it is safe inside an effect', () => {
  const parameters: ParameterDescriptor[] = [{ type: 'enum', name: 'quality', options: ['auto'] }]
  const once = reconcileParameters(parameters, { quality: 'ultra', extra: 1 })
  assert.deepEqual(once, {})
  assert.deepEqual(reconcileParameters(parameters, once), once)
})

// ---------------------------------------------------------------------------
// Declaration well-formedness
// ---------------------------------------------------------------------------

function capabilityFindings(capabilities: unknown): string[] {
  return validateModelCapabilities(capabilities).findings.map(f => f.rule)
}

const MINIMAL = {
  modes: ['text_to_image'],
  parameters: [{ type: 'enum', name: 'quality', options: ['auto'] }],
  inputSlots: [],
}

test('a well-formed contract validates and is rebuilt, not passed through', () => {
  const result = validateModelCapabilities({ ...MINIMAL, declaredBy: 'plugin-manifest' })
  assert.equal(result.ok, true, JSON.stringify(result.findings))
  assert.notEqual(result.capabilities, MINIMAL, 'the output must be a structural clone')
  assert.deepEqual(result.capabilities?.parameters?.[0].name, 'quality')
})

test('an unknown descriptor type is refused rather than guessed', () => {
  // Rule: never assume behaviour for a type the host cannot validate.
  assert.ok(capabilityFindings({
    modes: [], parameters: [{ type: 'aspect-ratio-v2', name: 'ratio' }], inputSlots: [],
  }).includes('UNKNOWN_PARAMETER_TYPE'))
})

test('allowCustom without constraints is refused', () => {
  assert.ok(capabilityFindings({
    modes: ['text_to_image'],
    parameters: [{ type: 'image-size', name: 'size', presets: [{ value: 'auto', label: 'a' }], allowCustom: true }],
    inputSlots: [],
  }).includes('INVALID_IMAGE_SIZE_RULES'))
})

test('a preset outside its own constraint band is refused', () => {
  // Presets are promises of legality, so this is a declaration bug and must fail
  // at scan time rather than at request time.
  const findings = capabilityFindings({
    modes: ['text_to_image'],
    parameters: [{
      type: 'image-size', name: 'size', defaultValue: 'auto',
      presets: [{ value: 'auto', label: 'a' }, { value: '9999x9999', label: 'b', width: 9999, height: 9999 }],
      allowCustom: true, constraints: CONSTRAINTS,
    }],
    inputSlots: [],
  })
  assert.ok(findings.includes('INVALID_IMAGE_SIZE_RULES'), findings.join(','))
})

test('a default outside the offered values is refused', () => {
  assert.ok(capabilityFindings({
    modes: ['text_to_image'],
    parameters: [{ type: 'enum', name: 'quality', options: ['auto'], defaultValue: 'max' }],
    inputSlots: [],
  }).includes('DEFAULT_NOT_ALLOWED'))
  assert.ok(capabilityFindings({
    ...MINIMAL,
    defaults: { quality: 'nope' },
  }).includes('DEFAULT_NOT_ALLOWED'))
})

test('flags must agree with modes', () => {
  const findings = capabilityFindings({
    modes: ['text_to_image'],
    parameters: [],
    inputSlots: [],
    flags: { textToImage: true, imageToImage: true, inpainting: true },
  })
  assert.ok(findings.includes('CAPABILITY_MODE_MISMATCH'), findings.join(','))
})

test('a constraint naming an undeclared parameter is refused', () => {
  assert.ok(capabilityFindings({
    ...MINIMAL,
    crossFieldConstraints: [{
      type: 'forbidden', parameter: 'nonexistent', targetParameter: 'quality',
    }],
  }).includes('CROSS_FIELD_UNKNOWN_PARAMETER'))
})

test('duplicate and oversized declarations are refused', () => {
  assert.ok(capabilityFindings({
    modes: [], inputSlots: [],
    parameters: [
      { type: 'enum', name: 'quality', options: ['a'] },
      { type: 'enum', name: 'quality', options: ['b'] },
    ],
  }).includes('INVALID_MODEL_CAPABILITIES'))

  const many = Array.from({ length: MEDIA_PARAMETER_LIMITS.parameters + 1 }, (_, index) => ({
    type: 'integer' as const, name: `p${index}`,
  }))
  assert.ok(capabilityFindings({ modes: [], inputSlots: [], parameters: many }).includes('PARAMETER_LIMIT'))
})

test('a required input slot that accepts nothing is refused', () => {
  assert.ok(capabilityFindings({
    modes: [], parameters: [],
    inputSlots: [{ role: 'first_frame', required: true, minCount: 0, maxCount: 0, allowedMediaKinds: ['image'] }],
  }).includes('INVALID_MODEL_CAPABILITIES'))
})

// ---------------------------------------------------------------------------
// Cross-field evaluation
// ---------------------------------------------------------------------------

test('targetValues narrows a forbidden pair to the offending value only', () => {
  const constraints = [{
    type: 'forbidden' as const,
    parameter: 'background',
    whenValueEquals: 'transparent',
    targetParameter: 'output_format',
    targetValues: ['jpeg'],
    message: 'needs alpha',
  }]
  assert.equal(evaluateCrossFieldConstraints(constraints, { background: 'transparent', output_format: 'jpeg' }).length, 1)
  assert.deepEqual(evaluateCrossFieldConstraints(constraints, { background: 'transparent', output_format: 'png' }), [])
  assert.deepEqual(evaluateCrossFieldConstraints(constraints, { background: 'opaque', output_format: 'jpeg' }), [])
})
