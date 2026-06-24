export type LanguageProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages'
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'
export type LanguageModelInput = { protocol: LanguageProtocol; vendorModelId: string; baseUrl?: string; apiKey: string; system: string; user: string; schemaName?: string; schema?: Record<string, unknown>; maxOutputTokens: number; temperature?: number; reasoningEffort?: ReasoningEffort | null; timeoutMs: number }
export type LanguageModelResult = { text: string; providerReferenceId?: string; inputTokens?: number; outputTokens?: number }

function endpoint(protocol: LanguageProtocol, configured?: string): string {
  const fallback = protocol === 'anthropic_messages' ? 'https://api.anthropic.com' : 'https://api.openai.com'
  const base = (configured || fallback).replace(/\/$/, '')
  const v1 = base.endsWith('/v1') ? base : `${base}/v1`
  if (protocol === 'openai_chat') return `${v1}/chat/completions`
  if (protocol === 'openai_responses') return `${v1}/responses`
  return `${v1}/messages`
}

export function buildLanguageModelRequest(input: LanguageModelInput): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const commonSchema = input.schema && input.schemaName ? { name: input.schemaName, strict: true, schema: input.schema } : null
  if (input.protocol === 'openai_chat') return { url: endpoint(input.protocol, input.baseUrl), headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' }, body: { model: input.vendorModelId, messages: [{ role: 'developer', content: input.system }, { role: 'user', content: input.user }], ...(commonSchema ? { response_format: { type: 'json_schema', json_schema: commonSchema } } : {}), max_completion_tokens: input.maxOutputTokens, ...(input.temperature === undefined ? {} : { temperature: input.temperature }) } }
  if (input.protocol === 'openai_responses') return { url: endpoint(input.protocol, input.baseUrl), headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' }, body: { model: input.vendorModelId, instructions: input.system, input: input.user, ...(commonSchema ? { text: { format: { type: 'json_schema', ...commonSchema } } } : {}), max_output_tokens: input.maxOutputTokens, ...(input.temperature === undefined ? {} : { temperature: input.temperature }), ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}) } }
  return { url: endpoint(input.protocol, input.baseUrl), headers: { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: { model: input.vendorModelId, system: input.system, messages: [{ role: 'user', content: input.user }], max_tokens: input.maxOutputTokens, ...(commonSchema ? { output_config: { format: { type: 'json_schema', schema: input.schema } } } : {}), ...(input.temperature === undefined ? {} : { temperature: input.temperature }) } }
}

export function parseLanguageModelResponse(protocol: LanguageProtocol, raw: unknown): LanguageModelResult {
  if (!raw || typeof raw !== 'object') throw new Error('LANGUAGE_MODEL_RESPONSE_INVALID')
  const value = raw as any
  if (protocol === 'openai_chat') {
    const text = value.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new Error('LANGUAGE_MODEL_RESPONSE_INVALID')
    return { text, providerReferenceId: typeof value.id === 'string' ? value.id : undefined, inputTokens: value.usage?.prompt_tokens, outputTokens: value.usage?.completion_tokens }
  }
  if (protocol === 'openai_responses') {
    const text = value.output?.flatMap((item: any) => item?.role === 'assistant' ? item.content || [] : []).find((item: any) => item?.type === 'output_text')?.text
    if (typeof text !== 'string') throw new Error('LANGUAGE_MODEL_RESPONSE_INVALID')
    return { text, providerReferenceId: typeof value.id === 'string' ? value.id : undefined, inputTokens: value.usage?.input_tokens, outputTokens: value.usage?.output_tokens }
  }
  const text = value.content?.find((item: any) => item?.type === 'text')?.text
  if (typeof text !== 'string' || (value.stop_reason && !['end_turn', 'stop_sequence'].includes(value.stop_reason))) throw new Error('LANGUAGE_MODEL_RESPONSE_INVALID')
  return { text, providerReferenceId: typeof value.id === 'string' ? value.id : undefined, inputTokens: value.usage?.input_tokens, outputTokens: value.usage?.output_tokens }
}

export async function callLanguageModel(input: LanguageModelInput): Promise<LanguageModelResult> {
  const request = buildLanguageModelRequest(input)
  let response: Response
  try { response = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), redirect: 'error', signal: AbortSignal.timeout(input.timeoutMs) }) }
  catch { throw new Error('PROMPT_OPTIMIZATION_TEMPORARY_ERROR') }
  if (!response.ok) {
    if (response.status === 408 || response.status === 429 || response.status >= 500) throw new Error('PROMPT_OPTIMIZATION_TEMPORARY_ERROR')
    throw new Error('PROMPT_OPTIMIZATION_REJECTED')
  }
  try { return parseLanguageModelResponse(input.protocol, await response.json()) } catch (error) { if (error instanceof Error && error.message === 'LANGUAGE_MODEL_RESPONSE_INVALID') throw error; throw new Error('LANGUAGE_MODEL_RESPONSE_INVALID') }
}

export function parseExactJsonString(text: string, key: string, maxChars: number): string {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error(key === 'templateName' ? 'PROMPT_TEMPLATE_SELECTION_INVALID' : 'PROMPT_OUTPUT_INVALID') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join(',') !== key) throw new Error(key === 'templateName' ? 'PROMPT_TEMPLATE_SELECTION_INVALID' : 'PROMPT_OUTPUT_INVALID')
  const output = (parsed as Record<string, unknown>)[key]
  if (typeof output !== 'string' || !output.trim() || output.length > maxChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(output)) throw new Error(key === 'templateName' ? 'PROMPT_TEMPLATE_SELECTION_INVALID' : 'PROMPT_OUTPUT_INVALID')
  return output.trim()
}
