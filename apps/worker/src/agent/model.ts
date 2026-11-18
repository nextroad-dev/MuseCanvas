import type { AgentModelDependencies, AgentModelPort, AgentModelRequest, AgentTurnScope, CreateAgentModel } from './ports'
import {
  callLanguageModelChat,
  LanguageModelChatError,
  openStoredCredential,
  type LanguageModelChatInput,
  type LanguageModelChatMessage,
  type LanguageModelChatResult,
  type LanguageModelChatTool,
  type LanguageProtocol,
  type OpenedCredential,
  type ReasoningEffort,
  type StoredCredentialFields,
} from '@musecanvas/providers'

/**
 * Worker-side language model adapter for Agent Core.
 *
 * The Turn's config snapshot pins model-config and model-revision ids. This
 * module resolves those ids again against the live model row, the immutable
 * revision and the stored credential before any external call. The injected
 * query is therefore expected to be a pool/request query, not a transaction:
 * `chat` performs no database call while the provider request is in flight.
 */

export class AgentModelError extends Error {
  constructor(readonly code: AgentModelErrorCode) {
    super(code)
    this.name = 'AgentModelError'
  }
}

export type AgentModelErrorCode =
  | 'AGENT_MODEL_CONFIG_INVALID'
  | 'AGENT_MODEL_UNAVAILABLE'
  | 'AGENT_MODEL_CREDENTIAL_UNAVAILABLE'
  | 'AGENT_MODEL_STORE_UNAVAILABLE'
  | 'AGENT_MODEL_INPUT_INVALID'
  | 'AGENT_MODEL_CANCELED'
  | 'AGENT_MODEL_LEASE_LOST'
  | 'AGENT_MODEL_DEADLINE_EXCEEDED'
  | 'AGENT_MODEL_TIMEOUT'
  | 'AGENT_MODEL_REJECTED'
  | 'AGENT_MODEL_TEMPORARY'
  | 'AGENT_MODEL_RESPONSE_INVALID'
  | 'AGENT_MODEL_RESPONSE_TOO_LARGE'
  | 'AGENT_MODEL_UNSUPPORTED'

export type AgentModelQueryResult = { rows: ReadonlyArray<Record<string, unknown>> }
export type AgentModelQueryOptions = { readonly signal: AbortSignal; readonly timeoutMs: number }
/**
 * The query implementation must enforce finite pool-acquisition and statement
 * timeouts (at most timeoutMs), and honor signal when its driver supports it.
 * The adapter bounds its own wait even if a driver ignores cancellation; a late
 * result/rejection is observed and can never start credential or provider use.
 */
export type AgentModelQuery = (sql: string, parameters: readonly unknown[], options?: AgentModelQueryOptions) => Promise<AgentModelQueryResult>
export type AgentModelChat = (input: LanguageModelChatInput) => Promise<LanguageModelChatResult>
export type AgentModelOpenCredential = (
  row: StoredCredentialFields,
  plugin?: { pluginId: string; pluginVersion: string },
) => OpenedCredential

export type AgentModelSnapshot = {
  readonly modelConfigId: string
  readonly modelRevisionId: string
}

export type AgentModelControl = {
  /** Caller's request/lease signal; combined with the other abort sources. */
  readonly request?: AbortSignal
  /** Aborted when the Runner loses its Turn lease or fails a renewal. */
  readonly lease?: AbortSignal
  /** Aborted when the Turn has a durable cancel request. */
  readonly cancel?: AbortSignal
  /** Turn deadline, normally the frozen `deadline_at` value. */
  readonly deadlineAt: string | number | Date
}

export type AgentModelChatRequest = {
  readonly ownerId: string
  readonly sessionId: string
  readonly turnId: string
  /** Raw pinned admission snapshot; checked against the owner-scoped persisted Turn. */
  readonly turnConfigSnapshot: unknown
  readonly system: string
  readonly messages: readonly LanguageModelChatMessage[]
  readonly tools?: readonly LanguageModelChatTool[]
  /** Optional budget cap; the effective value never exceeds the model's configured maximum. */
  readonly maxOutputTokens?: number
  readonly control: AgentModelControl
}

export type AgentLanguageModelAdapter = {
  chat(request: AgentModelChatRequest): Promise<LanguageModelChatResult>
}

export type AgentModelAdapterOptions = {
  readonly query: AgentModelQuery
  readonly chat?: AgentModelChat
  /** Injectable only for tests; production always opens the stored credential centrally. */
  readonly openCredential?: AgentModelOpenCredential
  readonly now?: () => number
}

type ResolvedModel = {
  protocol: Extract<LanguageProtocol, 'openai_chat' | 'anthropic_messages'>
  pluginId: 'openai-language' | 'anthropic-language'
  pluginVersion: '1.0.0'
  vendorModelId: string
  baseUrl: string | undefined
  maxOutputTokens: number
  temperature: number | undefined
  reasoningEffort: ReasoningEffort | null
  credential: StoredCredentialFields
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/
const surrogatePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
const protocols = ['openai_chat', 'anthropic_messages'] as const
const efforts = ['none', 'low', 'medium', 'high', 'xhigh'] as const
const pluginForProtocol = {
  openai_chat: { pluginId: 'openai-language', providerId: 'openai' },
  anthropic_messages: { pluginId: 'anthropic-language', providerId: 'anthropic' },
} as const

function fail(code: AgentModelErrorCode): never {
  throw new AgentModelError(code)
}

function text(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0') || surrogatePattern.test(value)
    || Buffer.byteLength(value, 'utf8') > maxBytes) fail('AGENT_MODEL_CONFIG_INVALID')
  return value
}

function nullableText(value: unknown, maxBytes: number): string | null {
  if (value === null || value === undefined || value === '') return null
  return text(value, maxBytes)
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) fail('AGENT_MODEL_CONFIG_INVALID')
  return value.toLowerCase()
}

function integer(value: unknown, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail('AGENT_MODEL_CONFIG_INVALID')
  return parsed
}

function boolean(value: unknown, expected: boolean): boolean {
  if (value !== expected) fail('AGENT_MODEL_UNAVAILABLE')
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('AGENT_MODEL_UNAVAILABLE')
  return value as Record<string, unknown>
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value))) fail('AGENT_MODEL_CONFIG_INVALID')
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) fail('AGENT_MODEL_CONFIG_INVALID')
  return parsed
}

function normalizedConfig(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  return record(value)
}

function equalSnapshotValue(actual: unknown, expected: unknown): boolean {
  return actual === undefined || actual === expected
}

function safeBaseUrl(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.includes('\0') || surrogatePattern.test(value) || Buffer.byteLength(value, 'utf8') > 2048) {
    fail('AGENT_MODEL_CONFIG_INVALID')
  }
  let parsed: URL
  try { parsed = new URL(value) } catch { return fail('AGENT_MODEL_CONFIG_INVALID') }
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname
    || parsed.username || parsed.password || parsed.search || parsed.hash) fail('AGENT_MODEL_CONFIG_INVALID')
  return value
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function endpointBase(value: string): string {
  return value.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

function safeCredentialKey(opened: OpenedCredential): string {
  const key = opened.decoded.apiKey
  if (typeof key !== 'string' || !key.trim() || hasControl(key) || surrogatePattern.test(key)
    || Buffer.byteLength(key, 'utf8') > 16_384) fail('AGENT_MODEL_CREDENTIAL_UNAVAILABLE')
  return key.trim()
}

function resolveModelRow(row: Record<string, unknown>, snapshot: AgentModelSnapshot): ResolvedModel {
  if (row.model_id !== snapshot.modelConfigId || row.revision_id !== snapshot.modelRevisionId
    || row.revision_model_id !== snapshot.modelConfigId || row.latest_revision_id !== snapshot.modelRevisionId) {
    fail('AGENT_MODEL_UNAVAILABLE')
  }
  if (row.model_kind !== 'language') fail('AGENT_MODEL_UNAVAILABLE')
  boolean(row.model_enabled, true)
  if (row.model_deleted_at !== null && row.model_deleted_at !== undefined) fail('AGENT_MODEL_UNAVAILABLE')
  if (row.plugin_source !== 'builtin') fail('AGENT_MODEL_UNAVAILABLE')

  const protocol = row.language_protocol
  if (!protocols.includes(protocol as (typeof protocols)[number])) fail('AGENT_MODEL_UNAVAILABLE')
  const typedProtocol = protocol as ResolvedModel['protocol']
  const binding = pluginForProtocol[typedProtocol]
  const pluginId = text(row.revision_plugin_id, 100)
  const pluginVersion = text(row.revision_plugin_version, 20)
  if (pluginId !== binding.pluginId || pluginVersion !== '1.0.0'
    || row.model_plugin_id !== pluginId || row.model_plugin_version !== pluginVersion
    || row.model_provider_id !== binding.providerId || row.revision_provider_id !== binding.providerId) {
    fail('AGENT_MODEL_UNAVAILABLE')
  }

  const vendorModelId = text(row.revision_vendor_model_id, 200)
  if (!identifierPattern.test(vendorModelId) || vendorModelId.includes('://') || row.model_vendor_model_id !== vendorModelId) {
    fail('AGENT_MODEL_UNAVAILABLE')
  }
  const maxOutputTokens = integer(row.max_output_tokens, 1, 10_000_000)
  const temperature = optionalNumber(row.temperature)
  if (temperature !== null && (temperature < 0 || temperature > 2)) fail('AGENT_MODEL_UNAVAILABLE')
  const effort = row.reasoning_effort
  if (effort !== null && effort !== undefined && !efforts.includes(effort as ReasoningEffort)) fail('AGENT_MODEL_UNAVAILABLE')
  const reasoningEffort = (effort ?? null) as ReasoningEffort | null
  if (typedProtocol === 'anthropic_messages' && reasoningEffort !== null && reasoningEffort !== 'none') {
    fail('AGENT_MODEL_UNAVAILABLE')
  }

  const revisionBaseUrl = nullableText(row.revision_base_url, 2048)
  const modelBaseUrl = nullableText(row.model_base_url, 2048)
  if (revisionBaseUrl !== modelBaseUrl) fail('AGENT_MODEL_UNAVAILABLE')

  const config = normalizedConfig(row.normalized_config)
  if (!equalSnapshotValue(config.vendorModelId, vendorModelId)
    || !equalSnapshotValue(config.baseUrl, modelBaseUrl)
    || !equalSnapshotValue(config.languageProtocol, typedProtocol)
    || !equalSnapshotValue(config.maxOutputTokens, maxOutputTokens)
    || !equalSnapshotValue(config.temperature, temperature)
    || !equalSnapshotValue(config.reasoningEffort, reasoningEffort)) {
    fail('AGENT_MODEL_UNAVAILABLE')
  }

  const credentialId = text(row.revision_credential_id, 200)
  if (uuid(credentialId) !== credentialId || row.credential_id !== credentialId
    || row.model_provider_credential_id !== credentialId) fail('AGENT_MODEL_UNAVAILABLE')
  boolean(row.credential_enabled, true)
  if (row.credential_deleted_at !== null && row.credential_deleted_at !== undefined) fail('AGENT_MODEL_CREDENTIAL_UNAVAILABLE')
  if (row.credential_provider_id !== binding.providerId) fail('AGENT_MODEL_CREDENTIAL_UNAVAILABLE')
  const credentialSchema = row.credential_schema_id
  if (credentialSchema !== null && credentialSchema !== undefined && credentialSchema !== 'legacy-api-key-v1') {
    fail('AGENT_MODEL_CREDENTIAL_UNAVAILABLE')
  }
  const pinnedSchemaVersion = row.revision_credential_schema_version
  if (pinnedSchemaVersion !== null && pinnedSchemaVersion !== undefined
    && integer(pinnedSchemaVersion, 1, 2_147_483_647) !== integer(row.credential_schema_version, 1, 2_147_483_647)) {
    fail('AGENT_MODEL_CREDENTIAL_UNAVAILABLE')
  }

  safeBaseUrl(revisionBaseUrl)
  const credentialBaseUrl = nullableText(row.credential_base_url, 2048)
  const pinnedBaseUrl = revisionBaseUrl ?? (typedProtocol === 'openai_chat' ? 'https://api.openai.com' : 'https://api.anthropic.com')
  if (credentialBaseUrl && endpointBase(credentialBaseUrl) !== endpointBase(pinnedBaseUrl)) fail('AGENT_MODEL_CREDENTIAL_UNAVAILABLE')

  return {
    protocol: typedProtocol,
    pluginId: binding.pluginId,
    pluginVersion: '1.0.0',
    vendorModelId,
    baseUrl: revisionBaseUrl ?? undefined,
    maxOutputTokens,
    temperature: temperature ?? undefined,
    reasoningEffort,
    credential: {
      payload_encrypted: typeof row.payload_encrypted === 'string' ? row.payload_encrypted : null,
      api_key_encrypted: typeof row.api_key_encrypted === 'string' ? row.api_key_encrypted : null,
      encryption_key_id: typeof row.encryption_key_id === 'string' ? row.encryption_key_id : null,
      schema_id: typeof row.credential_schema_id === 'string' ? row.credential_schema_id : null,
    },
  }
}

const MODEL_QUERY = `
  SELECT t.config_snapshot AS turn_config_snapshot,t.deadline_at AS turn_deadline_at,
         m.id AS model_id,m.model_kind,m.enabled AS model_enabled,m.deleted_at AS model_deleted_at,
         m.latest_revision_id,m.provider_credential_id AS model_provider_credential_id,
         m.language_protocol,m.plugin_source,m.plugin_id AS model_plugin_id,m.plugin_version AS model_plugin_version,
         m.provider_id AS model_provider_id,m.vendor_model_id AS model_vendor_model_id,m.base_url AS model_base_url,
         m.max_output_tokens,m.temperature,m.reasoning_effort,
         r.id AS revision_id,r.model_id AS revision_model_id,r.revision,r.provider_id AS revision_provider_id,
         r.plugin_id AS revision_plugin_id,r.plugin_version AS revision_plugin_version,
         r.vendor_model_id AS revision_vendor_model_id,r.base_url AS revision_base_url,
         r.credential_id AS revision_credential_id,r.credential_schema_version AS revision_credential_schema_version,
         r.normalized_config,
         c.id AS credential_id,c.enabled AS credential_enabled,c.deleted_at AS credential_deleted_at,
         c.provider_id AS credential_provider_id,c.schema_id AS credential_schema_id,c.schema_version AS credential_schema_version,
         c.base_url AS credential_base_url,c.payload_encrypted,c.api_key_encrypted,c.encryption_key_id
    FROM agent_turns t
    JOIN agent_sessions s ON s.id=t.session_id
    JOIN users u ON u.id=s.owner_id
    JOIN model_configs m ON m.id=$1
    JOIN model_config_revisions r ON r.id=$2 AND r.model_id=m.id
    LEFT JOIN provider_credentials c ON c.id=r.credential_id
   WHERE m.latest_revision_id=$2 AND s.owner_id=$3 AND s.id=$4 AND t.id=$5
     AND t.engine_version='agent-core-v1' AND s.active_turn_id=t.id AND s.archived_at IS NULL
     AND u.status='active' AND u.deleted_at IS NULL AND t.status='running'
     AND t.cancel_requested_at IS NULL AND clock_timestamp()<t.deadline_at`

export function parseAgentModelSnapshot(value: unknown): AgentModelSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('AGENT_MODEL_CONFIG_INVALID')
  const config = value as Record<string, unknown>
  return { modelConfigId: uuid(config.modelConfigId), modelRevisionId: uuid(config.modelRevisionId) }
}

function assertPinnedConfig(value: unknown, expected: unknown, model: ResolvedModel, snapshot: AgentModelSnapshot): void {
  const config = record(value)
  const supplied = record(expected)
  const pinned = parseAgentModelSnapshot(config)
  if (pinned.modelConfigId !== snapshot.modelConfigId || pinned.modelRevisionId !== snapshot.modelRevisionId) fail('AGENT_MODEL_UNAVAILABLE')
  const bindings = { protocol: model.protocol, pluginId: model.pluginId, pluginVersion: model.pluginVersion,
    providerId: pluginForProtocol[model.protocol].providerId, vendorModelId: model.vendorModelId,
    maxOutputTokens: model.maxOutputTokens, temperature: model.temperature ?? null, reasoningEffort: model.reasoningEffort }
  for (const [key, binding] of Object.entries(bindings)) {
    if (config[key] !== binding || supplied[key] !== binding) fail('AGENT_MODEL_UNAVAILABLE')
  }
  const configRevision = integer(config.modelRevision, 1, 2_147_483_647)
  if (config.instructions !== supplied.instructions || configRevision !== integer(supplied.modelRevision, 1, 2_147_483_647)) {
    fail('AGENT_MODEL_UNAVAILABLE')
  }
}

function deadlineMs(value: AgentModelControl['deadlineAt']): number {
  const parsed = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
      : Date.parse(value)
  if (!Number.isFinite(parsed)) fail('AGENT_MODEL_INPUT_INVALID')
  return parsed
}

function safeSystem(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || surrogatePattern.test(value)
    || Buffer.byteLength(value, 'utf8') > 100_000) fail('AGENT_MODEL_INPUT_INVALID')
  return value
}

function providerFailure(error: unknown, control: AgentModelControl, deadlineSignal: AbortSignal, deadline: number, now: () => number): never {
  if (control.cancel?.aborted || control.request?.aborted) fail('AGENT_MODEL_CANCELED')
  if (control.lease?.aborted) fail('AGENT_MODEL_LEASE_LOST')
  if (deadlineSignal.aborted || now() >= deadline) fail('AGENT_MODEL_DEADLINE_EXCEEDED')
  if (error instanceof LanguageModelChatError) {
    switch (error.code) {
      case 'LANGUAGE_MODEL_CANCELED': return fail('AGENT_MODEL_CANCELED')
      case 'LANGUAGE_MODEL_TIMEOUT': return fail('AGENT_MODEL_TIMEOUT')
      case 'LANGUAGE_MODEL_RESPONSE_INVALID': return fail('AGENT_MODEL_RESPONSE_INVALID')
      case 'LANGUAGE_MODEL_RESPONSE_TOO_LARGE': return fail('AGENT_MODEL_RESPONSE_TOO_LARGE')
      case 'LANGUAGE_MODEL_UNSUPPORTED': return fail('AGENT_MODEL_UNSUPPORTED')
      case 'LANGUAGE_MODEL_REJECTED': return fail('AGENT_MODEL_REJECTED')
      case 'LANGUAGE_MODEL_TEMPORARY_ERROR': return fail('AGENT_MODEL_TEMPORARY')
    }
  }
  fail('AGENT_MODEL_TEMPORARY')
}

function chatInput(
  model: ResolvedModel,
  secret: string,
  request: AgentModelChatRequest,
  signal: AbortSignal,
  timeoutMs: number,
): LanguageModelChatInput {
  const requestedCap = request.maxOutputTokens
  if (requestedCap !== undefined && (!Number.isSafeInteger(requestedCap) || requestedCap < 1 || requestedCap > 10_000_000)) {
    fail('AGENT_MODEL_INPUT_INVALID')
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) fail('AGENT_MODEL_INPUT_INVALID')
  return {
    protocol: model.protocol,
    vendorModelId: model.vendorModelId,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    apiKey: secret,
    pluginId: model.pluginId,
    pluginVersion: model.pluginVersion,
    system: safeSystem(request.system),
    messages: request.messages as LanguageModelChatMessage[],
    ...(request.tools ? { tools: request.tools as LanguageModelChatTool[] } : {}),
    maxOutputTokens: Math.min(model.maxOutputTokens, requestedCap ?? model.maxOutputTokens),
    ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
    reasoningEffort: model.reasoningEffort,
    timeoutMs,
    signal,
  }
}

/** Attach both handlers immediately, so even a late rejected query is observed. */
function controlledQuery<T>(query: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new AgentModelError('AGENT_MODEL_CANCELED')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    try {
      query().then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    } catch (error) { cleanup(); reject(error) }
  })
}

function assertActive(control: AgentModelControl, signal: AbortSignal, deadline: number, now: () => number): void {
  if (control.cancel?.aborted || control.request?.aborted) fail('AGENT_MODEL_CANCELED')
  if (control.lease?.aborted) fail('AGENT_MODEL_LEASE_LOST')
  if (signal.aborted || now() >= deadline) fail('AGENT_MODEL_DEADLINE_EXCEEDED')
}

export function createAgentLanguageModelAdapter(options: AgentModelAdapterOptions): AgentLanguageModelAdapter {
  const chat = options.chat ?? callLanguageModelChat
  const openCredential = options.openCredential ?? openStoredCredential
  const now = options.now ?? Date.now

  return {
    async chat(request) {
      const snapshot = parseAgentModelSnapshot(request.turnConfigSnapshot)
      const scope = [uuid(request.ownerId), uuid(request.sessionId), uuid(request.turnId)]
      let deadline = deadlineMs(request.control.deadlineAt)
      const deadlineController = new AbortController()
      assertActive(request.control, deadlineController.signal, deadline, now)
      const remaining = Math.floor(deadline - now())
      if (remaining <= 0) fail('AGENT_MODEL_DEADLINE_EXCEEDED')
      if (remaining > 2_147_483_647) fail('AGENT_MODEL_INPUT_INVALID')
      let timer = setTimeout(() => deadlineController.abort(), remaining)
      const signal = AbortSignal.any([deadlineController.signal, request.control.cancel,
        request.control.request, request.control.lease].filter((value): value is AbortSignal => value !== undefined))
      try {
        let row: Record<string, unknown> | undefined
        try {
          const result = await controlledQuery(() => options.query(MODEL_QUERY,
            [snapshot.modelConfigId, snapshot.modelRevisionId, ...scope], { signal, timeoutMs: remaining }), signal)
          row = result.rows[0]
        } catch {
          assertActive(request.control, deadlineController.signal, deadline, now)
          fail('AGENT_MODEL_STORE_UNAVAILABLE')
        }
        assertActive(request.control, deadlineController.signal, deadline, now)
        if (!row) fail('AGENT_MODEL_UNAVAILABLE')
        const model = resolveModelRow(row, snapshot)
        assertPinnedConfig(row.turn_config_snapshot, request.turnConfigSnapshot, model, snapshot)
        if (safeSystem(request.system) !== record(row.turn_config_snapshot).instructions) fail('AGENT_MODEL_UNAVAILABLE')
        if (integer(record(row.turn_config_snapshot).modelRevision, 1, 2_147_483_647) !== integer(row.revision, 1, 2_147_483_647)) {
          fail('AGENT_MODEL_UNAVAILABLE')
        }
        deadline = Math.min(deadline, deadlineMs(row.turn_deadline_at as string | Date))
        assertActive(request.control, deadlineController.signal, deadline, now)
        const effectiveRemaining = Math.floor(deadline - now())
        if (effectiveRemaining <= 0) fail('AGENT_MODEL_DEADLINE_EXCEEDED')
        clearTimeout(timer)
        timer = setTimeout(() => deadlineController.abort(), effectiveRemaining)

        let opened: OpenedCredential
        try { opened = openCredential(model.credential, { pluginId: model.pluginId, pluginVersion: model.pluginVersion }) }
        catch { fail('AGENT_MODEL_CREDENTIAL_UNAVAILABLE') }
        if (opened.decoded.schema !== 'legacy-api-key-v1') fail('AGENT_MODEL_CREDENTIAL_UNAVAILABLE')
        const secret = safeCredentialKey(opened)
        const decodedBaseUrl = safeBaseUrl(opened.decoded.baseUrl)
        const pinnedBaseUrl = model.baseUrl ?? (model.protocol === 'openai_chat' ? 'https://api.openai.com' : 'https://api.anthropic.com')
        if (decodedBaseUrl && endpointBase(decodedBaseUrl) !== endpointBase(pinnedBaseUrl)) fail('AGENT_MODEL_CREDENTIAL_UNAVAILABLE')
        assertActive(request.control, deadlineController.signal, deadline, now)
        const timeoutMs = Math.floor(deadline - now())
        if (timeoutMs <= 0) fail('AGENT_MODEL_DEADLINE_EXCEEDED')
        const input = chatInput(model, secret, request, signal, timeoutMs)
        try {
          const result = await chat(input)
          assertActive(request.control, deadlineController.signal, deadline, now)
          return result
        } catch (error) { providerFailure(error, request.control, deadlineController.signal, deadline, now) }
      } finally { clearTimeout(timer) }
    },
  }
}

/** Local factory dependencies extend the shared seam with the security context the seam lacks. */
export type AgentModelBoundDependencies = AgentModelAdapterOptions & {
  readonly scope: AgentTurnScope
  readonly control: AgentModelControl
}

export type AgentModelFactoryDependencies = AgentModelDependencies & AgentModelBoundDependencies

/**
 * Frozen `AgentModelPort` adapter. One instance is bound to one Turn's scope and
 * deadline; `complete` still re-resolves the pinned revision/model/credential on
 * every call. The shared `loadCredential(modelConfigId, providerId)` dependency
 * is intentionally unused: it cannot revalidate the immutable revision, owner,
 * active Turn or deadline, so using it would weaken this factory.
 */
export function createAgentModel(dependencies: AgentModelFactoryDependencies): AgentModelPort {
  const adapter = createAgentLanguageModelAdapter(dependencies)
  return {
    complete(input: AgentModelRequest) {
      const timeoutMs = integer(input.config.timeoutMs, 1, 300_000)
      const deadlineAt = Math.min(deadlineMs(dependencies.control.deadlineAt), (dependencies.now ?? Date.now)() + timeoutMs)
      return adapter.chat({
        ownerId: dependencies.scope.ownerId,
        sessionId: dependencies.scope.sessionId,
        turnId: dependencies.scope.turnId,
        turnConfigSnapshot: { ...input.config, instructions: input.instructions },
        system: input.instructions,
        messages: input.messages,
        tools: input.tools,
        maxOutputTokens: input.config.maxOutputTokens,
        control: { ...dependencies.control, deadlineAt, request: dependencies.control.request
          ? AbortSignal.any([dependencies.control.request, input.signal]) : input.signal },
      })
    },
  }
}

/** Bind secure per-Turn dependencies first, then expose the exact frozen factory. */
export function bindAgentModelFactory(bound: AgentModelBoundDependencies): CreateAgentModel {
  return dependencies => createAgentModel({ ...dependencies, ...bound })
}
