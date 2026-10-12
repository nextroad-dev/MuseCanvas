import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  CanvasErrorCode as C,
  type CanvasOp,
  type JsonObject,
  type ModelCapabilities,
} from '../../packages/contracts/src/index'
import {
  canvasAgentGenerationJobMatches,
  canvasAgentGenerationRequest,
  canvasAgentPendingIdentity,
  canvasAgentRequestDigest,
  type CanvasAgentPendingJob,
} from '../../packages/database/src/repositories/canvas-agent'
import { normalizeSubmissionRequest } from '../../apps/api/src/modules/canvases/agent/normalization'

test('canvas agent v2 generation request handles multiple modes and inputs', () => {
  const modelId = randomUUID()
  const imageCaps: ModelCapabilities = {
    modes: ['text_to_image', 'image_to_image', 'inpaint'],
    supportedMediaKinds: ['image'],
    declaredBy: 'plugin-manifest',
    maxCount: 1,
    inputSlots: [
      { role: 'reference_image', required: false, minCount: 0, maxCount: 4, allowedMediaKinds: ['image'] },
      { role: 'mask', required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'] },
    ],
    parameters: [
      { name: 'count', type: 'integer', min: 1, max: 1, defaultValue: 1 },
    ],
  }

  // 1. text_to_image mode
  const t2i = normalizeSubmissionRequest({
    capabilities: imageCaps,
    defaults: { count: 1 },
    request: { modelId, prompt: 'cat', parameters: {}, inputs: [] },
    kind: 'image',
    signal: new AbortController().signal,
    deadline: Date.now() + 10000,
  })
  assert.equal(t2i.mode, 'text_to_image')
  assert.equal(t2i.prompt, 'cat')

  // 2. image_to_image mode with multiple reference inputs
  const i2i = normalizeSubmissionRequest({
    capabilities: imageCaps,
    defaults: { count: 1 },
    request: {
      modelId,
      prompt: 'stylized cat',
      parameters: {},
      inputs: [
        { uploadId: randomUUID(), role: 'reference_image', position: 0 },
        { assetId: randomUUID(), role: 'reference_image', position: 1 },
      ],
    },
    kind: 'image',
    signal: new AbortController().signal,
    deadline: Date.now() + 10000,
  })
  assert.equal(i2i.mode, 'image_to_image')
  assert.equal(i2i.inputs.length, 2)

  // 3. image generation with mask and reference inputs
  const inpaint = normalizeSubmissionRequest({
    capabilities: imageCaps,
    defaults: { count: 1 },
    request: {
      modelId,
      prompt: 'inpaint region',
      parameters: {},
      inputs: [
        { assetId: randomUUID(), role: 'reference_image', position: 0 },
        { uploadId: randomUUID(), role: 'mask', position: 1 },
      ],
    },
    kind: 'image',
    signal: new AbortController().signal,
    deadline: Date.now() + 10000,
  })
  assert.equal(inpaint.mode, 'inpaint')
  assert.equal(inpaint.inputs.length, 2)
})

test('v2 pending job payload matching and idempotency key invariants', () => {
  const canvasId = randomUUID()
  const toolCallId = 'call_inpaint_1'
  const ids = canvasAgentPendingIdentity(canvasId, toolCallId)

  const v2NormalizedRequest: JsonObject = {
    modelId: randomUUID(),
    prompt: 'Edit only the selected region of the image, as indicated by the mask. Replace cat with tiger',
    parameters: { size: '1024x1024', count: 1 },
    mode: 'inpaint',
    inputs: [
      { assetId: randomUUID(), role: 'reference_image', position: 0 },
      { uploadId: randomUUID(), role: 'mask', position: 1 },
    ],
  }

  const pending: CanvasAgentPendingJob = {
    id: ids.id,
    sessionId: randomUUID(),
    canvasId,
    createdBy: randomUUID(),
    turnId: randomUUID(),
    toolCallId,
    kind: 'image',
    prompt: v2NormalizedRequest.prompt as string,
    modelId: v2NormalizedRequest.modelId as string,
    parameters: v2NormalizedRequest.parameters as JsonObject,
    sourceNodeId: null,
    sourceAssetId: null,
    baseRevision: 1,
    nodeId: ids.nodeId,
    edgeId: ids.edgeId,
    idempotencyKey: ids.idempotencyKey,
    requestDigest: canvasAgentRequestDigest(v2NormalizedRequest),
    modelConfigDigest: 'a'.repeat(64),
    status: 'pending',
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    leaseToken: null,
    leaseExpiresAt: null,
    jobId: null,
    ops: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requestVersion: 2,
    normalizedRequest: v2NormalizedRequest,
    normalizedInputs: v2NormalizedRequest.inputs as any[],
  }

  // Generation request extracted from v2 pending equals normalizedRequest
  const extracted = canvasAgentGenerationRequest(pending)
  assert.deepEqual(extracted, v2NormalizedRequest)

  // Matching job matches by digest
  const matchingJob = {
    model_id: pending.modelId,
    media_kind: pending.kind,
    normalized_request: v2NormalizedRequest,
  }
  assert.equal(canvasAgentGenerationJobMatches(pending, matchingJob), true)

  // Tampered payload fails matching
  const tamperedJob = {
    model_id: pending.modelId,
    media_kind: pending.kind,
    normalized_request: { ...v2NormalizedRequest, prompt: 'tampered prompt' },
  }
  assert.equal(canvasAgentGenerationJobMatches(pending, tamperedJob), false)
})

test('submitPending idempotency: crash recovery and replay use exact persisted key and payload', async () => {
  const canvasId = randomUUID()
  const toolCallId = 'call_inpaint_submit'
  const ids = canvasAgentPendingIdentity(canvasId, toolCallId)

  const v2NormalizedRequest: JsonObject = {
    modelId: randomUUID(),
    prompt: 'Tiger in snow',
    parameters: { size: '1024x1024', count: 1 },
    mode: 'inpaint',
    inputs: [
      { assetId: randomUUID(), role: 'reference_image', position: 0 },
      { uploadId: randomUUID(), role: 'mask', position: 1 },
    ],
  }

  const pending: CanvasAgentPendingJob = {
    id: ids.id,
    sessionId: randomUUID(),
    canvasId,
    createdBy: randomUUID(),
    turnId: randomUUID(),
    toolCallId,
    kind: 'image',
    prompt: 'Tiger in snow',
    modelId: v2NormalizedRequest.modelId as string,
    parameters: v2NormalizedRequest.parameters as JsonObject,
    sourceNodeId: null,
    sourceAssetId: null,
    baseRevision: 1,
    nodeId: ids.nodeId,
    edgeId: ids.edgeId,
    idempotencyKey: ids.idempotencyKey,
    requestDigest: canvasAgentRequestDigest(v2NormalizedRequest),
    modelConfigDigest: 'b'.repeat(64),
    status: 'pending',
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    leaseToken: null,
    leaseExpiresAt: null,
    jobId: null,
    ops: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requestVersion: 2,
    normalizedRequest: v2NormalizedRequest,
    normalizedInputs: v2NormalizedRequest.inputs as any[],
  }

  let createdJobsCount = 0
  const fakeCreate = async (cmd: any) => {
    createdJobsCount++
    assert.equal(cmd.idempotencyKey, ids.idempotencyKey)
    assert.deepEqual(cmd.normalizedInputs, v2NormalizedRequest.inputs)
    assert.equal(cmd.intendedMode, 'inpaint')
    return {
      ok: true,
      json: async () => ({ success: true, data: { id: randomUUID() } }),
    } as any
  }

  // First submit: claims, calls create once, completes
  const fakeStore = {
    claimed: false,
    async claim() {
      this.claimed = true
      return { scope: { actorId: pending.createdBy, canvasId, sessionId: pending.sessionId }, pending: { ...pending, status: 'submitting' }, claimed: true }
    },
    async complete(_scope: any, _pending: any, jobId: string) {
      return { ...pending, status: 'submitted' as const, jobId }
    },
  } as any

  const { submitPending } = await import('../../apps/api/src/modules/canvases/agent/submit')
  const completed = await submitPending(
    fakeStore,
    { id: pending.createdBy, role: 'user', status: 'active', email: 'test@test.local', createdAt: '' },
    canvasId,
    { pendingId: pending.id, approve: true },
    fakeCreate,
    new AbortController().signal,
    120000,
  )

  assert.equal(completed.status, 'submitted')
  assert.equal(createdJobsCount, 1)

  // Replaying when claim is not claimed (already submitted/replay): does NOT call create again!
  const replayStore = {
    async claim() {
      return { scope: { actorId: pending.createdBy, canvasId, sessionId: pending.sessionId }, pending: completed, claimed: false }
    },
  } as any

  const replayed = await submitPending(
    replayStore,
    { id: pending.createdBy, role: 'user', status: 'active', email: 'test@test.local', createdAt: '' },
    canvasId,
    { pendingId: pending.id, approve: true },
    fakeCreate,
    new AbortController().signal,
    120000,
  )

  assert.equal(replayed.status, 'submitted')
  assert.equal(replayed.jobId, completed.jobId)
  // create was NOT called again
  assert.equal(createdJobsCount, 1)
})

test('submission normalization covers video text and first/last roles and refuses unsupported input intent', () => {
  const capabilities: ModelCapabilities = { modes: ['text_to_video', 'image_to_video'], supportedMediaKinds: ['video'], parameters: [], declaredBy: 'plugin-manifest',
    inputSlots: ['first_frame', 'last_frame'].map(role => ({ role, required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'] })) }
  const normalize = (caps: ModelCapabilities, inputs: any[]) => normalizeSubmissionRequest({ capabilities: caps, defaults: {},
    request: { modelId: randomUUID(), prompt: 'synthetic video', parameters: {}, inputs }, kind: 'video', signal: new AbortController().signal, deadline: Date.now() + 10000 })
  assert.equal(normalize(capabilities, []).mode, 'text_to_video')
  const inputs = [{ assetId: randomUUID(), role: 'first_frame', position: 0 }, { uploadId: randomUUID(), role: 'last_frame', position: 1 }]
  assert.deepEqual(normalize(capabilities, inputs).inputs, inputs)
  assert.equal(normalize(capabilities, inputs).mode, 'image_to_video')
  assert.throws(() => normalize({ ...capabilities, modes: ['text_to_video'] }, inputs))
  assert.throws(() => normalize({ ...capabilities, modes: ['image_to_video'] }, []))
})

test('submission inpaint accepts bundled declared flags and mask slot, never an image-to-image fallback alone', async () => {
  const { resolvePresetCapabilities } = await import('../../apps/api/src/admin/model-presets')
  const { capabilities } = await resolvePresetCapabilities('openai-image', '1.1.0', 'gpt-image-2')
  const inputs = [{ assetId: randomUUID(), role: 'reference_image', position: 0 }, { uploadId: randomUUID(), role: 'mask', position: 1 }]
  const normalize = (caps: ModelCapabilities, items = inputs) => normalizeSubmissionRequest({ capabilities: caps, defaults: {},
    request: { modelId: randomUUID(), prompt: 'synthetic edit', parameters: { size: '1024x1024', count: 1 }, inputs: items }, kind: 'image', signal: new AbortController().signal, deadline: Date.now() + 10000 })
  assert.equal(normalize(capabilities).mode, 'inpaint')
  assert.throws(() => normalize({ ...capabilities, flags: {} }))
  assert.throws(() => normalize({ ...capabilities, flags: { ...capabilities.flags, inpainting: false } }))
  assert.throws(() => normalize({ ...capabilities, inputSlots: capabilities.inputSlots.filter(slot => slot.role !== 'mask') }))
  assert.throws(() => normalize(capabilities, [inputs[1]!]))
})
