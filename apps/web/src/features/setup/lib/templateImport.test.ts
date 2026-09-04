// Browser-safe unit tests for the prompt-template import parser (no DOM, no Vue).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseTemplateImportFile } from './templateImport'

function file(body: unknown): string {
  return JSON.stringify(body)
}

function entry(name = '通用'): Record<string, string> {
  return { name, description: '说明', instruction: '画一张图' }
}

describe('parseTemplateImportFile top-level name', () => {
  it('omits the name for bare-array files', () => {
    const parsed = parseTemplateImportFile(file([entry()]))
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.equal(parsed.result.name, undefined)
  })

  it('omits the name when the object file has none', () => {
    const parsed = parseTemplateImportFile(file({ templates: [entry()] }))
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.equal(parsed.result.name, undefined)
  })

  it('accepts a valid name, trimmed', () => {
    const parsed = parseTemplateImportFile(file({ name: '  默认模板集  ', templates: [entry()] }))
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.equal(parsed.result.name, '默认模板集')
  })

  it('accepts a 120-character name', () => {
    const name = 'a'.repeat(120)
    const parsed = parseTemplateImportFile(file({ name, templates: [entry()] }))
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.equal(parsed.result.name, name)
  })

  it('rejects a non-string name', () => {
    const parsed = parseTemplateImportFile(file({ name: 42, templates: [entry()] }))
    assert.equal(parsed.ok, false)
    if (!parsed.ok) assert.equal(parsed.error, '顶层 name 应为字符串')
  })

  it('rejects a blank name', () => {
    const parsed = parseTemplateImportFile(file({ name: '   ', templates: [entry()] }))
    assert.equal(parsed.ok, false)
    if (!parsed.ok) assert.equal(parsed.error, '顶层 name 不能为空')
  })

  it('rejects an overlong name', () => {
    const parsed = parseTemplateImportFile(file({ name: 'a'.repeat(121), templates: [entry()] }))
    assert.equal(parsed.ok, false)
    if (!parsed.ok) assert.match(parsed.error, /顶层 name 超过上限/)
  })

  it('rejects control characters', () => {
    const parsed = parseTemplateImportFile(
      file({ name: 'ab' + String.fromCharCode(0) + 'cd', templates: [entry()] }),
    )
    assert.equal(parsed.ok, false)
    if (!parsed.ok) assert.equal(parsed.error, '顶层 name 不能包含控制字符')
  })

  it('still parses entries alongside the name', () => {
    const parsed = parseTemplateImportFile(
      file({ name: 'v4', version: 3, templates: [entry('甲'), entry('乙')] }),
    )
    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.equal(parsed.result.name, 'v4')
      assert.deepEqual(
        parsed.result.entries.map((e) => e.name),
        ['甲', '乙'],
      )
    }
  })
})
