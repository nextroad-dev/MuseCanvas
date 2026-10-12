import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { CanvasErrorCode as C, type JsonObject, type ModelCapabilities } from '@musecanvas/contracts'
import { validateGenerationRequest, serializeCanonicalJson } from '@musecanvas/domain'
import { AgentError } from './config'
import { normalizeSubmissionRequest } from './normalization'

const capabilities: ModelCapabilities = {
  modes: ['text_to_image'], supportedMediaKinds: ['image'], declaredBy: 'plugin-manifest', maxCount: 1, inputSlots: [],
  parameters: [
    { name: 'output_format', type: 'enum', options: ['jpeg', 'png'], defaultValue: 'jpeg' },
    { name: 'output_compression', type: 'integer', min: 0, max: 100, defaultValue: 100, dependsOn: { parameter: 'output_format', values: ['jpeg'] } },
  ],
}
const request = (parameters: JsonObject = {}) => ({ modelId: randomUUID(), prompt: '  cat  ', parameters, inputs: [] })
function normalize(caps = capabilities, parameters: JsonObject = {}, defaults: JsonObject = {}) {
  return normalizeSubmissionRequest({ capabilities: caps, request: request(parameters), defaults, kind: 'image', signal: new AbortController().signal, deadline: Date.now() + 120000 })
}

test('real domain dependent defaults change on pass two; frozen submission is a validated fixed point', () => {
  const raw = request()
  const first = validateGenerationRequest(capabilities, raw)
  assert.equal(first.valid, true); if (!first.valid) assert.fail('first validation')
  assert.deepEqual(first.value.parameters, { output_format: 'jpeg' })
  const second = validateGenerationRequest(capabilities, { ...raw, prompt: first.value.prompt, parameters: first.value.parameters, inputs: first.value.inputs })
  assert.equal(second.valid, true); if (!second.valid) assert.fail('second validation')
  assert.deepEqual(second.value.parameters, { output_format: 'jpeg', output_compression: 100 })
  const frozen = normalizeSubmissionRequest({ capabilities, request: raw, defaults: {}, kind: 'image', signal: new AbortController().signal, deadline: Date.now() + 120000 })
  const submission = validateGenerationRequest(capabilities, { ...raw, prompt: frozen.prompt, parameters: frozen.parameters, inputs: frozen.inputs })
  assert.equal(submission.valid, true); if (!submission.valid) assert.fail('submission validation')
  assert.equal(serializeCanonicalJson(submission.value), serializeCanonicalJson(frozen))
  assert.equal(frozen.prompt, 'cat')
})

test('dependency chains converge, installed defaults are retained, and hidden parameters stay absent', () => {
  const chain: ModelCapabilities = { ...capabilities, parameters: [...capabilities.parameters,
    { name: 'compression_label', type: 'enum', options: ['lossless', 'lossy'], defaultValue: 'lossless', dependsOn: { parameter: 'output_compression', values: [100] } }] }
  assert.deepEqual(normalize(chain).parameters, { output_format: 'jpeg', output_compression: 100, compression_label: 'lossless' })
  assert.deepEqual(normalize(capabilities, {}, { output_compression: 82 }).parameters, { output_format: 'jpeg', output_compression: 82 })
  assert.deepEqual(normalize(capabilities, { output_compression: 50 }, { output_format: 'png' }).parameters, { output_format: 'png' })
})

test('real domain visibility cycle fails closed instead of freezing a non-stable request', () => {
  const cyclic: ModelCapabilities = { ...capabilities, parameters: [
    { name: 'a', type: 'boolean', defaultValue: true, dependsOn: { parameter: 'b', values: [false] } },
    { name: 'b', type: 'boolean', defaultValue: false, dependsOn: { parameter: 'a', values: [true] } },
  ] }
  const first = validateGenerationRequest(cyclic, request({ b: false }))
  assert.equal(first.valid, true); if (!first.valid) assert.fail('cycle first')
  assert.deepEqual(first.value.parameters, { a: true })
  assert.throws(() => normalize(cyclic, { b: false }), (error: AgentError) => error.code === C.INVALID_INPUT)
})

test('normalization work is capped, without rejecting large already-stable descriptor sets', () => {
  const chain: ModelCapabilities = { ...capabilities, parameters: Array.from({ length: 70 }, (_, index) => ({ name: `p${index}`, type: 'boolean' as const, defaultValue: true,
    ...(index ? { dependsOn: { parameter: `p${index - 1}`, values: [true] } } : {}) })) }
  assert.throws(() => normalize(chain), (error: AgentError) => error.code === C.CANVAS_AGENT_BUDGET_EXCEEDED)
  const ready = Object.fromEntries(chain.parameters.map(parameter => [parameter.name, true]))
  assert.deepEqual(normalize(chain, ready).parameters, ready)
})

test('signal, deadline and invalid revalidation reject before any stable result is returned', () => {
  const controller = new AbortController(); controller.abort()
  assert.throws(() => normalizeSubmissionRequest({ capabilities, request: request(), defaults: {}, kind: 'image', signal: controller.signal, deadline: Date.now() + 1000 }), (error: AgentError) => error.code === C.CANVAS_AGENT_CANCELED)
  assert.throws(() => normalizeSubmissionRequest({ capabilities, request: request(), defaults: {}, kind: 'image', signal: new AbortController().signal, deadline: Date.now() - 1 }), (error: AgentError) => error.code === C.CANVAS_AGENT_TIMEOUT)
  assert.throws(() => normalize(capabilities, {}, { output_compression: 200 }), (error: AgentError) => error.code === C.INVALID_INPUT)
})
