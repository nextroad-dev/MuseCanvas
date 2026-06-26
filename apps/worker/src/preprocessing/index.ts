import { db, transaction } from '../../../../packages/database/src/index'
import { callLanguageModel, decryptApiKey, loadPromptTemplateIndex, renderPromptTemplate, type LanguageModelResult, type LanguageProtocol, type ReasoningEffort } from '../../../../packages/providers/src/index'

const OPTIMIZER_PROMPT_VERSION = 'prompt-optimizer-json-v2'
const OPTIMIZER_SCHEMA_NAME = 'prompt_optimization_result'
const CONTROL_PARAM_PATTERNS = [
  /\b\d{3,5}\s*[x×]\s*\d{3,5}\b/i,
  /(?:^|[\s，。；;,.])--(?:ar|aspect|q|quality|size|s)\b/i,
  /(?:尺寸|分辨率|像素|画布大小|输出大小|size|resolution)\s*[:：=为是]*\s*[\w.-]+/i,
  /(?:质量档位|quality)\s*[:：=为是]*\s*(?:auto|low|medium|high|standard|hd|低|中|高)/i,
  /(?:生成|输出)\s*\d+\s*(?:张|幅|个|份)/i,
  /(?:数量|张数|count)\s*[:：=为是]*\s*\d+/i,
  /(?:宽高比|图片比例|画面比例|比例|aspect\s*ratio)\s*[:：=为是]*\s*\d+(?:\.\d+)?\s*[:：]\s*\d+(?:\.\d+)?/i,
]

export function buildPromptOptimizationSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      prompt: { type: 'string' },
    },
    required: ['title', 'prompt'],
  }
}

export function parsePromptOptimizationOutput(text: string): { title: string; prompt: string } {
  const cleaned = text.replace(/\r\n/g, '\n').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { throw new Error('PROMPT_OUTPUT_INVALID') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('PROMPT_OUTPUT_INVALID')
  if (Object.keys(parsed).sort().join(',') !== 'prompt,title') throw new Error('PROMPT_OUTPUT_INVALID')
  const value = parsed as Record<string, unknown>
  const title = typeof value.title === 'string' ? value.title.trim().slice(0, 120) : ''
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : ''
  if (!title || !prompt || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(`${title}\n${prompt}`)) throw new Error('PROMPT_OUTPUT_INVALID')
  return { title, prompt }
}

export function hasConsoleControlParams(prompt: string): boolean {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  return CONTROL_PARAM_PATTERNS.some(pattern => pattern.test(normalized))
}

function assertFinalPromptSafe(prompt: string) {
  if (/(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|authorization)\s*[:=]\s*\S+)/i.test(prompt) || /(?:ignore|reveal).{0,30}(?:system|developer) instructions?/i.test(prompt)) throw new Error('PROMPT_OUTPUT_INVALID')
}

async function recordLanguageModelResult(jobId: string, result: LanguageModelResult) {
  if (!result.providerReferenceId) return
  await db().query("UPDATE generation_jobs SET provider_reference_id=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL", [jobId, result.providerReferenceId])
}

export function buildTemplateSelectorModelOptions(input: { protocol: LanguageProtocol; vendorModelId: string; maxOutputTokens: number }) {
  const maxOutputTokens = Math.min(200, Math.max(1, Math.floor(input.maxOutputTokens) || 200))
  const temperature = input.protocol === 'openai_responses' && /^gpt-5(?:[.-]|$)/i.test(input.vendorModelId) ? undefined : 0
  return { maxOutputTokens, temperature, reasoningEffort: 'none' as ReasoningEffort }
}

function isNoTemplateSelection(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[。.!！\s]/g, '')
  return ['__no_template__', 'no_template', 'none', 'null', '无模板', '无需模板', '没有合适模板', '无合适模板'].includes(normalized)
}

function parseTemplateSelection(text: string, allowedNames: string[]): string | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  if (isNoTemplateSelection(trimmed)) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).templateName || (parsed as Record<string, unknown>).name
      if (value === null) return null
      if (typeof value === 'string' && isNoTemplateSelection(value)) return null
      if (typeof value === 'string' && allowedNames.includes(value.trim())) return value.trim()
    }
  } catch {}
  const exact = allowedNames.find(name => trimmed === name)
  if (exact) return exact
  const contained = allowedNames.find(name => trimmed.includes(name))
  if (contained) return contained
  throw new Error('PROMPT_TEMPLATE_SELECTION_INVALID')
}

export function buildTemplateSelectionSystemPrompt(): string {
  return '你是 MuseCanvas 的提示词模板选择器。你的任务是判断用户需求是否需要套用一个现有模板。只返回模板名称，或在没有合适模板时只返回 __NO_TEMPLATE__。不要解释，不要补充理由，不要复述用户需求。'
}

export function buildTemplateSelectionUserPrompt(input: { prompt: string; modelName: string; templateChoices: string }): string {
  return `用户原始提示词：
${input.prompt}

目标生图模型：${input.modelName}

可选模板：
${input.templateChoices}`
}

export function buildPromptOptimizationSystemPrompt(): string {
  return '你是 MuseCanvas 的前置思考助手。先在内部完成理解、补全与整理，再输出最终 JSON。不要暴露思考过程，不要解释规则，不要输出 Markdown 代码块。JSON 只能包含 title 和 prompt 两个字段。title 写一句简短中文标题；prompt 写一段可直接发送给生图模型的完整提示词。最终 prompt 只保留画面内容、主体、构图、风格、材质、光线、镜头、氛围、文字排版等图像相关信息。不要写尺寸、具体比例、生成数量、质量档位、模型参数或控制台参数。用户如果表达“竖版海报”“横向场景”“宽银幕电影感”等画面意图，可以转化为自然构图描述，但不要写成具体尺寸或比例。不要提及这是模板任务，不要出现占位符。'
}

export function buildPromptOptimizationUserPrompt(input: { prompt: string; renderedTemplate?: string | null }): string {
  return input.renderedTemplate
    ? `模板要求：
${input.renderedTemplate}

用户原始提示词：
${input.prompt}`
    : `没有合适模板。请直接基于用户原始提示词进行前置思考、补全和整理。

用户原始提示词：
${input.prompt}`
}

export function buildPromptOptimizationRepairUserPrompt(input: { prompt: string; renderedTemplate?: string | null; previousPrompt: string }): string {
  return `${buildPromptOptimizationUserPrompt({ prompt: input.prompt, renderedTemplate: input.renderedTemplate })}

上一版最终提示词包含尺寸、比例、数量或质量档位等控制台参数。请在保留画面意图的前提下重新输出 JSON，删除这些控制台参数。

上一版最终提示词：
${input.previousPrompt}`
}

export async function preprocessPrompt(job: any): Promise<string> {
  if (job.optimization_mode !== 'enabled') return job.prompt
  const result = await db().query('SELECT po.*,s.timeout_ms FROM prompt_optimizations po CROSS JOIN prompt_optimization_settings s WHERE po.id=$1 AND po.job_id=$2 AND po.deleted_at IS NULL', [job.prompt_optimization_id, job.id])
  const optimization = result.rows[0]
  if (!optimization) throw new Error('PROMPT_MODEL_NOT_CONFIGURED')
  if (optimization.final_prompt) { await db().query("UPDATE generation_jobs SET phase='prompt_ready',updated_at=now() WHERE id=$1", [job.id]); return optimization.final_prompt }
  const credential = await db().query('SELECT api_key_encrypted,enabled FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL', [optimization.provider_credential_id])
  if (!credential.rows[0]?.enabled || !credential.rows[0].api_key_encrypted) throw new Error('PROMPT_MODEL_NOT_CONFIGURED')
  const protocol = optimization.language_model_protocol_snapshot as LanguageProtocol
  if (!['openai_chat', 'openai_responses', 'anthropic_messages'].includes(protocol)) throw new Error('LANGUAGE_MODEL_PROTOCOL_UNSUPPORTED')
  const reasoningEffort = optimization.language_model_reasoning_effort_snapshot as ReasoningEffort | null
  const baseInvoke = { protocol, vendorModelId: optimization.language_model_vendor_id_snapshot, baseUrl: optimization.language_model_base_url_snapshot, apiKey: decryptApiKey(credential.rows[0].api_key_encrypted), maxOutputTokens: optimization.language_model_max_output_tokens_snapshot, temperature: optimization.language_model_temperature_snapshot === null ? undefined : Number(optimization.language_model_temperature_snapshot), timeoutMs: optimization.timeout_ms }
  const invokeTemplateSelector = (system: string, user: string) => callLanguageModel({ ...baseInvoke, ...buildTemplateSelectorModelOptions({ protocol, vendorModelId: optimization.language_model_vendor_id_snapshot, maxOutputTokens: optimization.language_model_max_output_tokens_snapshot }), system, user })
  const invokePromptOptimizer = (system: string, user: string) => callLanguageModel({ ...baseInvoke, system, user, schemaName: OPTIMIZER_SCHEMA_NAME, schema: buildPromptOptimizationSchema(), reasoningEffort })
  await db().query("UPDATE prompt_optimizations SET status='running',attempt=attempt+1,started_at=COALESCE(started_at,now()),error_code=NULL,optimizer_prompt_version=$2,updated_at=now() WHERE id=$1", [optimization.id, OPTIMIZER_PROMPT_VERSION])
  let instruction = optimization.template_instruction_snapshot as string | null
  if (!instruction) {
    const index = await loadPromptTemplateIndex()
    const validEntries = index.valid ? index.entries.filter(entry => entry.valid && entry.instruction && entry.sha256) : []
    if (!validEntries.length) await db().query("UPDATE generation_jobs SET phase='template_skipped',updated_at=now() WHERE id=$1", [job.id])
    const choices = validEntries.map(entry => `${entry.name}: ${entry.description}`).join('\n')
    if (validEntries.length) {
      const selection = await invokeTemplateSelector(buildTemplateSelectionSystemPrompt(), buildTemplateSelectionUserPrompt({ prompt: optimization.input_prompt, modelName: job.model_name, templateChoices: choices }))
      await recordLanguageModelResult(job.id, selection)
      const name = parseTemplateSelection(selection.text, validEntries.map(entry => entry.name))
      const selected = name ? validEntries.find(entry => entry.name === name) : null
      if (name && (!selected?.instruction || !selected.sha256)) throw new Error('PROMPT_TEMPLATE_SELECTION_INVALID')
      if (selected?.instruction && selected.sha256) {
        instruction = selected.instruction
        await transaction(async client => { await client.query('UPDATE prompt_optimizations SET template_name_snapshot=$1,template_description_snapshot=$2,template_path_snapshot=$3,template_instruction_snapshot=$4,template_content_sha256=$5,updated_at=now() WHERE id=$6 AND template_instruction_snapshot IS NULL', [selected.name, selected.description, selected.path, selected.instruction, selected.sha256, optimization.id]); await client.query("UPDATE generation_jobs SET phase='template_selected',updated_at=now() WHERE id=$1", [job.id]) })
      } else {
        await db().query("UPDATE generation_jobs SET phase='template_skipped',updated_at=now() WHERE id=$1", [job.id])
      }
    }
  }
  const rendered = instruction ? renderPromptTemplate(instruction, { input_prompt: optimization.input_prompt, image_model_name: job.model_name, image_adapter: job.adapter, size: job.size, quality: job.quality || '', count: job.count, input_language: optimization.input_language }) : ''
  await db().query("UPDATE generation_jobs SET phase='prompt_optimizing',updated_at=now() WHERE id=$1", [job.id])
  const renderedTemplate = instruction ? rendered : null
  const optimized = await invokePromptOptimizer(buildPromptOptimizationSystemPrompt(), buildPromptOptimizationUserPrompt({ prompt: optimization.input_prompt, renderedTemplate }))
  await recordLanguageModelResult(job.id, optimized)
  let parsed = parsePromptOptimizationOutput(optimized.text)
  assertFinalPromptSafe(parsed.prompt)
  if (hasConsoleControlParams(parsed.prompt)) {
    const repaired = await invokePromptOptimizer(buildPromptOptimizationSystemPrompt(), buildPromptOptimizationRepairUserPrompt({ prompt: optimization.input_prompt, renderedTemplate, previousPrompt: parsed.prompt }))
    await recordLanguageModelResult(job.id, repaired)
    parsed = parsePromptOptimizationOutput(repaired.text)
    assertFinalPromptSafe(parsed.prompt)
    if (hasConsoleControlParams(parsed.prompt)) throw new Error('PROMPT_OUTPUT_INVALID')
  }
  const finalPrompt = parsed.prompt
  await transaction(async client => { await client.query("UPDATE prompt_optimizations SET status='succeeded',final_prompt=$1,error_code=NULL,completed_at=now(),updated_at=now() WHERE id=$2", [finalPrompt, optimization.id]); await client.query("UPDATE generation_jobs SET title=$1,phase='prompt_ready',updated_at=now() WHERE id=$2", [parsed.title, job.id]) })
  return finalPrompt
}
