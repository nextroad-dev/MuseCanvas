import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultsPatchForKind,
  defaultsSaveError,
  defaultIdForKind,
  defaultInUseMessage,
  enabledModelsByKind,
  isModelDefault,
  mediaDefaultKindOf,
  patchMediaModelDefaults,
  rewriteDefaultInUseError,
} from './admin-media-model-defaults.ts'

const model = (id, modelKind, enabled) => ({
  id,
  displayName: id,
  modelKind,
  enabled,
})

test('media kind falls back to image for language rows; only enabled rows of the kind are electable', () => {
  assert.equal(mediaDefaultKindOf({ modelKind: 'video' }), 'video')
  assert.equal(mediaDefaultKindOf({ modelKind: 'language' }), 'image')
  const models = [
    model('img-on', 'image', true),
    model('img-off', 'image', false),
    model('vid-on', 'video', true),
  ]
  assert.deepEqual(enabledModelsByKind(models, 'image').map((m) => m.id), ['img-on'])
  assert.deepEqual(enabledModelsByKind(models, 'video').map((m) => m.id), ['vid-on'])
})

test('defaults lookup covers both kinds and null defaults', () => {
  const defaults = { imageModelId: 'img-1', videoModelId: null, updatedAt: 't' }
  assert.equal(defaultIdForKind(defaults, 'image'), 'img-1')
  assert.equal(defaultIdForKind(defaults, 'video'), null)
  assert.equal(defaultIdForKind(undefined, 'image'), null)
  assert.equal(isModelDefault('img-1', defaults), true)
  assert.equal(isModelDefault('other', defaults), false)
  assert.equal(isModelDefault('img-1', undefined), false)
})

test('single-kind patch leaves the other kind untouched', () => {
  assert.deepEqual(defaultsPatchForKind('image', 'img-1'), { imageModelId: 'img-1' })
  assert.deepEqual(defaultsPatchForKind('video', 'vid-1'), { videoModelId: 'vid-1' })
})

test('409 guard copy names the kind; save errors map codes before falling back', () => {
  assert.equal(defaultInUseMessage('image'), '这是当前默认的图像模型，请先指定其他默认模型')
  assert.equal(defaultInUseMessage('video'), '这是当前默认的视频模型，请先指定其他默认模型')
  assert.equal(
    rewriteDefaultInUseError({ code: 'DEFAULT_MODEL_IN_USE', message: 'server' }, 'video', 'fallback'),
    '这是当前默认的视频模型，请先指定其他默认模型',
  )
  assert.equal(rewriteDefaultInUseError({ message: 'boom' }, 'image', 'fallback'), 'boom')
  assert.equal(rewriteDefaultInUseError(null, 'image', 'fallback'), 'fallback')
  assert.match(defaultsSaveError({ code: 'DEFAULT_MODEL_INVALID' }), /已停用/)
  assert.equal(defaultsSaveError({ message: 'boom' }), 'boom')
  assert.equal(defaultsSaveError(null), '保存默认模型失败')
})

test('patch wrapper uses PATCH and keeps the error code for copy mapping', async () => {
  const calls = []
  const data = { imageModelId: 'img-1', videoModelId: null, updatedAt: 't' }
  const result = await patchMediaModelDefaults(
    async (path, options) => {
      calls.push([path, options])
      return { success: true, data }
    },
    '/api/admin/media-model-defaults',
    { imageModelId: 'img-1' },
  )
  assert.equal(result, data)
  assert.deepEqual(calls, [['/api/admin/media-model-defaults', { method: 'PATCH', body: { imageModelId: 'img-1' } }]])

  const failure = await patchMediaModelDefaults(
    async () => ({ success: false, error: { code: 'DEFAULT_MODEL_INVALID', message: 'bad' } }),
    '/x',
    { videoModelId: 'v' },
  ).then(
    () => assert.fail('should reject'),
    (error) => error,
  )
  assert.equal(failure.code, 'DEFAULT_MODEL_INVALID')
  assert.match(defaultsSaveError(failure), /已停用/)
})
