import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTs } from '../../../shared/services/mock-workspace-test-loader.mjs'

const artifactContracts = loadTs(new URL('../../../../../../packages/contracts/src/agent/artifacts.ts', import.meta.url))
const agentContracts = loadTs(new URL('../../../../../../packages/contracts/src/agent/index.ts', import.meta.url), {
  './artifacts': artifactContracts,
})
const { toAgentMessageAttachments } = loadTs(new URL('./attachment-references.ts', import.meta.url), {
  '@musecanvas/contracts': agentContracts,
})

/**
 * 草稿附件 → 消息附件的形状契约。
 *
 * 这些用例覆盖的是「前端会不会把一个服务端一定拒绝的请求发出去」以及「会不会
 * 悄悄少发一张图」。归属与准备身份真伪由服务端判定，这里只保证形状与配对。
 */

const NOW = Date.parse('2026-11-18T10:00:00Z')
const SOURCE_CHECKSUM = 'a'.repeat(64)
const MASK_CHECKSUM = 'b'.repeat(64)
const SOURCE_ID = '20000000-0000-4000-8000-000000000001'
const MASK_ID = '30000000-0000-4000-8000-000000000001'
const UPLOAD_ID = '40000000-0000-4000-8000-000000000001'

const libraryImage = (extra = {}) => ({
  id: 'attachment-1',
  url: 'blob:preview',
  name: '水乡',
  source: 'library',
  assetId: SOURCE_ID,
  checksum: SOURCE_CHECKSUM,
  mimeType: 'image/png',
  width: 1200,
  height: 800,
  ...extra,
})

const preparedImage = (extra = {}) => libraryImage({
  preparation: {
    maskUploadId: MASK_ID,
    maskChecksum: MASK_CHECKSUM,
    sourceKind: 'asset',
    sourceId: SOURCE_ID,
    sourceChecksum: SOURCE_CHECKSUM,
    expiresAt: '2026-11-18T11:00:00Z',
    selection: { x: 10, y: 10, width: 100, height: 100 },
  },
  ...extra,
})

test('a plain library image becomes one asset reference', () => {
  assert.deepEqual(toAgentMessageAttachments([libraryImage()], NOW), [{
    kind: 'asset',
    id: SOURCE_ID,
    role: 'reference_image',
    checksum: SOURCE_CHECKSUM,
    width: 1200,
    height: 800,
    mimeType: 'image/png',
  }])
})

test('a prepared gallery draft can be sent without a top-level upload id', () => {
  const references = toAgentMessageAttachments([preparedImage()], NOW)
  assert.equal(references.length, 2)
  assert.deepEqual(references[0], {
    kind: 'upload',
    id: MASK_ID,
    role: 'mask',
    checksum: MASK_CHECKSUM,
    width: 1200,
    height: 800,
    mimeType: 'image/png',
    preparationVersion: 1,
    sourceChecksum: SOURCE_CHECKSUM,
  })
  assert.deepEqual(references[1], {
    kind: 'asset',
    id: SOURCE_ID,
    role: 'reference_image',
    checksum: SOURCE_CHECKSUM,
    width: 1200,
    height: 800,
    mimeType: 'image/png',
  })
})

test('a plain upload keeps its upload id and jpeg mime type', () => {
  const references = toAgentMessageAttachments([{
    id: 'upload-1', url: 'blob:preview', name: '本地', source: 'upload',
    uploadId: UPLOAD_ID, checksum: SOURCE_CHECKSUM, mimeType: 'image/jpeg', width: 640, height: 480,
  }], NOW)
  assert.equal(references[0].kind, 'upload')
  assert.equal(references[0].id, UPLOAD_ID)
  assert.equal(references[0].mimeType, 'image/jpeg')
})

test('an expired preparation is refused instead of sending a dead mask', () => {
  assert.throws(() => toAgentMessageAttachments([preparedImage()], Date.parse('2026-11-18T11:00:01Z')), /已过期/)
})

test('an attachment that never reached storage is refused, never silently dropped', () => {
  assert.throws(() => toAgentMessageAttachments([{ id: 'a', url: 'blob:x', name: '本地', source: 'upload', width: 10, height: 10 }], NOW), /尚未完成上传/)
  assert.throws(() => toAgentMessageAttachments([libraryImage({ width: 0 })], NOW), /缺少可用尺寸/)
  const prepared = preparedImage()
  assert.throws(() => toAgentMessageAttachments([{
    ...prepared,
    preparation: { ...prepared.preparation, maskUploadId: '' },
  }], NOW), /缺少上传标识/)
})

test('mock-era placeholders with no ids cannot become message attachments', () => {
  assert.throws(
    () => toAgentMessageAttachments([{ id: 'upload-1', url: 'data:image/png;base64,xx', name: '本地', source: 'upload', width: 0, height: 0 }], NOW),
    /尚未完成上传/,
  )
})
