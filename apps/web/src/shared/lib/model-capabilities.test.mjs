import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelCapabilityNote, resolveActiveImageModel, resolveActiveModel } from './model-capabilities.ts'

function model(overrides) {
  return {
    id: 'model-id',
    displayName: 'Model',
    modelKind: 'image',
    adapter: 'openai',
    sizes: [],
    maxCount: 1,
    concurrencyLimit: 1,
    enabled: true,
    sortOrder: 0,
    ...overrides,
  }
}

test('a remembered id wins while its row is still offered and enabled', () => {
  const models = [
    model({ id: 'a', isDefault: true }),
    model({ id: 'b' }),
  ]
  assert.equal(resolveActiveModel(models, 'b')?.id, 'b')
})

test('a fresh conversation lands on the admin default, not the first row', () => {
  const models = [
    model({ id: 'a' }),
    model({ id: 'b', isDefault: true }),
    model({ id: 'c' }),
  ]
  assert.equal(resolveActiveModel(models, '')?.id, 'b')
})

test('an unknown remembered id falls back to the default', () => {
  const models = [model({ id: 'a' }), model({ id: 'b', isDefault: true })]
  assert.equal(resolveActiveModel(models, 'retired-id')?.id, 'b')
})

test('a remembered disabled row never wins over a live default', () => {
  const models = [
    model({ id: 'stale', enabled: false }),
    model({ id: 'live', isDefault: true }),
  ]
  assert.equal(resolveActiveModel(models, 'stale')?.id, 'live')
})

test('without a default the first non-deprecated row wins', () => {
  const models = [
    model({ id: 'old', deprecated: true }),
    model({ id: 'fresh' }),
  ]
  assert.equal(resolveActiveModel(models, '')?.id, 'fresh')
})

test('an empty catalogue resolves to undefined instead of throwing', () => {
  assert.equal(resolveActiveModel([], ''), undefined)
})

test('image and video kinds resolve independently from their own defaults', () => {
  const imageModels = [model({ id: 'img-a' }), model({ id: 'img-b', isDefault: true })]
  const videoModels = [model({ id: 'vid-a', modelKind: 'video' }), model({ id: 'vid-b', modelKind: 'video', isDefault: true })]
  assert.equal(resolveActiveModel(imageModels, '')?.id, 'img-b')
  assert.equal(resolveActiveModel(videoModels, '')?.id, 'vid-b')
})

test('the legacy image resolver stays a wrapper: it scopes to images and keeps defaults', () => {
  const models = [
    model({ id: 'img', isDefault: true }),
    model({ id: 'vid', modelKind: 'video', isDefault: true }),
  ]
  assert.equal(resolveActiveImageModel(models, '')?.id, 'img')
  assert.equal(resolveActiveImageModel(models, 'vid')?.id, 'img')
})

test('picker notes are derived from slots and flags, never from model names', () => {
  assert.equal(modelCapabilityNote(model({ inputSlots: [{ role: 'reference_image' }] })), '图像 · 支持参考图')
  assert.equal(
    modelCapabilityNote(model({
      flags: { mask: true },
      inputSlots: [{ role: 'reference_image' }, { role: 'mask' }],
    })),
    '图像 · 支持参考图与局部修改',
  )
  assert.equal(modelCapabilityNote(model({ modelKind: 'video' })), '视频 · 文生视频')
  assert.equal(
    modelCapabilityNote(model({ modelKind: 'video', inputSlots: [{ role: 'first_frame' }] })),
    '视频 · 支持首帧图输入',
  )
})
