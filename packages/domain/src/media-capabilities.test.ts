import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { JsonValue, ModelCapabilities } from '@musecanvas/contracts'
import { validateGenerationRequest } from './index'

/**
 * The media parameter contract, exercised through the request validator rather
 * than against the descriptor helpers directly.
 *
 * This file deliberately lives in `packages/domain`, which CI does run, and
 * imports the validator from `@musecanvas/contracts`. The shared validator has
 * its own unit tests there, but `packages/contracts` is not in CI's test filter,
 * so this is what proves the exact code path an API request takes.
 */

const SIZE_CONSTRAINTS = {
  maxWidth: 3840,
  maxHeight: 3840,
  widthMultipleOf: 16,
  heightMultipleOf: 16,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxAspectRatio: 3,
}

function preset(value: string) {
  const [width, height] = value.split('x').map(Number)
  return Number.isFinite(width)
    ? { value, label: value, width, height }
    : { value, label: value }
}

const MODERN_QUALITY = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
const LEGACY_QUALITY = ['auto', 'low', 'medium', 'high']

function capabilitiesFor(qualities: string[]): ModelCapabilities {
  return {
    modes: ['text_to_image', 'image_to_image'],
    parameters: [
      {
        type: 'image-size',
        name: 'size',
        label: '尺寸',
        presets: ['auto', '1024x1024', '1536x1024', '3840x2160'].map(preset),
        allowCustom: true,
        constraints: SIZE_CONSTRAINTS,
        defaultValue: 'auto',
      },
      { type: 'enum', name: 'quality', label: '质量', options: qualities, defaultValue: 'auto' },
      { type: 'enum', name: 'background', options: ['auto', 'opaque', 'transparent'], defaultValue: 'auto' },
      { type: 'enum', name: 'output_format', options: ['png', 'jpeg', 'webp'], defaultValue: 'png' },
      {
        type: 'integer',
        name: 'output_compression',
        min: 0,
        max: 100,
        defaultValue: 100,
        dependsOn: { parameter: 'output_format', values: ['jpeg', 'webp'] },
      },
      { type: 'integer', name: 'count', min: 1, max: 4, defaultValue: 1 },
    ],
    inputSlots: [],
    maxCount: 4,
    supportedMediaKinds: ['image'],
    crossFieldConstraints: [
      {
        type: 'forbidden',
        parameter: 'background',
        whenValueEquals: 'transparent',
        targetParameter: 'output_format',
        targetValues: ['jpeg'],
        message: 'background=transparent 需要 alpha 通道，output_format 只能是 png 或 webp',
      },
    ],
    declaredBy: 'plugin-manifest',
  }
}

const MODERN = capabilitiesFor(MODERN_QUALITY)
const LEGACY = capabilitiesFor(LEGACY_QUALITY)

function submit(capabilities: ModelCapabilities, parameters: Record<string, unknown>) {
  return validateGenerationRequest(capabilities, {
    modelId: 'model-1',
    prompt: 'a lighthouse at dusk',
    parameters: parameters as Record<string, JsonValue>,
    idempotencyKey: 'k-1',
  })
}

function rejected(result: ReturnType<typeof submit>) {
  assert.equal(result.valid, false, 'expected rejection')
  if (result.valid) throw new Error('unreachable')
  return result
}

test('a legal custom size is normalised through unchanged', () => {
  const result = submit(MODERN, { size: '1536x864', quality: 'high' })
  assert.equal(result.valid, true, result.valid ? '' : result.errorMessage)
  if (result.valid) assert.equal(result.value.parameters.size, '1536x864')
})

test('a width off the declared grid is refused before the vendor sees it', () => {
  const failure = rejected(submit(MODERN, { size: '1537x864' }))
  assert.equal(failure.errorCode, 'MEDIA_PARAMETER_CONSTRAINT_FAILED')
  assert.match(failure.errorMessage, /宽度必须是 16 的整数倍/)
  assert.deepEqual(failure.errors[0].details?.parameter, 'size')
  assert.deepEqual(failure.errors[0].details?.constraint, 'widthMultipleOf')
})

test('aspect ratio and pixel band are enforced independently of the edge caps', () => {
  // 3840x1024 respects both per-edge caps; only the ratio catches it.
  const ratio = rejected(submit(MODERN, { size: '3840x1024' }))
  assert.deepEqual(ratio.errors[0].details?.constraint, 'maxAspectRatio')

  // 3840x3840 respects every edge cap and the ratio; only total pixels catch it.
  const pixels = rejected(submit(MODERN, { size: '3840x3840' }))
  assert.deepEqual(pixels.errors[0].details?.constraint, 'maxPixels')

  const floor = rejected(submit(MODERN, { size: '640x640' }))
  assert.deepEqual(floor.errors[0].details?.constraint, 'minPixels')
})

test('a quality the newer model offers is refused by the older one', () => {
  // The model-switch requirement, checked at the boundary rather than in the UI:
  // a `max` picked on a 2.5 model must never reach a model without that rung.
  assert.equal(submit(MODERN, { quality: 'max' }).valid, true)
  assert.equal(submit(MODERN, { quality: 'xhigh' }).valid, true)
  for (const quality of ['max', 'xhigh']) {
    const failure = rejected(submit(LEGACY, { quality }))
    assert.equal(failure.errorCode, 'UNSUPPORTED_MEDIA_PARAMETER')
    assert.deepEqual(failure.errors[0].details?.parameter, 'quality')
    assert.deepEqual(failure.errors[0].details?.value, quality)
  }
})

test('a transparent background may not be combined with jpeg', () => {
  const failure = rejected(submit(MODERN, { background: 'transparent', output_format: 'jpeg' }))
  assert.equal(failure.errorCode, 'MEDIA_PARAMETER_CONSTRAINT_FAILED')
  assert.match(failure.errorMessage, /png 或 webp/)

  for (const output_format of ['png', 'webp']) {
    const ok = submit(MODERN, { background: 'transparent', output_format })
    assert.equal(ok.valid, true, `${output_format} should be legal: ${ok.valid ? '' : ok.errorMessage}`)
  }
  // Opacity is not constrained, so jpeg stays available without transparency.
  assert.equal(submit(MODERN, { background: 'opaque', output_format: 'jpeg' }).valid, true)
})

test('a dependent parameter is not sent when its controller excludes it', () => {
  // Suppressed rather than rejected: a value nobody can see is dropped instead
  // of failing the whole request, so switching format back to png cannot strand
  // the user on an error they did not cause.
  const png = submit(MODERN, { output_format: 'png', output_compression: 80 })
  assert.equal(png.valid, true)
  if (png.valid) {
    assert.equal('output_compression' in png.value.parameters, false, 'compression must not be sent for png')
    assert.equal(png.value.parameters.output_format, 'png')
  }
  const jpeg = submit(MODERN, { output_format: 'jpeg', output_compression: 80 })
  assert.equal(jpeg.valid, true)
  if (jpeg.valid) assert.equal(jpeg.value.parameters.output_compression, 80)
})

test('absent parameters resolve to the defaults the model declares', () => {
  // No hardcoded console default survives: the value on the wire is the
  // descriptor's own `defaultValue`, so changing it needs no frontend edit.
  const result = submit(MODERN, {})
  assert.equal(result.valid, true)
  if (result.valid) {
    assert.deepEqual(result.value.parameters, {
      size: 'auto',
      quality: 'auto',
      background: 'auto',
      output_format: 'png',
      count: 1,
    })
  }
})

test('an undeclared parameter is still refused, with the offending key named', () => {
  const failure = rejected(submit(MODERN, { size: '1024x1024', steps: 30 }))
  assert.equal(failure.errorCode, 'UNKNOWN_PARAMETER')
  assert.match(failure.errorMessage, /steps/)
})

test('an out-of-range count is refused by the declared integer bounds', () => {
  assert.equal(submit(MODERN, { count: 4 }).valid, true)
  assert.equal(rejected(submit(MODERN, { count: 5 })).errorCode, 'PARAMETER_OUT_OF_RANGE')
  assert.equal(rejected(submit(MODERN, { count: 0 })).errorCode, 'PARAMETER_OUT_OF_RANGE')
})

test('a wrong JSON type for a size is refused rather than coerced', () => {
  const failure = rejected(submit(MODERN, { size: 1024 }))
  assert.equal(failure.errorCode, 'INVALID_PARAMETER_TYPE')
})

test('an unknown descriptor type fails loudly instead of dropping the parameter', () => {
  // The silent-drop hazard: an unhandled `type` must never fall through without
  // a verdict, because a parameter that vanishes here reaches the vendor unset.
  const forged = JSON.parse(JSON.stringify(MODERN)) as { parameters: unknown[] }
  forged.parameters.push({ type: 'aspect-ratio-v2', name: 'ratio', options: ['16:9'] })
  const failure = rejected(submit(forged as unknown as ModelCapabilities, { ratio: '16:9' }))
  assert.ok(
    failure.errorMessage.includes('aspect-ratio-v2') || failure.errorMessage.includes('ratio'),
    `expected the unknown type to be named, got: ${failure.errorMessage}`,
  )
})
