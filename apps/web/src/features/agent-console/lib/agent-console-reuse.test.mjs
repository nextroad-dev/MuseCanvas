import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  consumeReuseQuery,
  parseInspectorPanelQuery,
  parseReuseKindQuery,
} from './agent-console-reuse.ts'

const initial = { draftPrompt: '用户的未发送草稿', lastReuseQuery: '' }

test('consumeReuseQuery prefills draftPrompt once from library reuse link without wiping edits', () => {
  const first = consumeReuseQuery(initial, 'prompt=%E6%9E%97%E9%97%B4%E6%9C%A8%E5%B1%8B+%26+sunlight&kind=image')
  assert.equal(first.draftPrompt, '林间木屋 & sunlight')

  const edited = { ...first, draftPrompt: '用户在此基础上继续编辑' }
  const reordered = consumeReuseQuery(
    edited,
    'kind=image&prompt=%E6%9E%97%E9%97%B4%E6%9C%A8%E5%B1%8B+%26+sunlight&panel=artifacts',
  )
  assert.equal(reordered, edited)
  assert.equal(reordered.draftPrompt, '用户在此基础上继续编辑')

  const next = consumeReuseQuery(edited, 'prompt=%E6%96%B0%E7%9A%84%E7%81%B5%E6%84%9F&kind=video')
  assert.equal(next.draftPrompt, '新的灵感')
})

test('normal navigation preserves edited draftPrompt and resets lastReuseQuery for future reuse', () => {
  const reused = consumeReuseQuery(initial, 'prompt=%E7%B4%A0%E6%9D%90A&kind=image')
  const edited = { ...reused, draftPrompt: '手动修改后的提示词' }

  const ordinary = consumeReuseQuery(edited, 'panel=artifacts')
  assert.equal(ordinary.draftPrompt, '手动修改后的提示词')
  assert.equal(ordinary.lastReuseQuery, '')

  assert.equal(consumeReuseQuery(ordinary, ''), ordinary)

  const reusedAgain = consumeReuseQuery(ordinary, 'prompt=%E7%B4%A0%E6%9D%90A&kind=image')
  assert.equal(reusedAgain.draftPrompt, '素材A')
})

test('kind-only or empty prompt query never erases draftPrompt', () => {
  const kindOnly = consumeReuseQuery(initial, 'kind=video')
  assert.equal(kindOnly.draftPrompt, initial.draftPrompt)

  const emptyPrompt = consumeReuseQuery(initial, 'prompt=&kind=image')
  assert.equal(emptyPrompt.draftPrompt, initial.draftPrompt)
})

test('parseInspectorPanelQuery and parseReuseKindQuery extract validated query hints', () => {
  assert.equal(parseInspectorPanelQuery('?panel=canvas'), null)
  assert.equal(parseInspectorPanelQuery('panel=canvas'), null)
  assert.equal(parseInspectorPanelQuery('panel=artifacts&prompt=abc'), 'artifacts')
  assert.equal(parseInspectorPanelQuery('?panel=artifacts'), 'artifacts')
  assert.equal(parseInspectorPanelQuery('panel=tools'), 'tools')
  assert.equal(parseInspectorPanelQuery('panel=unknown'), null)
  assert.equal(parseInspectorPanelQuery(''), null)

  assert.equal(parseReuseKindQuery('?prompt=a&kind=video'), 'video')
  assert.equal(parseReuseKindQuery('kind=image'), 'image')
  assert.equal(parseReuseKindQuery('kind=   '), null)
})
