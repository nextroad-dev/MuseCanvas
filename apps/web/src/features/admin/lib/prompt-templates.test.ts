// Browser-safe unit tests for admin prompt-template helpers (no DOM, no Vue).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildImportPromptTemplateSetInput,
  buildPromptTemplateExportFilename,
  buildPromptTemplateExportUrl,
  extractTemplateVariables,
  toStandardTemplateJson,
} from './prompt-templates'
import type { PromptTemplateSetDetailDto } from '@/shared/types'

function detail(): PromptTemplateSetDetailDto {
  return {
    id: 'set-1',
    name: '默认模板集',
    version: 3,
    isActive: true,
    entryCount: 2,
    contentDigest: 'abc123',
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    entries: [
      {
        id: 'e2',
        setId: 'set-1',
        name: '人像',
        description: '第二条',
        instruction: '画一张 {{input_prompt}}，尺寸 {{size}}',
        sortOrder: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'e1',
        setId: 'set-1',
        name: '风景',
        description: '第一条',
        path: 'landscape.md',
        instruction: '画一张风景',
        sortOrder: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
}

describe('buildPromptTemplateExportUrl', () => {
  it('targets the active set when no id is given', () => {
    assert.equal(buildPromptTemplateExportUrl(), '/api/admin/prompt-templates/export')
    assert.equal(buildPromptTemplateExportUrl(null), '/api/admin/prompt-templates/export')
  })

  it('encodes the set id', () => {
    assert.equal(
      buildPromptTemplateExportUrl('a/b?c'),
      '/api/admin/prompt-templates/export?setId=a%2Fb%3Fc',
    )
  })
})

describe('buildPromptTemplateExportFilename', () => {
  it('includes the slug and version', () => {
    assert.equal(
      buildPromptTemplateExportFilename({ name: '默认模板集', version: 3 }),
      'prompt-templates-默认模板集-v3.json',
    )
  })

  it('falls back to the id or a generic name', () => {
    assert.equal(buildPromptTemplateExportFilename(null, 'set-9'), 'prompt-templates-set-9.json')
    assert.equal(buildPromptTemplateExportFilename(null, null), 'prompt-templates-templates.json')
  })

  it('strips unsafe characters', () => {
    assert.equal(
      buildPromptTemplateExportFilename({ name: 'a/b:c*d', version: 1 }),
      'prompt-templates-abcd-v1.json',
    )
  })
})

describe('buildImportPromptTemplateSetInput', () => {
  it('assigns sort order by file order and activates by default', () => {
    const input = buildImportPromptTemplateSetInput([
      { name: 'b', description: '', instruction: 'i2', path: 'b.md' },
      { name: 'a', description: 'd', instruction: 'i1' },
    ])
    assert.equal(input.activate, true)
    assert.equal(input.templates.length, 2)
    assert.deepEqual(input.templates[0], {
      name: 'b',
      description: '',
      instruction: 'i2',
      sortOrder: 0,
      path: 'b.md',
    })
    assert.deepEqual(input.templates[1], {
      name: 'a',
      description: 'd',
      instruction: 'i1',
      sortOrder: 1,
    })
    assert.ok(!('path' in (input.templates[1] as Record<string, unknown>)))
  })

  it('honours an explicit name and opt-out of activation', () => {
    const input = buildImportPromptTemplateSetInput(
      [{ name: 'a', description: '', instruction: 'i' }],
      { name: '  v4  ', activate: false },
    )
    assert.equal(input.name, 'v4')
    assert.equal(input.activate, false)
  })

  it('omits a blank set name', () => {
    const input = buildImportPromptTemplateSetInput(
      [{ name: 'a', description: '', instruction: 'i' }],
      { name: '   ' },
    )
    assert.ok(!('name' in input))
  })
})

describe('toStandardTemplateJson', () => {
  it('emits the standard shape in sort order', () => {
    assert.deepEqual(toStandardTemplateJson(detail()), {
      name: '默认模板集',
      version: 3,
      templates: [
        { name: '风景', description: '第一条', instruction: '画一张风景', sortOrder: 0, path: 'landscape.md' },
        { name: '人像', description: '第二条', instruction: '画一张 {{input_prompt}}，尺寸 {{size}}', sortOrder: 1 },
      ],
    })
  })
})

describe('extractTemplateVariables', () => {
  it('returns unique names in first-appearance order', () => {
    assert.deepEqual(
      extractTemplateVariables('{{input_prompt}} {{ size }} {{input_prompt}} {{unknown_var}}'),
      ['input_prompt', 'size', 'unknown_var'],
    )
  })

  it('returns an empty list without variables', () => {
    assert.deepEqual(extractTemplateVariables('纯文本指令'), [])
  })
})
