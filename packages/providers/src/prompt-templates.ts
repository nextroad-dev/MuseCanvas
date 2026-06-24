import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

const MAX_INDEX_BYTES = 1_000_000
const MAX_TEMPLATE_BYTES = 128_000
const MAX_TEMPLATES = 100
const VARIABLES = new Set(['input_prompt', 'image_model_name', 'image_adapter', 'size', 'quality', 'count', 'input_language'])

export type PromptTemplateEntry = {
  name: string
  description: string
  path: string
  resolvedPath: string
  fileExists: boolean
  valid: boolean
  errorCode?: string
  instruction?: string
  sha256?: string
}

export type PromptTemplateIndex = {
  indexPath: string
  rootDirectory: string
  readable: boolean
  loadedAt: string
  entryCount: number
  valid: boolean
  errorCode?: string
  entries: PromptTemplateEntry[]
}

function invalidEntry(raw: unknown, errorCode: string): PromptTemplateEntry {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return { name: typeof value.name === 'string' ? value.name : '', description: typeof value.description === 'string' ? value.description : '', path: typeof value.path === 'string' ? value.path : '', resolvedPath: '', fileExists: false, valid: false, errorCode }
}

async function loadEntry(raw: unknown, rootReal: string): Promise<PromptTemplateEntry> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalidEntry(raw, 'PROMPT_TEMPLATE_INDEX_INVALID')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).sort().join(',') !== 'description,name,path') return invalidEntry(raw, 'PROMPT_TEMPLATE_INDEX_INVALID')
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || typeof value.description !== 'string' || !value.description.trim() || value.description.length > 1000 || typeof value.path !== 'string' || !value.path) return invalidEntry(raw, 'PROMPT_TEMPLATE_INDEX_INVALID')
  const relative = value.path.replaceAll('\\', '/')
  if (path.isAbsolute(value.path) || relative.split('/').includes('..') || path.extname(relative).toLowerCase() !== '.md') return { ...invalidEntry(raw, 'PROMPT_TEMPLATE_FILE_INVALID'), resolvedPath: relative }
  const candidate = path.resolve(rootReal, relative)
  try {
    const target = await realpath(candidate)
    if (target !== rootReal && !target.startsWith(`${rootReal}${path.sep}`)) return { ...invalidEntry(raw, 'PROMPT_TEMPLATE_FILE_INVALID'), resolvedPath: relative, fileExists: true }
    const info = await stat(target)
    if (!info.isFile() || info.size === 0 || info.size > MAX_TEMPLATE_BYTES) return { ...invalidEntry(raw, 'PROMPT_TEMPLATE_FILE_INVALID'), resolvedPath: relative, fileExists: info.isFile() }
    const instruction = await readFile(target, 'utf8')
    if (instruction.includes('\0')) return { ...invalidEntry(raw, 'PROMPT_TEMPLATE_FILE_INVALID'), resolvedPath: relative, fileExists: true }
    const variables = [...instruction.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(match => match[1].trim())
    if (variables.some(variable => !VARIABLES.has(variable)) || /{{|}}/.test(instruction.replace(/{{\s*([^{}]+?)\s*}}/g, ''))) return { ...invalidEntry(raw, 'PROMPT_TEMPLATE_FILE_INVALID'), resolvedPath: relative, fileExists: true }
    return { name: value.name.trim(), description: value.description.trim(), path: relative, resolvedPath: path.relative(rootReal, target).replaceAll(path.sep, '/'), fileExists: true, valid: true, instruction, sha256: createHash('sha256').update(instruction).digest('hex') }
  } catch {
    return { ...invalidEntry(raw, 'PROMPT_TEMPLATE_FILE_INVALID'), resolvedPath: relative }
  }
}

export async function loadPromptTemplateIndex(indexPath = process.env.PROMPT_TEMPLATE_INDEX_PATH || ''): Promise<PromptTemplateIndex> {
  const loadedAt = new Date().toISOString()
  const absolute = path.isAbsolute(indexPath) ? path.normalize(indexPath) : ''
  const fallback = { indexPath: absolute || indexPath, rootDirectory: absolute ? path.dirname(absolute) : '', readable: false, loadedAt, entryCount: 0, valid: false, entries: [] as PromptTemplateEntry[] }
  if (!absolute || path.basename(absolute).toLowerCase() !== 'index.json') return { ...fallback, errorCode: 'PROMPT_TEMPLATE_INDEX_UNAVAILABLE' }
  try {
    const info = await stat(absolute)
    if (!info.isFile() || info.size === 0 || info.size > MAX_INDEX_BYTES) return { ...fallback, errorCode: 'PROMPT_TEMPLATE_INDEX_INVALID' }
    const indexReal = await realpath(absolute)
    const rootReal = await realpath(path.dirname(indexReal))
    const parsed = JSON.parse(await readFile(indexReal, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join(',') !== 'templates' || !Array.isArray((parsed as { templates?: unknown }).templates)) return { ...fallback, indexPath: indexReal, rootDirectory: rootReal, readable: true, errorCode: 'PROMPT_TEMPLATE_INDEX_INVALID' }
    const rawEntries = (parsed as { templates: unknown[] }).templates
    if (!rawEntries.length || rawEntries.length > MAX_TEMPLATES) return { ...fallback, indexPath: indexReal, rootDirectory: rootReal, readable: true, entryCount: rawEntries.length, errorCode: 'PROMPT_TEMPLATE_INDEX_INVALID' }
    const entries = await Promise.all(rawEntries.map(entry => loadEntry(entry, rootReal)))
    const names = new Set<string>()
    for (const entry of entries) {
      if (names.has(entry.name)) { entry.valid = false; entry.errorCode = 'PROMPT_TEMPLATE_INDEX_INVALID' }
      names.add(entry.name)
    }
    const valid = entries.every(entry => entry.valid)
    return { indexPath: indexReal, rootDirectory: rootReal, readable: true, loadedAt, entryCount: entries.length, valid, errorCode: valid ? undefined : 'PROMPT_TEMPLATE_INDEX_INVALID', entries }
  } catch (error) {
    return { ...fallback, readable: error instanceof SyntaxError, errorCode: error instanceof SyntaxError ? 'PROMPT_TEMPLATE_INDEX_INVALID' : 'PROMPT_TEMPLATE_INDEX_UNAVAILABLE' }
  }
}

export function promptTemplateIndexDto(index: PromptTemplateIndex) {
  return { ...index, entries: index.entries.map(({ instruction: _instruction, sha256: _sha256, ...entry }) => entry) }
}

export function renderPromptTemplate(instruction: string, values: Record<string, string | number>): string {
  return instruction.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, variable: string) => {
    if (!VARIABLES.has(variable)) throw new Error('PROMPT_TEMPLATE_FILE_INVALID')
    return String(values[variable] ?? '')
  })
}
