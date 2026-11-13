import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadMock } from './mock-workspace-test-loader.mjs'

const { MOCK_MODEL, SHOWCASE_ITEMS, mockSeedAssets, mockSampleAsset } = loadMock()

test('sample metadata and capability declarations remain truthful to checked-in artwork', () => {
  assert.deepEqual(MOCK_MODEL.modes, ['text_to_image'])
  assert.deepEqual(MOCK_MODEL.supportedMediaKinds, ['image'])
  assert.equal(MOCK_MODEL.maxInputImages, 0)
  assert.deepEqual(MOCK_MODEL.inputSlots, [])
  const seed = mockSeedAssets()
  assert.equal(new Set(seed.map((asset) => asset.id)).size, SHOWCASE_ITEMS.length)
  for (const [index, item] of SHOWCASE_ITEMS.entries()) {
    const asset = mockSampleAsset('test', index, 'custom prompt', '2026-01-01T00:00:00.000Z')
    assert.equal(asset.width, item.width)
    assert.equal(asset.height, item.height)
    assert.equal(asset.url, item.src)
    assert.equal(asset.downloadUrl, item.src)
    assert.ok(asset.prompt.includes('非真实生成'))
    assert.equal(asset.inputPrompt, 'custom prompt')
  }
  seed[0].prompt = 'mutation'
  assert.notEqual(mockSeedAssets()[0].prompt, 'mutation')
})
