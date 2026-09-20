import { DefaultSafeHttpClient } from './core/http'
import { NormalizedProviderError } from './core/errors'
import { globalPluginRegistry } from './core/plugin-registry'
import { isNormalizedProviderCode, normalizedCodeToLanguageError } from './core/language-errors'
import { isPrivateProviderHost } from './core/url-guard'
import type {
  DecodedCredential,
  LanguageCompletionResult,
  LanguageProviderPlugin,
  LanguageRequest,
  NormalizedProviderErrorDiagnostic,
  ProviderConfig,
  SafeHttpResponse,
} from './core/types'
import type { LanguageProtocol, ReasoningEffort } from './core/types'

// LanguageProtocol / ReasoningEffort now live in core/types.ts as the single source
// of truth; re-exported here under the same public names so existing importers are unchanged.
export type { LanguageProtocol, ReasoningEffort }

export type LanguageModelInput = { protocol: LanguageProtocol; vendorModelId: string; baseUrl?: string; apiKey: string; system: string; user: string; schemaName?: string; schema?: Record<string, unknown>; maxOutputTokens: number; temperature?: number; reasoningEffort?: ReasoningEffort | null; timeoutMs: number; pluginId?: string; pluginVersion?: string; credential?: DecodedCredential }
export type LanguageModelResult = { text: string; providerReferenceId?: string; inputTokens?: number; outputTokens?: number }
export type LanguageModelErrorDiagnostic = { adapter: 'openai' | 'anthropic'; status: number; statusText: string; endpoint: string; detail: string; occurredAt: string; providerReferenceId?: string }

export class LanguageModelHttpError extends Error {
  diagnostic: LanguageModelErrorDiagnostic
  constructor(code: 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR' | 'PROMPT_OPTIMIZATION_REJECTED', diagnostic: LanguageModelErrorDiagnostic) {
    super(code)
    this.name = 'LanguageModelHttpError'
    this.diagnostic = diagnostic
  }
}

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

function adapterForProtocol(protocol: LanguageProtocol): LanguageModelErrorDiagnostic['adapter'] {
  return protocol === 'anthropic_messages' ? 'anthropic' : 'openai'
}

function sanitizeProviderDetail(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .slice(0, 1200)
}

function providerReferenceId(headers: Headers): string | undefined {
  return headers.get('x-request-id')
    || headers.get('request-id')
    || headers.get('x-correlation-id')
    || headers.get('anthropic-request-id')
    || undefined
}

async function throwLanguageModelHttpError(response: Pick<SafeHttpResponse, 'status' | 'statusText' | 'headers' | 'text'>, input: LanguageModelInput, requestUrl: string): Promise<never> {
  const body = await response.text().catch(() => '')
  const diagnostic = {
    adapter: adapterForProtocol(input.protocol),
    status: response.status,
    statusText: response.statusText,
    endpoint: new URL(requestUrl).pathname,
    detail: sanitizeProviderDetail(body),
    occurredAt: new Date().toISOString(),
    providerReferenceId: providerReferenceId(response.headers),
  }
  console.warn('language model rejected request', diagnostic)
  throw new LanguageModelHttpError(response.status === 408 || response.status === 429 || response.status >= 500 ? 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR' : 'PROMPT_OPTIMIZATION_REJECTED', diagnostic)
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

const LANGUAGE_MODEL_MAX_RESPONSE_BYTES = 10_000_000

// Module-level singleton; fetch defers to ambient globalThis.fetch at call time so tests can stub it.
const languageModelHttp = new DefaultSafeHttpClient({
  pluginId: 'language-model',
  version: '1.0.0',
  allowedHosts: ['api.openai.com', 'api.anthropic.com'],
  fetchImpl: ((input, init) => globalThis.fetch(input, init)) as typeof globalThis.fetch,
})

function throwLanguageModelUnsafeUrl(input: LanguageModelInput, requestUrl: string, detail: string): never {
  let endpoint = requestUrl
  try { endpoint = new URL(requestUrl).pathname } catch { endpoint = requestUrl }
  const diagnostic = {
    adapter: adapterForProtocol(input.protocol),
    status: 0,
    statusText: 'unsafe_url',
    endpoint,
    detail: sanitizeProviderDetail(detail),
    occurredAt: new Date().toISOString(),
  }
  console.warn('language model rejected request', diagnostic)
  throw new LanguageModelHttpError('PROMPT_OPTIMIZATION_REJECTED', diagnostic)
}

/**
 * An artifact signals failure as `throw Object.assign(new Error('<CODE>'), { diagnostic })`
 * (see core/plugin-scan.ts); in-band `LanguageCompletionResult.error` uses the same codes.
 */
function classifyPluginError(error: unknown): { code: NormalizedProviderErrorDiagnostic['code']; detail: string; providerReferenceId?: string } {
  if (error instanceof NormalizedProviderError) {
    return { code: error.diagnostic.code, detail: error.diagnostic.detail, providerReferenceId: error.diagnostic.providerReferenceId }
  }
  const raw = error && typeof error === 'object' ? (error as { diagnostic?: unknown }).diagnostic : undefined
  const diagnostic = raw && typeof raw === 'object' ? raw as Partial<NormalizedProviderErrorDiagnostic> : null
  const message = error instanceof Error ? error.message : String(error ?? 'UNKNOWN_ERROR')
  if (diagnostic && typeof diagnostic.code === 'string' && isNormalizedProviderCode(diagnostic.code)) {
    return {
      code: diagnostic.code,
      detail: typeof diagnostic.detail === 'string' ? diagnostic.detail : message,
      providerReferenceId: typeof diagnostic.providerReferenceId === 'string' ? diagnostic.providerReferenceId : undefined,
    }
  }
  return { code: isNormalizedProviderCode(message) ? message : 'UNKNOWN_ERROR', detail: message }
}

function languagePluginFailure(
  input: LanguageModelInput,
  pluginId: string,
  pluginVersion: string,
  code: NormalizedProviderErrorDiagnostic['code'],
  detail: string,
  providerReferenceId?: string,
): LanguageModelHttpError {
  const diagnostic: LanguageModelErrorDiagnostic = {
    adapter: adapterForProtocol(input.protocol),
    status: 0,
    statusText: code,
    endpoint: `plugin:${pluginId}@${pluginVersion}`,
    detail: sanitizeProviderDetail(detail),
    occurredAt: new Date().toISOString(),
    providerReferenceId,
  }
  console.warn('language plugin failed', diagnostic)
  return new LanguageModelHttpError(normalizedCodeToLanguageError(code), diagnostic)
}

async function callInstalledLanguageModel(input: LanguageModelInput, pluginId: string, pluginVersion: string): Promise<LanguageModelResult> {
  const config: ProviderConfig = { baseUrl: input.baseUrl, credential: input.credential ?? { schema: 'legacy-api-key-v1', apiKey: input.apiKey }, timeoutMs: input.timeoutMs }
  const request: LanguageRequest = { vendorModelId: input.vendorModelId, system: input.system, user: input.user, schemaName: input.schemaName, schema: input.schema, maxOutputTokens: input.maxOutputTokens, temperature: input.temperature, reasoningEffort: input.reasoningEffort, timeoutMs: input.timeoutMs }
  let result: LanguageCompletionResult
  try {
    const plugin: LanguageProviderPlugin = globalPluginRegistry.getLanguage(pluginId, pluginVersion)
    result = await plugin.complete(request, config, globalPluginRegistry.createLanguageExecutionContext(pluginId, pluginVersion, { config }))
  } catch (error) {
    if (error instanceof LanguageModelHttpError) throw error
    const failure = classifyPluginError(error)
    throw languagePluginFailure(input, pluginId, pluginVersion, failure.code, failure.detail, failure.providerReferenceId)
  }
  if (result.error) throw languagePluginFailure(input, pluginId, pluginVersion, result.error.code, result.error.detail, result.error.providerReferenceId)
  if (typeof result.text !== 'string') throw languagePluginFailure(input, pluginId, pluginVersion, 'PROVIDER_EMPTY_RESULT', 'language plugin returned no text')
  return { text: result.text, providerReferenceId: result.providerReferenceId, inputTokens: result.inputTokens, outputTokens: result.outputTokens }
}

export async function callLanguageModel(input: LanguageModelInput): Promise<LanguageModelResult> {
  // Additive dispatch for uploaded language plugins. Without both fields, or when the key
  // resolves to anything other than a language plugin, control falls through to the
  // built-in protocol path below unchanged.
  if (input.pluginId && input.pluginVersion && globalPluginRegistry.kindOf(input.pluginId, input.pluginVersion) === 'language') {
    return callInstalledLanguageModel(input, input.pluginId, input.pluginVersion)
  }
  const request = buildLanguageModelRequest(input)
  // Independent private-address gate on the configured baseUrl host: the per-request
  // allowlist below would otherwise admit that host by construction.
  if (input.baseUrl && process.env.ALLOW_PRIVATE_PROVIDER_BASE_URL !== 'true') {
    let parsedBase: URL | null = null
    try { parsedBase = new URL(input.baseUrl) } catch { parsedBase = null }
    if (parsedBase && isPrivateProviderHost(parsedBase.hostname)) {
      throwLanguageModelUnsafeUrl(input, request.url, `Configured language model base URL host '${parsedBase.hostname}' is a private address`)
    }
  }
  let requestHost = ''
  try { requestHost = new URL(request.url).hostname } catch { requestHost = '' }
  let response: SafeHttpResponse
  try {
    response = await languageModelHttp.request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      timeoutMs: input.timeoutMs,
      maxBytes: LANGUAGE_MODEL_MAX_RESPONSE_BYTES,
      allowedHosts: requestHost ? [requestHost] : [],
      allowInsecureProtocol: process.env.ALLOW_INSECURE_PROVIDER_BASE_URL === 'true',
    })
  } catch (error) {
    if (error instanceof NormalizedProviderError) {
      if (error.diagnostic.code === 'UNSAFE_URL') throwLanguageModelUnsafeUrl(input, request.url, error.diagnostic.detail)
      if (error.diagnostic.code === 'PROVIDER_TIMEOUT' || error.diagnostic.code === 'PROVIDER_TEMPORARY_ERROR') throw new Error('PROMPT_OPTIMIZATION_TEMPORARY_ERROR')
    }
    throw new Error('PROMPT_OPTIMIZATION_TEMPORARY_ERROR')
  }
  if (!response.ok) {
    await throwLanguageModelHttpError(response, input, request.url)
  }
  try { return parseLanguageModelResponse(input.protocol, JSON.parse(await response.text())) } catch (error) { if (error instanceof Error && error.message === 'LANGUAGE_MODEL_RESPONSE_INVALID') throw error; throw new Error('LANGUAGE_MODEL_RESPONSE_INVALID') }
}

export function parseExactJsonString(text: string, key: string, maxChars: number): string {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error(key === 'templateName' ? 'PROMPT_TEMPLATE_SELECTION_INVALID' : 'PROMPT_OUTPUT_INVALID') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join(',') !== key) throw new Error(key === 'templateName' ? 'PROMPT_TEMPLATE_SELECTION_INVALID' : 'PROMPT_OUTPUT_INVALID')
  const output = (parsed as Record<string, unknown>)[key]
  if (typeof output !== 'string' || !output.trim() || output.length > maxChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(output)) throw new Error(key === 'templateName' ? 'PROMPT_TEMPLATE_SELECTION_INVALID' : 'PROMPT_OUTPUT_INVALID')
  return output.trim()
}
