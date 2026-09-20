import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { ImageSizeParameterDescriptor, JsonValue, ModelCapabilities, ParameterDescriptor } from '@musecanvas/contracts'
import {
  GenerationErrorCode,
  evaluateCrossFieldConstraints,
  validateModelCapabilities,
  validateParameterValue,
} from '@musecanvas/contracts'
import type { MediaModelDeclaration, MediaRequest } from '../../core/types'

import { openAiImagePlugin } from './index'
import {
  OPENAI_IMAGE_MODELS,
  OPENAI_IMAGE_SUPPORTED_MODELS,
  openAiImageModelDeclaration,
} from './models'

/**
 * These cases pin the *contract*, not the HTTP shape: every row here is a claim
 * the console renders, the API enforces and this plugin forwards, so a change to
 * the matrix that does not reflect a real vendor change should fail here rather
 * than in production.
 */

function capabilities(modelId: string): ModelCapabilities {
  const model: MediaModelDeclaration | undefined = openAiImageModelDeclaration(modelId)
  assert.ok(model?.capabilities, `${modelId} must declare capabilities`)
  return model.capabilities
}

function descriptor(modelId: string, name: string): ParameterDescriptor {
  const found = capabilities(modelId).parameters.find(entry => entry.name === name)
  assert.ok(found, `${modelId} must declare '${name}'`)
  return found
}

function sizeDescriptor(modelId: string): ImageSizeParameterDescriptor {
  const found = descriptor(modelId, 'size')
  assert.equal(found.type, 'image-size', `${modelId}'s size parameter must be image-size`)
  return found as ImageSizeParameterDescriptor
}

function optionValues(modelId: string, name: string): string[] {
  const found = descriptor(modelId, name)
  assert.equal(found.type, 'enum', `${modelId}'s '${name}' must be an enum`)
  return (found as { options: Array<string | { value: string }> }).options
    .map(option => (typeof option === 'string' ? option : option.value))
}

function sizeIssues(modelId: string, size: string) {
  return validateParameterValue(sizeDescriptor(modelId), size)
}

/**
 * Run the same two passes the API and the browser run: each value against its
 * own descriptor, then the combination rules over what was actually sent.
 */
function evaluateSent(modelId: string, sent: Record<string, string>) {
  const declared = capabilities(modelId)
  const issues: Array<{ code: string; message: string; constraint?: string }> = []
  for (const entry of declared.parameters) {
    if (sent[entry.name] !== undefined) issues.push(...validateParameterValue(entry, sent[entry.name]))
  }
  issues.push(...evaluateCrossFieldConstraints(declared.crossFieldConstraints, sent as Record<string, JsonValue>))
  return issues
}

test('every declared model passes the shared contract validator', () => {
  for (const model of OPENAI_IMAGE_MODELS) {
    assert.ok(model.capabilities, `${model.id} must declare capabilities`)
    const result = validateModelCapabilities({
      ...model.capabilities,
      ...(model.defaults ? { defaults: model.defaults } : {}),
    })
    assert.ok(
      result.ok,
      `${model.id}: ${result.findings.map(finding => `${finding.rule}: ${finding.message}`).join('; ')}`,
    )
  }
})

test('the 2.5 variants share one parameter contract instead of duplicating it', () => {
  const sunburst = openAiImageModelDeclaration('gpt-image-2.5-sunburst')
  const flare = openAiImageModelDeclaration('gpt-image-2.5-flare')
  assert.deepEqual(sunburst?.capabilities, flare?.capabilities)
  // Identical content is not enough: the spec asks for a *reused* schema, and a
  // shared reference is what makes the two drift apart impossible.
  assert.equal(
    sunburst?.capabilities?.parameters,
    flare?.capabilities?.parameters,
    'the two models must reference the same descriptor array',
  )
})

test('the extended quality ladder is offered only to the 2.5 models', () => {
  const extended = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
  const base = ['auto', 'low', 'medium', 'high']
  assert.deepEqual(optionValues('gpt-image-2.5-sunburst', 'quality'), extended)
  assert.deepEqual(optionValues('gpt-image-2.5-flare', 'quality'), extended)
  assert.deepEqual(optionValues('gpt-image-2', 'quality'), base)
  assert.deepEqual(optionValues('gpt-image-1.5', 'quality'), base)

  for (const modelId of ['gpt-image-2', 'gpt-image-1.5']) {
    for (const quality of ['xhigh', 'max']) {
      const issues = validateParameterValue(descriptor(modelId, 'quality'), quality)
      assert.equal(
        issues[0]?.code,
        GenerationErrorCode.UNSUPPORTED_MEDIA_PARAMETER,
        `${modelId} must reject quality=${quality}`,
      )
    }
  }
  // And the 2.5 models must accept exactly those two.
  for (const quality of ['xhigh', 'max']) {
    assert.deepEqual(validateParameterValue(descriptor('gpt-image-2.5-sunburst', 'quality'), quality), [])
  }
})

test('dall-e-3 keeps its own quality vocabulary instead of being normalised', () => {
  // Tempting to "unify" this with the GPT ladder, but the vendor accepts neither
  // `auto` nor `low` here, and rewriting the values would break saved configs.
  assert.deepEqual(optionValues('dall-e-3', 'quality'), ['standard', 'hd'])
  assert.deepEqual(validateParameterValue(descriptor('dall-e-3', 'quality'), 'standard'), [])
  assert.equal(
    validateParameterValue(descriptor('dall-e-3', 'quality'), 'auto')[0]?.code,
    GenerationErrorCode.UNSUPPORTED_MEDIA_PARAMETER,
  )
})

test('input_fidelity is declared only on the model that documents it', () => {
  assert.deepEqual(optionValues('gpt-image-1.5', 'input_fidelity'), ['low', 'high'])
  for (const modelId of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'dall-e-3']) {
    const declared = openAiImageModelDeclaration(modelId)?.capabilities?.parameters
      .some(entry => entry.name === 'input_fidelity')
    assert.equal(declared, false, `${modelId} must not expose input_fidelity`)
  }
})

test('custom sizes are judged by the declared geometry band, not by a list', () => {
  for (const size of ['1024x1024', '1536x864', '1280x720', '1792x1024', '3840x2160', '2160x3840', '2048x1360']) {
    assert.deepEqual(sizeIssues('gpt-image-2.5-sunburst', size), [], `${size} must be accepted`)
  }
  const illegal: Array<[string, string]> = [
    ['1537x864', 'widthMultipleOf'], // an odd width is off the 16-pixel grid
    ['1536x865', 'heightMultipleOf'],
    ['3840x1024', 'maxAspectRatio'], // 3.75:1
    ['3856x2160', 'maxWidth'],
    ['1024x1024x', 'format'],
    ['640x640', 'minPixels'], // 409,600 px, below the band floor
  ]
  for (const [size, constraint] of illegal) {
    const issues = sizeIssues('gpt-image-2.5-sunburst', size)
    assert.ok(issues.length > 0, `${size} must be rejected`)
    assert.equal(
      issues[0]?.constraint,
      constraint,
      `${size} failed for the wrong reason: ${issues[0]?.message}`,
    )
  }
  assert.deepEqual(sizeIssues('gpt-image-2.5-sunburst', 'auto'), [])
})

test('total-pixel limits reject a size that is individually in range', () => {
  // 3840x3840 keeps both edges under the per-edge cap and the ratio at 1:1, so
  // only the pixel ceiling can catch it. That is precisely the case a naive
  // `width <= max && height <= max` check silently accepts.
  const issues = sizeIssues('gpt-image-2.5-sunburst', '3840x3840')
  assert.ok(issues.length > 0, '3840x3840 must be rejected')
  assert.equal(issues[0]?.constraint, 'maxPixels')
})

test('a fixed-size model rejects anything outside its enumerated list', () => {
  const legacy = sizeDescriptor('gpt-image-1.5')
  assert.equal(legacy.allowCustom, undefined, 'gpt-image-1.5 must not allow custom sizes')
  assert.deepEqual(legacy.presets.map(preset => preset.value), ['auto', '1024x1024', '1024x1536', '1536x1024'])
  assert.equal(
    sizeIssues('gpt-image-1.5', '2048x2048')[0]?.code,
    GenerationErrorCode.UNSUPPORTED_MEDIA_PARAMETER,
  )
})

test('high-resolution presets are flagged experimental but stay selectable', () => {
  const presets = sizeDescriptor('gpt-image-2.5-sunburst').presets
  const above = presets.filter(preset => (preset.width ?? 0) * (preset.height ?? 0) > 2560 * 1440)
  assert.ok(above.length > 0, 'the preset list must include above-threshold sizes')
  for (const preset of above) {
    assert.equal(preset.experimental, true, `${preset.value} must be flagged experimental`)
    assert.ok(preset.description, `${preset.value} must explain what that means`)
    // Flagged, never forbidden.
    assert.deepEqual(sizeIssues('gpt-image-2.5-sunburst', preset.value), [])
  }
  for (const preset of presets.filter(p => (p.width ?? 0) * (p.height ?? 0) <= 2560 * 1440)) {
    assert.notEqual(preset.experimental, true, `${preset.value} must not be flagged`)
  }
})

test('transparent background and jpeg are illegal; png and webp are not', () => {
  assert.ok(
    (capabilities('gpt-image-2.5-sunburst').crossFieldConstraints ?? []).length > 0,
    'the alpha/format coupling must be declarative, not imperative',
  )
  for (const format of ['jpeg']) {
    const issues = evaluateSent('gpt-image-2.5-sunburst', { background: 'transparent', output_format: format })
    assert.equal(
      issues[0]?.code,
      GenerationErrorCode.MEDIA_PARAMETER_CONSTRAINT_FAILED,
      `transparent + ${format} must be rejected`,
    )
  }
  for (const format of ['png', 'webp']) {
    assert.deepEqual(
      evaluateSent('gpt-image-2.5-sunburst', { background: 'transparent', output_format: format }),
      [],
      `transparent + ${format} must be accepted`,
    )
  }
  // With no explicit transparency choice, jpeg remains perfectly legal.
  assert.deepEqual(evaluateSent('gpt-image-2.5-sunburst', { output_format: 'jpeg' }), [])
})

test('output_compression is offered only for the lossy formats', () => {
  const compression = descriptor('gpt-image-2.5-sunburst', 'output_compression')
  assert.deepEqual(compression.dependsOn, { parameter: 'output_format', values: ['jpeg', 'webp'] })
  assert.equal(compression.ui?.advanced, true)
  assert.deepEqual(validateParameterValue(compression, 100), [])
  assert.equal(
    validateParameterValue(compression, 101)[0]?.code,
    GenerationErrorCode.PARAMETER_OUT_OF_RANGE,
  )
})

test('a deprecated model never occupies the recommended position', () => {
  assert.notEqual(OPENAI_IMAGE_MODELS[0].deprecated, true, 'the first model must not be deprecated')
  const deprecated = OPENAI_IMAGE_MODELS.filter(model => model.deprecated)
  assert.ok(deprecated.length > 0, 'dall-e-3 is expected to be marked deprecated')
  for (const model of deprecated) {
    assert.ok(model.deprecationNote, `${model.id} needs a note explaining the marking`)
    assert.equal(
      OPENAI_IMAGE_MODELS.indexOf(model),
      OPENAI_IMAGE_MODELS.length - 1,
      `${model.id} must sort last`,
    )
  }
})

test('mainline chat models never appear as image models', () => {
  // The direct image API and the Responses API's image tool are different
  // kernels; a `gpt-5*`/`gpt-6*` id here would advertise a model that cannot
  // actually serve /v1/images/generations.
  for (const id of OPENAI_IMAGE_SUPPORTED_MODELS) {
    assert.match(id, /^(gpt-image-|dall-e-)/, `${id} is not an image model id`)
  }
})

test('the adapter forwards only what the selected model declares', () => {
  const buildFields = (openAiImagePlugin as unknown as {
    buildRequestFields(request: MediaRequest): Record<string, string | number>
  }).buildRequestFields.bind(openAiImagePlugin)
  const body = (modelId: string, parameters: Record<string, JsonValue>) =>
    buildFields({
      modality: 'image',
      vendorModelId: modelId,
      prompt: 'a contract test',
      size: '1024x1024',
      count: 1,
      parameters,
    })

  // Declared and chosen -> on the wire.
  assert.equal(body('gpt-image-2.5-sunburst', { output_format: 'jpeg', output_compression: 80 }).output_compression, 80)
  assert.equal(body('gpt-image-2.5-sunburst', { background: 'transparent', output_format: 'webp' }).background, 'transparent')
  // Declared, not chosen -> the default the contract itself states.
  assert.equal(body('gpt-image-2.5-sunburst', {}).output_format, 'png')
  // Suppressed by dependency: a stale compression must never ride along on png.
  assert.equal('output_compression' in body('gpt-image-2.5-sunburst', { output_format: 'png', output_compression: 80 }), false)
  // Not declared for this model -> never sent, however confidently the client asks.
  assert.equal('input_fidelity' in body('gpt-image-2', { input_fidelity: 'low' }), false)
  assert.equal(body('gpt-image-1.5', { input_fidelity: 'low' }).input_fidelity, 'low')
  // dall-e-3 predates output_format entirely.
  const legacy = body('dall-e-3', { output_format: 'webp' })
  assert.equal(legacy.response_format, 'b64_json')
  assert.equal('output_format' in legacy, false)
  assert.equal(legacy.n, 1)
})

test('a chat model id is refused, with the image roster in the message', () => {
  // `validateRequest` is synchronous, so this asserts on the thrown diagnostic
  // rather than through `assert.rejects`.
  let thrown: unknown
  try {
    openAiImagePlugin.validateRequest({
      modality: 'image',
      vendorModelId: 'gpt-5.5',
      prompt: 'should never reach the image endpoint',
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, 'a mainline chat model must not be accepted by the image plugin')
  const detail = (thrown as { diagnostic?: { code?: string; detail?: string } }).diagnostic
  assert.equal(detail?.code, 'INVALID_REQUEST')
  assert.match(detail?.detail ?? '', /supported models:.*gpt-image-2\.5-sunburst/)
  // The roster the message offers must contain image models only — the rejected
  // id appears earlier in the sentence, so check the list after the colon.
  const roster = (detail?.detail ?? '').split('supported models:')[1] ?? ''
  assert.doesNotMatch(roster, /gpt-5/, 'the roster must list image models only')
})
