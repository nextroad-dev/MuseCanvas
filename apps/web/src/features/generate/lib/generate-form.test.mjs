import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completionSignature, imageModelBlockReason, promptIssue, PROMPT_LIMIT } from './generate-form.ts'

const model = { enabled: true, deprecated: false, modelKind: 'image', modes: ['text_to_image'], inputSlots: [], declaredBy: 'plugin' }

test('text-to-image availability fails closed for unsupported and required-input models', () => {
  assert.equal(imageModelBlockReason(model), null)
  for (const candidate of [null, { ...model, enabled: false }, { ...model, deprecated: true }, { ...model, modes: ['image_to_image'] }, { ...model, modelKind: 'video' }, { ...model, declaredBy: 'undeclared' }, { ...model, inputSlots: [{ required: true, minCount: 0 }] }, { ...model, inputSlots: [{ required: false, minCount: 1 }] }]) {
    assert.equal(typeof imageModelBlockReason(candidate), 'string')
  }
  assert.equal(imageModelBlockReason({ ...model, inputSlots: [{ required: false, minCount: 0 }] }), null)
})

test('prompt validation rejects whitespace and excessive input without modifying drafts', () => {
  assert.ok(promptIssue(' \n\t '))
  assert.equal(promptIssue(' 一只陶瓷杯 '), null)
  assert.equal(promptIssue('a'.repeat(PROMPT_LIMIT)), null)
  assert.ok(promptIssue('a'.repeat(PROMPT_LIMIT + 1)))
})

test('library completion identity ignores progress but detects partial assets and finalization', () => {
  const job = { id: 'job-1', status: 'running', outputs: [] }
  assert.equal(completionSignature([job]), '')
  const imported = { ...job, outputs: [{ assetId: 'asset-1' }] }
  const signature = completionSignature([imported])
  assert.ok(signature)
  assert.equal(completionSignature([{ ...imported, progress: 99 }]), signature)
  assert.notEqual(completionSignature([{ ...imported, status: 'succeeded' }]), signature)
  assert.notEqual(completionSignature([{ ...imported, outputs: [...imported.outputs, { assetId: 'asset-2' }] }]), signature)
  assert.equal(completionSignature([imported, { ...imported, id: 'job-2' }]), completionSignature([{ ...imported, id: 'job-2' }, imported]))
})
