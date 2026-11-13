import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeModelCapabilities,
  maskCapabilityBlockReason,
  modelAcceptsMask,
  resolveActiveImageModel,
  resolveActiveModel,
} from './model-capabilities.ts'

function model(overrides = {}) {
  return {
    id: 'model-id',
    displayName: 'Model',
    modelKind: 'image',
    enabled: true,
    isDefault: false,
    ...overrides,
  }
}

test('记住的 id 在仍可用时优先', () => {
  const models = [model({ id: 'a', isDefault: true }), model({ id: 'b' })]
  assert.equal(resolveActiveModel(models, 'image', 'b')?.id, 'b')
})

test('新对话回落到管理端默认模型，而不是第一行', () => {
  const models = [model({ id: 'a' }), model({ id: 'b', isDefault: true }), model({ id: 'c' })]
  assert.equal(resolveActiveModel(models, 'image', null)?.id, 'b')
})

test('未知/停用的记住值不会压过在线默认', () => {
  const models = [model({ id: 'a' }), model({ id: 'b', isDefault: true })]
  assert.equal(resolveActiveModel(models, 'image', 'retired-id')?.id, 'b')
  const withDisabled = [model({ id: 'stale', enabled: false }), model({ id: 'live', isDefault: true })]
  assert.equal(resolveActiveModel(withDisabled, 'image', 'stale')?.id, 'live')
})

test('无默认时选第一个非 deprecated', () => {
  const models = [model({ id: 'old', deprecated: true }), model({ id: 'fresh' })]
  assert.equal(resolveActiveModel(models, 'image', '')?.id, 'fresh')
})

test('空目录返回 null，不抛错', () => {
  assert.equal(resolveActiveModel([], 'image', ''), null)
})

test('图像/视频各自独立解析（kind 会先过滤目录）', () => {
  const models = [
    model({ id: 'img-a' }),
    model({ id: 'img-b', isDefault: true }),
    model({ id: 'vid-a', modelKind: 'video' }),
    model({ id: 'vid-b', modelKind: 'video', isDefault: true }),
  ]
  assert.equal(resolveActiveModel(models, 'image', null)?.id, 'img-b')
  assert.equal(resolveActiveModel(models, 'video', null)?.id, 'vid-b')
  assert.equal(resolveActiveImageModel(models, 'vid-b')?.id, 'img-b')
})

test('能力说明由 slots/flags 推导，不硬编码模型名', () => {
  assert.equal(describeModelCapabilities(model({ inputSlots: [{ role: 'reference_image' }] })), '图像 · 支持参考图')
  assert.equal(
    describeModelCapabilities(
      model({ flags: { mask: true }, inputSlots: [{ role: 'reference_image' }, { role: 'mask' }] }),
    ),
    '图像 · 支持参考图与局部修改',
  )
  assert.equal(describeModelCapabilities(model()), '图像 · 文生图')
  assert.equal(describeModelCapabilities(model({ modelKind: 'video' })), '视频 · 文生视频')
  assert.equal(
    describeModelCapabilities(model({ modelKind: 'video', inputSlots: [{ role: 'first_frame' }] })),
    '视频 · 支持首帧图输入',
  )
})

test('遮罩能力要求 flag 与输入槽同时成立，undeclared 契约一票否决', () => {
  const capable = model({ flags: { mask: true }, inputSlots: [{ role: 'mask' }] })
  assert.equal(modelAcceptsMask(capable), true)
  assert.equal(maskCapabilityBlockReason(capable), null)
  assert.equal(modelAcceptsMask(model({ flags: { mask: true } })), false)
  assert.equal(modelAcceptsMask(model({ inputSlots: [{ role: 'mask' }] })), false)
  assert.equal(
    modelAcceptsMask(model({ flags: { mask: true }, inputSlots: [{ role: 'mask' }], declaredBy: 'undeclared' })),
    false,
  )
  assert.match(maskCapabilityBlockReason(model({ declaredBy: 'undeclared' })), /参数契约/)
  assert.match(maskCapabilityBlockReason(model()), /不支持选区遮罩/)
})
