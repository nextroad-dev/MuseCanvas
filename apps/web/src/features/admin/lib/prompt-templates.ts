// Pure helpers for versioned admin prompt-template sets (browser-safe, no DOM).
//
// Import parsing/validation stays in `@/features/setup/lib/templateImport`
// (single standard format); this module only shapes store payloads, export
// download metadata, and preview variable extraction on top of the canonical
// `@musecanvas/contracts` DTOs.
import type {
  ImportPromptTemplateSetInput,
  PromptTemplateSetDetailDto,
  PromptTemplateSetSummaryDto,
} from '@/shared/types'

export interface StagedPromptTemplateEntry {
  name: string
  description: string
  instruction: string
  path?: string
}

export interface StandardPromptTemplateJson {
  name: string
  version: number
  templates: Array<{
    name: string
    description: string
    instruction: string
    path?: string
    sortOrder: number
  }>
}

/** Admin API path for downloading the standard JSON (active set when omitted). */
export function buildPromptTemplateExportUrl(setId?: string | null): string {
  const base = '/api/admin/prompt-templates/export'
  if (!setId) return base
  return `${base}?setId=${encodeURIComponent(setId)}`
}

/** Deterministic download filename for an exported set. */
export function buildPromptTemplateExportFilename(
  set: Pick<PromptTemplateSetSummaryDto, 'name' | 'version'> | null | undefined,
  fallbackId?: string | null,
): string {
  const raw = (set?.name || '').trim() || (fallbackId || '').trim() || 'templates'
  const slug = raw
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9\-_.\u4e00-\u9fa5]/g, '')
    .slice(0, 80) || 'templates'
  const version = set && Number.isFinite(set.version) ? `-v${set.version}` : ''
  return `prompt-templates-${slug}${version}.json`
}

/**
 * Shape locally-parsed entries into the exact import endpoint input.
 * `sortOrder` follows file order so a re-exported set keeps its ordering.
 */
export function buildImportPromptTemplateSetInput(
  entries: StagedPromptTemplateEntry[],
  options: { name?: string; activate?: boolean } = {},
): ImportPromptTemplateSetInput {
  const input: ImportPromptTemplateSetInput = {
    templates: entries.map((entry, index) => {
      const item: ImportPromptTemplateSetInput['templates'][number] = {
        name: entry.name,
        description: entry.description,
        instruction: entry.instruction,
        sortOrder: index,
      }
      if (entry.path) item.path = entry.path
      return item
    }),
  }
  if (options.name?.trim()) input.name = options.name.trim()
  if (options.activate !== undefined) input.activate = options.activate
  else input.activate = true
  return input
}

/** Standard JSON shape shared by the export download (entries in sort order). */
export function toStandardTemplateJson(set: PromptTemplateSetDetailDto): StandardPromptTemplateJson {
  const templates = [...set.entries]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((entry) => {
      const template: StandardPromptTemplateJson['templates'][number] = {
        name: entry.name,
        description: entry.description,
        instruction: entry.instruction,
        sortOrder: entry.sortOrder,
      }
      if (entry.path) template.path = entry.path
      return template
    })
  return { name: set.name, version: set.version, templates }
}

/** Unique `{{variable}}` names in first-appearance order (same syntax as setup parsing). */
export function extractTemplateVariables(instruction: string): string[] {
  const seen = new Set<string>()
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(instruction)) !== null) {
    if (!seen.has(match[1])) seen.add(match[1])
  }
  return [...seen]
}
