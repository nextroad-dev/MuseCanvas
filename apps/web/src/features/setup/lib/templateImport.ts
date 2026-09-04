// Client-side parsing for the prompt-template index JSON import.
// Accepts either a bare array or an object wrapping the array under
// `templates` / `entries` / `index` / `items`. An object file may also carry
// an optional top-level `name` (validated like the server: 1~120 chars, no
// control characters); each entry must carry name/description/path/instruction
// per the onboarding contract.
import {
  PROMPT_TEMPLATE_VAR_LOOKUP,
  type SetupTemplateImportEntry,
} from '@/shared/types'

export const TEMPLATE_IMPORT_MAX_ENTRIES = 100
export const TEMPLATE_IMPORT_MAX_INSTRUCTION_CHARS = 128 * 1024
export const TEMPLATE_IMPORT_MAX_SET_NAME_CHARS = 120

const ALLOWED_TEMPLATE_VARS: Readonly<Record<string, true>> = PROMPT_TEMPLATE_VAR_LOOKUP

export interface TemplateImportParseError {
  index: number
  message: string
}

export interface TemplateImportParseResult {
  entries: SetupTemplateImportEntry[]
  /** Validated optional top-level set name (e.g. from an exported file). */
  name?: string
  /** Non-blocking warnings (e.g. unknown {{variables}}); safe to submit. */
  warnings: string[]
}

function varWarnings(entryName: string, instruction: string): string[] {
  const warnings: string[] = []
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g
  let match: RegExpExecArray | null
  const unknown = new Set<string>()
  while ((match = re.exec(instruction)) !== null) {
    if (ALLOWED_TEMPLATE_VARS[match[1]] !== true) unknown.add(match[1])
  }
  for (const name of unknown) {
    warnings.push(`「${entryName}」使用了未知变量 {{${name}}}，服务端可能拒绝导入`)
  }
  return warnings
}

function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (code <= 31 || code === 127) return true
  }
  return false
}

/** Validated optional top-level set `name` (absent on bare-array files). */
function parseTopLevelSetName(raw: unknown): { ok: true; name?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true }
  if (typeof raw !== 'string') {
    return { ok: false, error: '顶层 name 应为字符串' }
  }
  const name = raw.trim()
  if (!name) {
    return { ok: false, error: '顶层 name 不能为空' }
  }
  if (name.length > TEMPLATE_IMPORT_MAX_SET_NAME_CHARS) {
    return { ok: false, error: `顶层 name 超过上限（最多 ${TEMPLATE_IMPORT_MAX_SET_NAME_CHARS} 个字符）` }
  }
  if (hasControlChar(name)) {
    return { ok: false, error: '顶层 name 不能包含控制字符' }
  }
  return { ok: true, name }
}

export function parseTemplateImportFile(
  raw: string,
): { ok: true; result: TemplateImportParseResult } | { ok: false; error: string; itemErrors: TemplateImportParseError[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { ok: false, error: '文件不是合法 JSON', itemErrors: [] }
  }

  const list: unknown = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).templates
        ?? (parsed as Record<string, unknown>).entries
        ?? (parsed as Record<string, unknown>).index
        ?? (parsed as Record<string, unknown>).items
      : undefined

  if (!Array.isArray(list)) {
    return { ok: false, error: 'JSON 顶层应为数组，或包含 templates/entries/index/items 数组', itemErrors: [] }
  }

  const topLevelName = Array.isArray(parsed)
    ? undefined
    : typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).name
      : undefined
  const parsedName = parseTopLevelSetName(topLevelName)
  if (!parsedName.ok) {
    return { ok: false, error: parsedName.error, itemErrors: [] }
  }

  if (list.length === 0) {
    return { ok: false, error: '模板列表为空', itemErrors: [] }
  }

  if (list.length > TEMPLATE_IMPORT_MAX_ENTRIES) {
    return {
      ok: false,
      error: `模板数量超过上限（最多 ${TEMPLATE_IMPORT_MAX_ENTRIES} 条）`,
      itemErrors: [],
    }
  }

  const entries: SetupTemplateImportEntry[] = []
  const itemErrors: TemplateImportParseError[] = []
  const warnings: string[] = []

  list.forEach((item, index) => {
    const label = `第 ${index + 1} 条`
    if (typeof item !== 'object' || item === null) {
      itemErrors.push({ index, message: `${label}不是对象` })
      return
    }
    const record = item as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const description = typeof record.description === 'string' ? record.description : ''
    const path = typeof record.path === 'string' ? record.path : undefined
    const instruction = typeof record.instruction === 'string' ? record.instruction : ''

    if (!name) {
      itemErrors.push({ index, message: `${label}缺少 name` })
      return
    }
    if (!instruction) {
      itemErrors.push({ index, message: `${label}「${name}」缺少 instruction` })
      return
    }
    if (instruction.length > TEMPLATE_IMPORT_MAX_INSTRUCTION_CHARS) {
      itemErrors.push({ index, message: `${label}「${name}」instruction 超过 128KB 上限` })
      return
    }
    entries.push(path ? { name, description, instruction, path } : { name, description, instruction })
    warnings.push(...varWarnings(name, instruction))
  })

  if (itemErrors.length > 0) {
    return { ok: false, error: `共 ${itemErrors.length} 条模板无法解析`, itemErrors }
  }

  const result: TemplateImportParseResult = { entries, warnings }
  if (parsedName.ok && parsedName.name) result.name = parsedName.name
  return { ok: true, result }
}
