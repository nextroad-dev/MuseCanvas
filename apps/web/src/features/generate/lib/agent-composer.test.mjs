import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildComposerContext,
  buildComposerUserRequest,
  createComposerDraft,
  createComposerSender,
  isAbortError,
  newComposerMessageId,
} from './agent-composer.ts'
import { createAgentSubmitLock } from './agent-stream.ts'

const ASSET_ID = '44444444-4444-4444-4444-444444444444'
const UPLOAD_ID = '22222222-2222-2222-2222-222222222222'

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function abortedError() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** The composer always runs on the shared synchronous submit lock. */
function makeSender(handlers) {
  return createComposerSender(handlers, createAgentSubmitLock())
}

test('a draft becomes a confirmation-gated, agent-managed user request with context', () => {
  const draft = createComposerDraft({
    text: '  draw a cat  ',
    intent: 'generate',
    modelId: '11111111-1111-1111-1111-111111111111',
    parameters: { quality: 'high', count: 2 },
    inputs: [{ uploadId: UPLOAD_ID, role: 'reference_image', position: 0 }],
  })
  const request = buildComposerUserRequest({
    messageId: '33333333-3333-3333-3333-333333333333',
    baseRevision: 4,
    draft,
  })

  assert.equal(request.kind, 'user')
  assert.equal(request.messageId, '33333333-3333-3333-3333-333333333333')
  assert.equal(request.text, 'draw a cat')
  assert.equal(request.baseRevision, 4)
  assert.equal(request.requireConfirmation, true)
  assert.equal(request.sceneCommitMode, 'agent-managed')
  assert.deepEqual(request.context, {
    intent: 'generate',
    modelId: '11111111-1111-1111-1111-111111111111',
    parameters: { quality: 'high', count: 2 },
    inputs: [{ uploadId: UPLOAD_ID, role: 'reference_image', position: 0 }],
  })
})

test('an edit source forces the edit intent and survives into the request', () => {
  const draft = createComposerDraft({
    text: 'recolor',
    intent: 'generate',
    editSource: { assetId: ASSET_ID, selection: { x: 1, y: 2, width: 30, height: 40 } },
  })
  const context = buildComposerContext(draft)
  assert.equal(context.intent, 'edit')
  assert.deepEqual(context.editSource, { assetId: ASSET_ID, selection: { x: 1, y: 2, width: 30, height: 40 } })
})

test('an empty draft still carries an explicit generate intent, with no empty bag', () => {
  const draft = createComposerDraft()
  assert.deepEqual(buildComposerContext(draft), { intent: 'generate' })
  const request = buildComposerUserRequest({ messageId: 'm', baseRevision: 1, draft })
  assert.deepEqual(request.context, { intent: 'generate' })
  // No model, parameters, inputs or edit source leak in as empty/undefined entries.
  assert.deepEqual(Object.keys(request.context), ['intent'])
})

test('an edit source without an identifier (assetId or nodeId) is dropped, not sent empty', () => {
  const draft = createComposerDraft({
    intent: 'edit',
    editSource: { selection: { x: 0, y: 0, width: 1, height: 1 } },
  })
  assert.equal(buildComposerContext(draft).editSource, undefined)
})

test('a node-only edit source is accepted', () => {
  const draft = createComposerDraft({
    editSource: { nodeId: '55555555-5555-5555-5555-555555555555', selection: { x: 5, y: 6, width: 7, height: 8 } },
  })
  assert.deepEqual(buildComposerContext(draft).editSource, {
    nodeId: '55555555-5555-5555-5555-555555555555',
    selection: { x: 5, y: 6, width: 7, height: 8 },
  })
})

test('the context bag is a plain copy, so mutating the draft afterwards cannot change the sent request', () => {
  const draft = createComposerDraft({ parameters: { quality: 'high' }, inputs: [{ assetId: ASSET_ID, role: 'reference_image', position: 0 }] })
  const request = buildComposerUserRequest({ messageId: 'm', baseRevision: 1, draft })
  draft.parameters.quality = 'low'
  draft.inputs[0].position = 3
  assert.equal(request.context.parameters.quality, 'high')
  assert.equal(request.context.inputs[0].position, 0)
})

test('the composer send path rejects a duplicate synchronous activation and sends exactly once', async () => {
  let streamCalls = 0
  let settle
  const settled = new Promise((resolve) => { settle = resolve })
  const sender = makeSender({
    stream: async function* () {
      streamCalls += 1
      yield { type: 'text_delta', turnId: 't1', eventId: 'e1', delta: 'ok' }
    },
    onEvent: () => {},
    onSettled: (outcome) => settle(outcome),
  })
  const draft = createComposerDraft({ text: 'hi' })

  const first = sender.sendUserMessage({ canvasId: 'c1', baseRevision: 1, draft })
  // Second activation in the same tick must be rejected before React re-renders.
  const second = sender.sendUserMessage({ canvasId: 'c1', baseRevision: 1, draft })

  assert.equal(first, true)
  assert.equal(second, false)
  assert.equal(sender.sending, true)

  const outcome = await settled
  assert.deepEqual(outcome, { status: 'done' })
  assert.equal(streamCalls, 1)
  assert.equal(sender.sending, false)

  // The lock is released, so a deliberate resubmit works.
  assert.equal(sender.sendUserMessage({ canvasId: 'c1', baseRevision: 1, draft }), true)
  await tick()
  assert.equal(streamCalls, 2)
})

test('the submit lock is shared between a user turn and a job_event continuation', () => {
  const sender = makeSender({
    stream: async function* (_canvasId, _request, signal) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    },
    onEvent: () => {},
  })
  assert.equal(sender.sendUserMessage({ canvasId: 'c1', baseRevision: 1, draft: createComposerDraft({ text: 'hi' }) }), true)
  assert.equal(sender.sendJobEvent({ canvasId: 'c1', baseRevision: 1, jobId: 'job-1' }), false)
  sender.stop()
})

test('an empty draft and a missing canvas are refused without touching the stream', () => {
  let streamCalls = 0
  const sender = makeSender({
    stream: async function* () {
      streamCalls += 1
      yield { type: 'text_delta', turnId: 't1', eventId: 'e1', delta: 'x' }
    },
    onEvent: () => {},
  })
  assert.equal(sender.sendUserMessage({ canvasId: 'c1', baseRevision: 1, draft: createComposerDraft({ text: '   ' }) }), false)
  assert.equal(sender.sendUserMessage({ canvasId: '', baseRevision: 1, draft: createComposerDraft({ text: 'hi' }) }), false)
  assert.equal(streamCalls, 0)
})

test('stop aborts the active Agent turn and settles as aborted, never as an error', async () => {
  let outcome
  const sender = makeSender({
    stream: async function* (_canvasId, _request, signal) {
      if (!signal.aborted) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      }
      throw abortedError()
    },
    onEvent: () => {},
    onSettled: (result) => { outcome = result },
  })
  sender.sendUserMessage({ canvasId: 'c1', baseRevision: 1, draft: createComposerDraft({ text: 'hi' }) })
  sender.stop()
  await tick()
  assert.deepEqual(outcome, { status: 'aborted' })
  assert.equal(sender.sending, false)
})

test('a stream error settles as an error, distinct from an abort', async () => {
  let outcome
  const sender = makeSender({
    stream: async function* () {
      throw new Error('boom')
    },
    onEvent: () => {},
    onSettled: (result) => { outcome = result },
  })
  sender.sendUserMessage({ canvasId: 'c1', baseRevision: 1, draft: createComposerDraft({ text: 'hi' }) })
  await tick()
  assert.equal(outcome.status, 'error')
  assert.equal(outcome.error.message, 'boom')
  assert.equal(isAbortError(outcome.error), false)
})

test('newComposerMessageId returns a uuid when crypto.randomUUID is available', () => {
  const id = newComposerMessageId()
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
})
