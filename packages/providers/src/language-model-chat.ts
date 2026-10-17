import { DefaultSafeHttpClient } from './core/http'
import { NormalizedProviderError } from './core/errors'
import { isPrivateProviderHost } from './core/url-guard'
import type { DecodedCredential, LanguageProtocol, ReasoningEffort } from './core/types'
import { isBuiltinLanguagePluginKey } from './language-model'

export type LanguageModelChatTool = { name: string; description?: string; parameters: Record<string, unknown> }
export type LanguageModelChatToolCall = { id: string; name: string; arguments: Record<string, unknown> }
/** Retain block order when replaying an Anthropic assistant response. */
export type LanguageModelChatContentBlock = { type: 'text'; text: string } | { type: 'tool_call'; toolCall: LanguageModelChatToolCall }
export type LanguageModelChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LanguageModelChatToolCall[]; contentBlocks?: LanguageModelChatContentBlock[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean }
export type LanguageModelChatInput = {
  protocol: LanguageProtocol
  vendorModelId: string
  baseUrl?: string
  apiKey?: string
  credential?: DecodedCredential
  pluginId?: string
  pluginVersion?: string
  system: string
  messages: LanguageModelChatMessage[]
  tools?: LanguageModelChatTool[]
  maxOutputTokens: number
  temperature?: number
  reasoningEffort?: ReasoningEffort | null
  timeoutMs: number
  signal?: AbortSignal
}
export type LanguageModelChatResult = {
  text: string
  toolCalls: LanguageModelChatToolCall[]
  contentBlocks: LanguageModelChatContentBlock[]
  usage: { inputTokens?: number; outputTokens?: number }
  referenceId?: string
}
export type LanguageModelChatErrorCode =
  | 'LANGUAGE_MODEL_CANCELED' | 'LANGUAGE_MODEL_TIMEOUT' | 'LANGUAGE_MODEL_RESPONSE_INVALID'
  | 'LANGUAGE_MODEL_RESPONSE_TOO_LARGE' | 'LANGUAGE_MODEL_REJECTED' | 'LANGUAGE_MODEL_TEMPORARY_ERROR'
  | 'LANGUAGE_MODEL_UNSUPPORTED'
/** No upstream bodies, prompts, URLs, credentials or arbitrary exception messages are retained. */
export class LanguageModelChatError extends Error {
  constructor(readonly code: LanguageModelChatErrorCode, readonly status?: number) {
    super(code)
    this.name = 'LanguageModelChatError'
  }
}
function fail(code: LanguageModelChatErrorCode): never { throw new LanguageModelChatError(code) }
function invalid(): never { return fail('LANGUAGE_MODEL_RESPONSE_INVALID') }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)

function validateJson(value: unknown, depth = 0): void {
  if (depth > 100) invalid()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) { for (const item of value) validateJson(item, depth + 1); return }
  if (!object(value)) invalid()
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid()
    validateJson(item, depth + 1)
  }
}
function argumentsObject(value: unknown): Record<string, unknown> {
  if (!object(value)) invalid()
  validateJson(value)
  return value
}
function toolNames(tools: LanguageModelChatTool[]): Set<string> {
  const names = new Set<string>()
  for (const tool of tools) {
    if (!object(tool) || !identifier(tool.name) || names.has(tool.name) || (tool.description !== undefined && typeof tool.description !== 'string')) invalid()
    argumentsObject(tool.parameters)
    names.add(tool.name)
  }
  return names
}
function validateCall(value: unknown, names: Set<string>, ids: Set<string>): LanguageModelChatToolCall {
  if (!object(value) || !identifier(value.id) || !identifier(value.name) || !names.has(value.name) || ids.has(value.id)) invalid()
  const args = argumentsObject(value.arguments)
  ids.add(value.id)
  return { id: value.id, name: value.name, arguments: args }
}
function validateProtocol(protocol: LanguageProtocol): void {
  if (protocol !== 'openai_chat' && protocol !== 'anthropic_messages') fail('LANGUAGE_MODEL_UNSUPPORTED')
}
function validateConfig(input: LanguageModelChatInput): void {
  validateProtocol(input.protocol)
  if (input.pluginId || input.pluginVersion) {
    if (!isBuiltinLanguagePluginKey(input.pluginId, input.pluginVersion)
      || input.pluginId !== (input.protocol === 'openai_chat' ? 'openai-language' : 'anthropic-language')) fail('LANGUAGE_MODEL_UNSUPPORTED')
  }
  if (input.credential && input.credential.schema !== 'legacy-api-key-v1') fail('LANGUAGE_MODEL_UNSUPPORTED')
  if (input.protocol === 'anthropic_messages' && input.reasoningEffort && input.reasoningEffort !== 'none') fail('LANGUAGE_MODEL_UNSUPPORTED')
  if (typeof input.system !== 'string' || !input.vendorModelId?.trim() || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0
    || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 2_147_483_647
    || (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2))
    || (input.reasoningEffort && !['none', 'low', 'medium', 'high', 'xhigh'].includes(input.reasoningEffort))) fail('LANGUAGE_MODEL_REJECTED')
}

/** A history must pair every assistant call with exactly one result before the next turn. */
function validateHistory(messages: LanguageModelChatMessage[], names: Set<string>): Set<string> {
  if (!Array.isArray(messages) || !messages.length) invalid()
  const ids = new Set<string>()
  const pending = new Set<string>()
  for (const message of messages) {
    if (!object(message) || typeof message.content !== 'string') invalid()
    if (message.role === 'tool') {
      if (!pending.delete(message.toolCallId) || (message.isError !== undefined && typeof message.isError !== 'boolean')) invalid()
      continue
    }
    if (pending.size) invalid()
    if (message.role === 'user') continue
    if (message.role !== 'assistant') invalid()
    if (message.toolCalls !== undefined && !Array.isArray(message.toolCalls)) invalid()
    const calls = (message.toolCalls || []).map(call => validateCall(call, names, ids))
    for (const call of calls) pending.add(call.id)
    if (message.contentBlocks !== undefined) {
      if (!Array.isArray(message.contentBlocks)) invalid()
      const blockCalls: LanguageModelChatToolCall[] = []
      const texts: string[] = []
      for (const block of message.contentBlocks) {
        if (!object(block)) invalid()
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        else if (block.type === 'tool_call') blockCalls.push(validateCall(block.toolCall, names, new Set(blockCalls.map(call => call.id))))
        else invalid()
      }
      if (texts.join('') !== message.content || JSON.stringify(blockCalls) !== JSON.stringify(calls)) invalid()
    }
    if (!message.content.trim() && !calls.length) invalid()
  }
  if (pending.size) invalid()
  return ids
}

export function buildLanguageModelChatRequest(input: LanguageModelChatInput): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  validateConfig(input)
  const tools = input.tools ?? []
  validateHistory(input.messages, toolNames(tools))
  const key = input.credential?.apiKey ?? input.apiKey
  if (typeof key !== 'string' || !key.trim()) fail('LANGUAGE_MODEL_REJECTED')
  const base = (input.baseUrl || input.credential?.baseUrl || (input.protocol === 'openai_chat' ? 'https://api.openai.com' : 'https://api.anthropic.com')).replace(/\/$/, '')
  let parsed: URL
  try { parsed = new URL(base) } catch { return fail('LANGUAGE_MODEL_REJECTED') }
  // Configured host widening follows the existing LLM path, never widening redirect hosts.
  if (parsed.username || parsed.password || parsed.search || parsed.hash) fail('LANGUAGE_MODEL_REJECTED')
  const v1 = base.endsWith('/v1') ? base : `${base}/v1`
  const common = { model: input.vendorModelId, stream: false, ...(input.temperature === undefined ? {} : { temperature: input.temperature }) }
  if (input.protocol === 'openai_chat') {
    const messages = input.messages.map(message => {
      if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
      if (message.role === 'user') return { role: 'user', content: message.content }
      return { role: 'assistant', content: message.content || null, ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) }
    })
    return { url: `${v1}/chat/completions`, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: {
      ...common, messages: [{ role: 'developer', content: input.system }, ...messages], max_completion_tokens: input.maxOutputTokens,
      ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
      ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
    } }
  }
  const messages: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = []
  for (const message of input.messages) {
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content, ...(message.isError ? { is_error: true } : {}) }
      const previous = messages.at(-1)
      if (previous?.role === 'user') previous.content.push(block)
      else messages.push({ role: 'user', content: [block] })
    } else if (message.role === 'user') messages.push({ role: 'user', content: [{ type: 'text', text: message.content }] })
    else {
      const blocks = message.contentBlocks ?? [ ...(message.content ? [{ type: 'text' as const, text: message.content }] : []), ...(message.toolCalls ?? []).map(toolCall => ({ type: 'tool_call' as const, toolCall })) ]
      messages.push({ role: 'assistant', content: blocks.map(block => block.type === 'text' ? { type: 'text', text: block.text } : { type: 'tool_use', id: block.toolCall.id, name: block.toolCall.name, input: block.toolCall.arguments }) })
    }
  }
  return { url: `${v1}/messages`, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: {
    ...common, system: input.system, messages, max_tokens: input.maxOutputTokens,
    ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
  } }
}

export function parseLanguageModelChatResponse(protocol: LanguageProtocol, raw: unknown, tools: LanguageModelChatTool[] = [], previousToolCallIds: readonly string[] = []): LanguageModelChatResult {
  validateProtocol(protocol)
  const names = toolNames(tools)
  const ids = new Set(previousToolCallIds)
  if (!object(raw)) invalid()
  const toolCalls: LanguageModelChatToolCall[] = []
  const contentBlocks: LanguageModelChatContentBlock[] = []
  const addText = (text: unknown) => { if (typeof text !== 'string') invalid(); contentBlocks.push({ type: 'text', text }) }
  const addCall = (call: unknown) => { const parsed = validateCall(call, names, ids); toolCalls.push(parsed); contentBlocks.push({ type: 'tool_call', toolCall: parsed }) }
  let stop: unknown
  if (protocol === 'openai_chat') {
    if (!Array.isArray(raw.choices) || raw.choices.length !== 1 || !object(raw.choices[0]) || !object(raw.choices[0].message)) invalid()
    const choice = raw.choices[0]
    const message = choice.message as Record<string, unknown>
    if (message.role !== 'assistant' || message.refusal || message.function_call) invalid()
    if (message.content !== undefined && message.content !== null) addText(message.content)
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) invalid()
      for (const call of message.tool_calls) {
        if (!object(call) || call.type !== 'function' || !object(call.function) || typeof call.function.arguments !== 'string') invalid()
        let args: unknown
        try { args = JSON.parse(call.function.arguments) } catch { return invalid() }
        addCall({ id: call.id, name: call.function.name, arguments: args })
      }
    }
    stop = choice.finish_reason
    if (stop !== (toolCalls.length ? 'tool_calls' : 'stop')) invalid()
  } else {
    if (raw.type !== 'message' || raw.role !== 'assistant' || !Array.isArray(raw.content)) invalid()
    for (const block of raw.content) {
      if (!object(block)) invalid()
      if (block.type === 'text') addText(block.text)
      else if (block.type === 'tool_use') addCall({ id: block.id, name: block.name, arguments: block.input })
      else invalid()
    }
    stop = raw.stop_reason
    if (toolCalls.length ? stop !== 'tool_use' : !['end_turn', 'stop_sequence'].includes(stop as string)) invalid()
  }
  const text = contentBlocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  if (!text.trim() && !toolCalls.length) invalid()
  const usage: LanguageModelChatResult['usage'] = {}
  if (raw.usage !== undefined) {
    if (!object(raw.usage)) invalid()
    for (const [target, source] of [['inputTokens', protocol === 'openai_chat' ? 'prompt_tokens' : 'input_tokens'], ['outputTokens', protocol === 'openai_chat' ? 'completion_tokens' : 'output_tokens']] as const) {
      const value = raw.usage[source]
      if (value !== undefined) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(); usage[target] = value }
    }
  }
  if (raw.id !== undefined && !identifier(raw.id)) invalid()
  return { text, toolCalls, contentBlocks, usage, ...(typeof raw.id === 'string' ? { referenceId: raw.id } : {}) }
}

const http = new DefaultSafeHttpClient({ pluginId: 'language-model-chat', version: '1.0.0', allowedHosts: ['api.openai.com', 'api.anthropic.com'], fetchImpl: (url, init) => globalThis.fetch(url, init) })
export async function callLanguageModelChat(input: LanguageModelChatInput): Promise<LanguageModelChatResult> {
  if (input.signal?.aborted) fail('LANGUAGE_MODEL_CANCELED')
  const request = buildLanguageModelChatRequest(input)
  if (process.env.ALLOW_PRIVATE_PROVIDER_BASE_URL !== 'true' && isPrivateProviderHost(new URL(request.url).hostname.replace(/^\[|\]$/g, ''))) fail('LANGUAGE_MODEL_REJECTED')
  try {
    const response = await http.request(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify(request.body), timeoutMs: input.timeoutMs, signal: input.signal,
      maxBytes: 10_000_000, allowedHosts: [new URL(request.url).hostname], allowInsecureProtocol: process.env.ALLOW_INSECURE_PROVIDER_BASE_URL === 'true',
    })
    // Consume even rejection bodies with the same bounded reader/deadline; never expose their contents.
    const text = await response.text()
    if (!response.ok) throw new LanguageModelChatError(response.status === 408 || response.status === 429 || response.status >= 500 ? 'LANGUAGE_MODEL_TEMPORARY_ERROR' : 'LANGUAGE_MODEL_REJECTED', response.status)
    let raw: unknown
    try { raw = JSON.parse(text) } catch { return invalid() }
    const historyIds = validateHistory(input.messages, toolNames(input.tools ?? []))
    return parseLanguageModelChatResponse(input.protocol, raw, input.tools, [...historyIds])
  } catch (error) {
    if (error instanceof LanguageModelChatError) throw error
    if (error instanceof Error && error.name === 'AbortError') fail('LANGUAGE_MODEL_CANCELED')
    if (error instanceof NormalizedProviderError) {
      if (error.diagnostic.code === 'PROVIDER_TIMEOUT') fail('LANGUAGE_MODEL_TIMEOUT')
      if (error.diagnostic.code === 'OUTPUT_READ_FAILED') fail('LANGUAGE_MODEL_RESPONSE_TOO_LARGE')
      if (error.diagnostic.code === 'UNSAFE_URL') fail('LANGUAGE_MODEL_REJECTED')
    }
    fail('LANGUAGE_MODEL_TEMPORARY_ERROR')
  }
}
