import assert from 'node:assert/strict'
import { test } from 'node:test'
import { consumeReuseQuery, reuseKindBlockReason } from './generate-reuse.ts'

const draft = { prompt: '未提交的草稿', requestedKind: 'image', lastReuseQuery: '' }

test('library image reuse applies decoded prompt and consumes subsequent navigation changes', () => {
  const first = consumeReuseQuery(draft, 'prompt=%E6%9E%97%E9%97%B4%E6%9C%A8%E5%B1%8B+%26+sunlight&kind=image')
  assert.equal(first.prompt, '林间木屋 & sunlight')
  assert.equal(reuseKindBlockReason(first.requestedKind), null)
  const edited = { ...first, prompt: '用户继续编辑' }
  assert.equal(consumeReuseQuery(edited, 'kind=image&prompt=%E6%9E%97%E9%97%B4%E6%9C%A8%E5%B1%8B+%26+sunlight&unrelated=1'), edited)
  const next = consumeReuseQuery(edited, 'prompt=新的素材&kind=image')
  assert.equal(next.prompt, '新的素材')
})

test('ordinary navigation preserves edited draft and allows later explicit reuse of same material', () => {
  const reused = consumeReuseQuery(draft, 'prompt=素材&kind=image')
  const edited = { ...reused, prompt: '继续写下的草稿' }
  const ordinary = consumeReuseQuery(edited, 'tab=recent')
  assert.equal(ordinary.prompt, edited.prompt)
  assert.equal(ordinary.requestedKind, 'image')
  assert.equal(consumeReuseQuery(ordinary, ''), ordinary)
  assert.equal(consumeReuseQuery(ordinary, 'prompt=素材&kind=image').prompt, '素材')
})

test('video reuse blocks image submission until explicit image choice, including after edits/navigation', () => {
  const video = consumeReuseQuery(draft, 'prompt=镜头缓缓推进&kind=video')
  assert.equal(video.prompt, '镜头缓缓推进')
  assert.ok(reuseKindBlockReason(video.requestedKind))
  const edited = consumeReuseQuery({ ...video, prompt: '编辑后的视频描述' }, '')
  assert.ok(reuseKindBlockReason(edited.requestedKind))
  const confirmed = { ...edited, requestedKind: 'image' }
  assert.equal(reuseKindBlockReason(confirmed.requestedKind), null)
  const fromImage = consumeReuseQuery(video, 'prompt=静物&kind=image')
  assert.equal(reuseKindBlockReason(fromImage.requestedKind), null)
})

test('kind-only and unknown-kind reuse never silently submit images or erase prompt', () => {
  const video = consumeReuseQuery(draft, 'kind=video')
  assert.equal(video.prompt, draft.prompt)
  assert.ok(reuseKindBlockReason(video.requestedKind))
  assert.ok(reuseKindBlockReason(consumeReuseQuery(draft, 'prompt=保留&kind=unknown').requestedKind))
  assert.equal(consumeReuseQuery(video, 'prompt=仅提示词').requestedKind, 'image')
})
