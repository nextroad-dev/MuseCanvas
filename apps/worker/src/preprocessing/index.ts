import { db, transaction } from '../../../../packages/database/src/index'
import { callLanguageModel, decryptApiKey, loadPromptTemplateIndex, renderPromptTemplate, type LanguageProtocol, type ReasoningEffort } from '../../../../packages/providers/src/index'

function parseThinkingOutput(text: string): { title: string; prompt: string } {
  const cleaned = text.replace(/\r\n/g, '\n').trim()
  const titleMatch = cleaned.match(/(?:^|\n)\s*(?:标题|简介标题|Title)\s*[:：]\s*(.+)/i)
  const promptMatch = cleaned.match(/(?:^|\n)\s*(?:提示词|Prompt)\s*[:：]\s*([\s\S]+)/i)
  const title = (titleMatch?.[1] || cleaned.split('\n')[0] || '生成提示词').trim().slice(0, 120)
  const prompt = (promptMatch?.[1] || cleaned.split('\n').slice(1).join('\n') || cleaned).trim()
  if (!prompt || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) throw new Error('PROMPT_OUTPUT_INVALID')
  return { title: title || '生成提示词', prompt }
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
  const invoke = (system: string, user: string) => callLanguageModel({ protocol, vendorModelId: optimization.language_model_vendor_id_snapshot, baseUrl: optimization.language_model_base_url_snapshot, apiKey: decryptApiKey(credential.rows[0].api_key_encrypted), system, user, maxOutputTokens: optimization.language_model_max_output_tokens_snapshot, temperature: optimization.language_model_temperature_snapshot === null ? undefined : Number(optimization.language_model_temperature_snapshot), reasoningEffort, timeoutMs: optimization.timeout_ms })
  await db().query("UPDATE prompt_optimizations SET status='running',attempt=attempt+1,started_at=COALESCE(started_at,now()),error_code=NULL,updated_at=now() WHERE id=$1", [optimization.id])
  let instruction = optimization.template_instruction_snapshot as string | null
  if (!instruction) {
    const index = await loadPromptTemplateIndex()
    const validEntries = index.valid ? index.entries.filter(entry => entry.valid && entry.instruction && entry.sha256) : []
    if (!validEntries.length) await db().query("UPDATE generation_jobs SET phase='template_skipped',updated_at=now() WHERE id=$1", [job.id])
    const choices = validEntries.map(entry => `${entry.name}: ${entry.description}`).join('\n')
    if (validEntries.length) {
      const selection = await invoke('你是 MuseCanvas 的提示词模板选择器。先判断用户需求是否适合某个模板。只输出最匹配的模板名称，或在没有合适模板时只输出 __NO_TEMPLATE__。可以只输出模板名，也可以输出 {"templateName":"模板名"} 或 {"templateName":null}，不要解释。', `用户原始提示词：\n${optimization.input_prompt}\n\n图像参数：模型=${job.model_name}，尺寸=${job.size}，质量=${job.quality || 'auto'}，数量=${job.count}\n\n可选模板：\n${choices}`)
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
  const optimized = await invoke('你是 MuseCanvas 的前置思考助手。只输出两段纯文本，不要 JSON，不要 Markdown 代码块，不要字段之外的解释。格式必须为：\n标题：一句简短中文简介标题\n提示词：一段可以直接发送给生图模型的完整提示词', `${instruction ? `模板要求：\n${rendered}\n\n` : '没有合适模板。请直接基于用户原始提示词进行前置思考和生图提示词整理。\n\n'}用户原始提示词：\n${optimization.input_prompt}\n\n图像参数：模型=${job.model_name}，尺寸=${job.size}，质量=${job.quality || 'auto'}，数量=${job.count}`)
  const parsed = parseThinkingOutput(optimized.text)
  const finalPrompt = parsed.prompt
  if (/(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|authorization)\s*[:=]\s*\S+)/i.test(finalPrompt) || /(?:ignore|reveal).{0,30}(?:system|developer) instructions?/i.test(finalPrompt)) throw new Error('PROMPT_OUTPUT_INVALID')
  await transaction(async client => { await client.query("UPDATE prompt_optimizations SET status='succeeded',final_prompt=$1,error_code=NULL,completed_at=now(),updated_at=now() WHERE id=$2", [finalPrompt, optimization.id]); await client.query("UPDATE generation_jobs SET title=$1,phase='prompt_ready',updated_at=now() WHERE id=$2", [parsed.title, job.id]) })
  return finalPrompt
}
