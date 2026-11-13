// 提示词模板后台页的纯逻辑：变量元数据、表单校验、导入 JSON 解析与排序。
// 不依赖 React / 网络，页面组件只负责状态与请求。

import { ALLOWED_PROMPT_TEMPLATE_VARS } from '@musecanvas/contracts'
import type {
  ImportPromptTemplateItem,
  PromptTemplateEntryDto,
  PromptTemplateVar,
} from '@musecanvas/contracts'

export const PROMPT_MAX_NAME_LENGTH = 120
export const PROMPT_MAX_DESCRIPTION_LENGTH = 1000
export const PROMPT_MAX_ENTRIES = 100
export const PROMPT_MAX_INSTRUCTION_BYTES = 128 * 1024
export const PROMPT_MAX_SORT_ORDER = 1_000_000

export interface PromptVariableMeta {
  label: string
  sample: string
}

/** 后端允许的模板变量白名单 + 预览用的示例值。 */
export const PROMPT_VARIABLE_META: Record<PromptTemplateVar, PromptVariableMeta> = {
  input_prompt: { label: '用户提示词', sample: '晨雾中的江南水乡，一艘乌篷船停在石阶旁' },
  image_model_name: { label: '图像模型名称', sample: '默认图像模型' },
  image_adapter: { label: '模型适配器', sample: 'openai' },
  size: { label: '画幅尺寸', sample: '1024x1024' },
  quality: { label: '质量档位', sample: 'high' },
  count: { label: '生成张数', sample: '1' },
  input_language: { label: '输入语言', sample: 'zh' },
}

export const PROMPT_VARIABLE_NAMES: string[] = [...ALLOWED_PROMPT_TEMPLATE_VARS]

const VARIABLE_PATTERN = /{{\s*([^{}]+?)\s*}}/g

/** 指令里出现的变量名（去重、保序）。 */
export function extractTemplateVariables(instruction: string): string[] {
  const seen = new Set<string>()
  for (const match of instruction.matchAll(VARIABLE_PATTERN)) {
    const name = (match[1] ?? '').trim()
    if (name) seen.add(name)
  }
  return [...seen]
}

/** 不在白名单里的变量：用于表单即时提示（后端也会拒绝）。 */
export function unknownTemplateVariables(instruction: string): string[] {
  const allowed = new Set(PROMPT_VARIABLE_NAMES)
  return extractTemplateVariables(instruction).filter((name) => !allowed.has(name))
}

/** 去掉合法变量后仍残留 `{{` / `}}`，说明有未闭合的花括号。 */
export function hasStrayTemplateBraces(instruction: string): boolean {
  return /{{|}}/.test(instruction.replace(VARIABLE_PATTERN, ''))
}

export interface PromptEntryFormValues {
  name: string
  description: string
  instruction: string
  sortOrder: string
}

export type PromptEntryFormErrors = Partial<Record<keyof PromptEntryFormValues, string>>

/** 条目表单校验：与后端 `validatePromptTemplateEntry*` 的约束保持一致。 */
export function validatePromptEntryForm(values: PromptEntryFormValues): PromptEntryFormErrors {
  const errors: PromptEntryFormErrors = {}
  const name = values.name.trim()
  const description = values.description.trim()
  const instruction = values.instruction

  if (!name) errors.name = '模板名称不能为空。'
  else if (name.length > PROMPT_MAX_NAME_LENGTH) errors.name = `模板名称不能超过 ${PROMPT_MAX_NAME_LENGTH} 个字符。`
  else if (name.includes('\u0000')) errors.name = '模板名称包含非法字符。'

  if (description.length > PROMPT_MAX_DESCRIPTION_LENGTH) {
    errors.description = `模板描述不能超过 ${PROMPT_MAX_DESCRIPTION_LENGTH} 个字符。`
  }

  if (!instruction.trim()) errors.instruction = '模板内容不能为空。'
  else if (instruction.includes('\u0000')) errors.instruction = '模板内容包含非法字符。'
  else if (new TextEncoder().encode(instruction).length > PROMPT_MAX_INSTRUCTION_BYTES) {
    errors.instruction = '模板内容超出 128KB 上限。'
  } else if (unknownTemplateVariables(instruction).length > 0) {
    errors.instruction = `模板包含不支持的变量：${unknownTemplateVariables(instruction).join('、')}`
  } else if (hasStrayTemplateBraces(instruction)) {
    errors.instruction = '模板存在未闭合的花括号。'
  }

  const sortOrder = values.sortOrder.trim()
  if (sortOrder !== '') {
    const parsed = Number(sortOrder)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > PROMPT_MAX_SORT_ORDER) {
      errors.sortOrder = '排序值必须为 0 到 1000000 之间的整数。'
    }
  }

  return errors
}

export function hasFormErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some(Boolean)
}

export interface ParsedPromptImport {
  name: string
  templates: ImportPromptTemplateItem[]
}

export interface PromptImportParseResult {
  parsed?: ParsedPromptImport
  error?: string
}

function readTemplateItem(item: unknown, index: number): { template?: ImportPromptTemplateItem; error?: string } {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { error: `第 ${index + 1} 条模板不是对象。` }
  }
  const record = item as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name) return { error: `第 ${index + 1} 条模板缺少 name。` }
  const instruction =
    typeof record.instruction === 'string'
      ? record.instruction
      : typeof record.content === 'string'
        ? record.content
        : ''
  if (!instruction.trim()) return { error: `模板「${name}」缺少 instruction。` }
  const template: ImportPromptTemplateItem = { name, instruction }
  if (typeof record.description === 'string') template.description = record.description
  if (typeof record.path === 'string') template.path = record.path
  if (typeof record.sortOrder === 'number') template.sortOrder = record.sortOrder
  return { template }
}

/**
 * 解析导入 JSON：接受文件数组、`{templates|entries:[...]}` 或导出的
 * `{name, version, templates:[{name,description,instruction,path}]}`。
 * 缺字段/类型错误给出可定位到条目的中文信息，不静默丢弃条目。
 */
export function parsePromptImportPayload(raw: string, fallbackName = '导入模板集'): PromptImportParseResult {
  const text = raw.trim()
  if (!text) return { error: '请先选择文件或粘贴 JSON 内容。' }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: 'JSON 解析失败，请检查文件内容是否为合法 JSON。' }
  }
  const root = Array.isArray(data) ? { templates: data } : data
  if (!root || typeof root !== 'object') return { error: '导入内容必须是 JSON 对象或数组。' }
  const record = root as Record<string, unknown>
  const rawTemplates = record.templates ?? record.entries
  if (!Array.isArray(rawTemplates)) return { error: '导入内容缺少 templates 数组。' }
  if (rawTemplates.length === 0 || rawTemplates.length > PROMPT_MAX_ENTRIES) {
    return { error: `模板数量必须在 1 到 ${PROMPT_MAX_ENTRIES} 之间。` }
  }
  const templates: ImportPromptTemplateItem[] = []
  const names = new Set<string>()
  for (let index = 0; index < rawTemplates.length; index += 1) {
    const item = readTemplateItem(rawTemplates[index], index)
    if (item.error || !item.template) return { error: item.error ?? '模板条目无效。' }
    if (names.has(item.template.name)) return { error: `模板名称重复：${item.template.name}` }
    names.add(item.template.name)
    templates.push(item.template)
  }
  const rawName = typeof record.name === 'string' ? record.name.trim() : ''
  return { parsed: { name: rawName || fallbackName, templates } }
}

/** 读取上传的 JSON 文件文本；读取失败抛可直接展示的中文错误。 */
export async function readPromptImportFile(file: File): Promise<string> {
  if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2MB，请拆分模板后再导入。')
  try {
    return await file.text()
  } catch {
    throw new Error('无法读取该文件，请重试或改用粘贴 JSON。')
  }
}

/** 条目按后端排序规则（sortOrder 升序，其次名称）排列。 */
export function sortPromptEntries(entries: PromptTemplateEntryDto[]): PromptTemplateEntryDto[] {
  return [...entries].sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder
    return left.name.localeCompare(right.name, 'zh-CN')
  })
}

/** 变量预览：`{{a}}、{{b}}`；无变量时给出空态文案。 */
export function templateVariableSummary(instruction: string): string {
  const variables = extractTemplateVariables(instruction)
  return variables.length > 0 ? variables.map((name) => `{{${name}}}`).join(' ') : '无变量'
}

/** 条目内容摘要（表格列），压成单行。 */
export function templateInstructionSummary(instruction: string, max = 90): string {
  const single = instruction.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

/** 预览默认值：只填白名单里的变量，未知变量由后端返回未解析标记。 */
export function defaultPreviewValues(variables: string[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (const name of variables) {
    const meta = PROMPT_VARIABLE_META[name as PromptTemplateVar]
    if (meta) values[name] = meta.sample
  }
  return values
}
