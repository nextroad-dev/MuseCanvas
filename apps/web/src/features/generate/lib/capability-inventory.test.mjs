import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildComposerContext,
  buildComposerUserRequest,
  composerDraftFromJobConfig,
  createComposerDraft,
} from './agent-composer.ts'

function source(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

/**
 * One draft per capability the old manual console could express. Each entry is the
 * *complete* explicit user selection for that capability: model, parameters, input
 * roles/order and (for an edit) the region. The request builder must carry all of
 * them into the Agent context unchanged — the Agent may only refuse a choice, never
 * silently drop or override it.
 */
const CAPABILITIES = [
  {
    capability: 'text_to_image',
    draft: createComposerDraft({
      text: '窗边的白瓷花瓶',
      intent: 'generate',
      modelId: 'image-model-1',
      parameters: { quality: 'high', count: 2 },
    }),
    context: { intent: 'generate', modelId: 'image-model-1', parameters: { quality: 'high', count: 2 } },
  },
  {
    capability: 'image_to_image (reference_image)',
    draft: createComposerDraft({
      text: '参照这张图重绘',
      intent: 'generate',
      modelId: 'image-model-2',
      parameters: { size: '1024x1024' },
      inputs: [
        { uploadId: 'upload-1', role: 'reference_image', position: 0 },
        { assetId: 'asset-gallery-1', role: 'reference_image', position: 1 },
      ],
    }),
    context: {
      intent: 'generate',
      modelId: 'image-model-2',
      parameters: { size: '1024x1024' },
      inputs: [
        { uploadId: 'upload-1', role: 'reference_image', position: 0 },
        { assetId: 'asset-gallery-1', role: 'reference_image', position: 1 },
      ],
    },
  },
  {
    capability: 'inpaint (edit source + selection)',
    // Deliberately claims `generate`: an attached rectangle must force `edit`, not
    // be carried under a generate intent.
    draft: createComposerDraft({
      text: '把框选区域改成红色风衣',
      intent: 'generate',
      modelId: 'edit-model-1',
      parameters: { quality: 'medium' },
      editSource: { assetId: 'asset-source-1', selection: { x: 10, y: 20, width: 120, height: 80 } },
    }),
    context: {
      intent: 'edit',
      modelId: 'edit-model-1',
      parameters: { quality: 'medium' },
      editSource: { assetId: 'asset-source-1', selection: { x: 10, y: 20, width: 120, height: 80 } },
    },
  },
  {
    capability: 'text_to_video',
    draft: createComposerDraft({
      text: '晨雾中的森林，缓慢推进',
      intent: 'generate',
      modelId: 'video-model-1',
      parameters: { duration: 5 },
    }),
    context: { intent: 'generate', modelId: 'video-model-1', parameters: { duration: 5 } },
  },
  {
    capability: 'image_to_video (first_frame + last_frame)',
    draft: createComposerDraft({
      text: '从首帧过渡到尾帧',
      intent: 'generate',
      modelId: 'video-model-2',
      parameters: { duration: 5, resolution: '1080p' },
      inputs: [
        { uploadId: 'first-upload', role: 'first_frame', position: 0 },
        { assetId: 'last-asset', role: 'last_frame', position: 1 },
      ],
    }),
    context: {
      intent: 'generate',
      modelId: 'video-model-2',
      parameters: { duration: 5, resolution: '1080p' },
      inputs: [
        { uploadId: 'first-upload', role: 'first_frame', position: 0 },
        { assetId: 'last-asset', role: 'last_frame', position: 1 },
      ],
    },
  },
]

test('every migrated capability keeps its explicit model, parameters, roles and selection', () => {
  for (const entry of CAPABILITIES) {
    const context = buildComposerContext(entry.draft)
    // Always an explicit intent; never a context-less request.
    assert.equal(context.intent, entry.context.intent, `${entry.capability}: intent preserved`)
    assert.equal(context.modelId, entry.context.modelId, `${entry.capability}: explicit model preserved`)
    assert.deepEqual(context.parameters, entry.context.parameters, `${entry.capability}: parameters preserved`)
    if (entry.context.inputs) {
      assert.deepEqual(context.inputs, entry.context.inputs, `${entry.capability}: role/position inputs preserved`)
    } else {
      assert.equal(context.inputs, undefined, `${entry.capability}: no phantom inputs`)
    }
    if (entry.context.editSource) {
      assert.deepEqual(context.editSource, entry.context.editSource, `${entry.capability}: selection preserved verbatim`)
    }

    // And the request that actually leaves the browser is confirmation-gated and
    // agent-managed for every capability — there is no capability-specific bypass.
    const request = buildComposerUserRequest({ messageId: 'm-1', baseRevision: 7, draft: entry.draft })
    assert.equal(request.kind, 'user')
    assert.equal(request.requireConfirmation, true)
    assert.equal(request.sceneCommitMode, 'agent-managed')
    assert.equal(request.baseRevision, 7)
    assert.deepEqual(request.context, context)
  }
})

test('a gallery pick is a first-class input: the same draft shape covers upload and asset reuse', () => {
  const galleryOnly = createComposerDraft({
    text: '使用图库图片',
    modelId: 'image-model-2',
    inputs: [{ assetId: 'asset-42', role: 'reference_image', position: 0 }],
  })
  const context = buildComposerContext(galleryOnly)
  assert.deepEqual(context.inputs, [{ assetId: 'asset-42', role: 'reference_image', position: 0 }])
  // The gallery pick is referenced by asset id; no bytes, url or objectKey may be invented.
  assert.equal(JSON.stringify(context).includes('http'), false)
})

test('job-config reuse seeds the draft with the explicit model and parameters, never inputs/selection', () => {
  const previous = createComposerDraft({ text: 'old text', intent: 'edit', editSource: { assetId: 'a', selection: { x: 0, y: 0, width: 1, height: 1 } } })
  const next = composerDraftFromJobConfig({
    prompt: '历史提示词',
    model: { id: 'historic-model' },
    parameters: { quality: 'high', count: 3 },
  }, previous)

  assert.equal(next.text, '历史提示词')
  assert.equal(next.intent, 'generate')
  assert.equal(next.modelId, 'historic-model')
  assert.deepEqual(next.parameters, { quality: 'high', count: 3 })
  // A historical job never restores references or a region: carrying the previous
  // draft's would attach the wrong image to the next proposal.
  assert.deepEqual(next.inputs, [])
  assert.equal(next.editSource, null)

  // An unavailable historical model keeps the current explicit model instead of
  // dropping to `null`, so the request still names a model the user can see.
  const kept = composerDraftFromJobConfig({ prompt: 'p', model: null, parameters: {} }, previous)
  assert.equal(kept.modelId, previous.modelId)
})

test('the console wiring feeds the composer every capability control and never submits directly', () => {
  const consoleText = source('../components/generate-console.tsx')

  // The Agent composer must expose model, parameters and role-positioned inputs.
  const composerText = source('../components/agent-composer.tsx')
  assert.match(composerText, /MediaParameterControls/)
  assert.match(composerText, /ReferenceImagesTrigger/)

  // Gallery reuse: the reference panel owns the picker, and the console reads the
  // staged images at send time.
  const referenceDialog = source('../components/reference-images-dialog.tsx')
  assert.match(referenceDialog, /GalleryImagePicker/)
  assert.match(consoleText, /buildGenerationInputs\(/)

  // The visible model selection is sent as the explicit context model — not left
  // null and not overwritten by an implicit default.
  assert.match(consoleText, /modelId:\s*activeModelId/)

  // Region editing is a draft entry: the subject is built from the result job or a
  // library edit target, and its selection only ever writes composer context.
  assert.match(consoleText, /jobResultSubject/)
  assert.match(consoleText, /editTargetResultSubject/)
  assert.match(consoleText, /editSource:\s*\{\s*assetId:\s*draft\.assetId,\s*selection:\s*draft\.selection\s*\}/)

  // Job-config reuse seeds the draft; existing tasks are a real list with a reuse
  // action, not a fake Agent history.
  assert.match(consoleText, /composerDraftFromJobConfig/)
  assert.match(consoleText, /GenerationTaskPanel/)
  assert.match(consoleText, /onReuseJob/)
  const taskPanel = source('../components/generation-task-panel.tsx')
  assert.match(taskPanel, /既有任务/)
  assert.match(taskPanel, /使用这次配置/)

  // A multi-output result keeps every output reachable: the subject maps all of
  // them and the dialog owns the switcher.
  assert.match(consoleText, /job\.outputs\.map\(/)
  const dialogText = source('../components/result-dialog.tsx')
  assert.match(dialogText, /切换产物/)
  assert.match(dialogText, /aria-pressed=\{itemIndex === activeIndex\}/)

  // `?tab=` maps to the composer mode only; it never fires a submit.
  assert.match(consoleText, /searchParams\.get\('tab'\)/)
  assert.match(consoleText, /setActiveTab\(readTabParam\(raw\)\)/)

  // No direct execution path: the page cannot create a job or an image edit.
  for (const forbidden of [/useCreateJob\b/, /useCreateJobMutation\b/, /useCreateImageEdit\b/, /createGeneration\b/, /API_ENDPOINTS\.images\.edit/]) {
    assert.doesNotMatch(consoleText, forbidden, `the console must not reference ${forbidden}`)
  }
})

test('the library region-edit entry hands a source over as a draft, never a direct edit', () => {
  const lightbox = source('../../library/components/asset-lightbox.tsx')
  assert.match(lightbox, /setEditTarget\(/)
  for (const forbidden of [/useCreateImageEdit\b/, /useCreateJob\b/, /postImageEdit\b/, /createGeneration\b/]) {
    assert.doesNotMatch(lightbox, forbidden, `the library entry must not reference ${forbidden}`)
  }

  // The dialog that consumes that handover only writes composer context.
  const dialog = source('../components/result-dialog.tsx')
  assert.match(dialog, /onUseEditSource/)
  assert.doesNotMatch(dialog, /useCreateImageEdit|useCreateJob|createGeneration/)
})
