import {
  claimProviderCredentialTests,
  db,
  findProviderCredential,
  recordProviderCredentialTest,
  type ProviderCredentialRow,
  type ProviderCredentialTestResult,
} from '@musecanvas/database'
import {
  NormalizedProviderError,
  callLanguageModel,
  credentialServesPlugin,
  decodeStoredCredential,
  decryptStoredCredential,
  globalPluginRegistry,
  hasStoredCredentialSecret,
  resolveCredentialBaseUrl,
  type LanguageProtocol,
  type ReasoningEffort,
} from '@musecanvas/providers'
import { createMediaExecutionContext, installedLanguagePluginBinding, isPluginAvailable, resolveMediaPlugin } from '../plugins/availability'

/**
 * Credential connectivity tests. The API records a request on the credential row
 * (see requestProviderCredentialTest); this module claims open requests, probes
 * them and settles the outcome. It runs here because only the worker may execute
 * plugin code: built-in and uploaded plugins are probed alike, always through the
 * availability gate, and the API never calls a provider itself.
 */

/** Upper bound on one provider round trip; the API waits a little longer than this. */
export const CREDENTIAL_PROBE_TIMEOUT_MS = 15_000
/** A claim older than this belongs to a worker that died mid-probe and is re-claimed. */
export const CREDENTIAL_TEST_STALE_MS = 60_000
const CLAIM_LIMIT = 5

type PluginKey = { pluginId: string; pluginVersion: string }
type LinkedModel = {
  id: string
  model_kind: string
  plugin_id: string | null
  plugin_version: string | null
  base_url: string | null
}

const failed = (errorCode: string): ProviderCredentialTestResult => ({ status: 'failed', errorCode })

function parseConfiguredFields(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * The plugin a probe should use when one is named: the linked model's, else the
 * credential's template hint. Each source must supply a complete id@version on
 * its own; mixing the model's id with the hint's version would probe a key
 * neither side declared.
 */
export function resolveCredentialPlugin(
  linked: { plugin_id?: unknown; plugin_version?: unknown } | null | undefined,
  credentialRow: Record<string, unknown>,
): PluginKey | null {
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
  const linkedId = text(linked?.plugin_id)
  const linkedVersion = text(linked?.plugin_version)
  if (linkedId && linkedVersion) return { pluginId: linkedId, pluginVersion: linkedVersion }
  const fields = parseConfiguredFields(credentialRow.configured_fields)
  const hintId = text(fields.pluginId)
  const hintVersion = text(fields.pluginVersion)
  if (hintId && hintVersion) return { pluginId: hintId, pluginVersion: hintVersion }
  return null
}

/**
 * Without a named plugin, any available media plugin this credential could back
 * may probe it: same provider account, a decodable schema and an endpoint inside
 * the plugin's policy — the API's binding rule. Plugins that can probe come first.
 */
export function probeCandidates(row: Pick<ProviderCredentialRow, 'provider_id' | 'schema_id' | 'base_url'>): PluginKey[] {
  const fits = globalPluginRegistry.listManifests().filter(manifest =>
    manifest.kind === 'media'
    && isPluginAvailable(manifest.id, manifest.version)
    && credentialServesPlugin(manifest, row)
    && resolveCredentialBaseUrl(manifest, row.base_url).ok)
  const canProbe = (id: string, version: string) => typeof globalPluginRegistry.getMedia(id, version).probe === 'function'
  return fits
    .sort((a, b) => Number(canProbe(b.id, b.version)) - Number(canProbe(a.id, a.version)))
    .map(manifest => ({ pluginId: manifest.id, pluginVersion: manifest.version }))
}

/** Maps a probe failure onto the stable credential-test vocabulary. */
export function credentialProbeErrorCode(error: unknown): string {
  if (error instanceof NormalizedProviderError) {
    const { code, status } = error.diagnostic
    if (code === 'PROVIDER_REJECTED' || code === 'PROVIDER_TEMPORARY_ERROR' || code === 'PROVIDER_EMPTY_RESULT' || code === 'INVALID_CREDENTIAL') return code
    if (code === 'PROVIDER_NOT_CONFIGURED') return 'PLUGIN_NOT_REGISTERED'
    if (typeof status === 'number') return status === 429 || status >= 500 ? 'PROVIDER_TEMPORARY_ERROR' : 'PROVIDER_REJECTED'
    return 'CONNECTIVITY_FAILED'
  }
  const message = error instanceof Error ? error.message : ''
  if (message.startsWith('HTTP_')) {
    return message === 'HTTP_429' || Number(message.slice(5)) >= 500 ? 'PROVIDER_TEMPORARY_ERROR' : 'PROVIDER_REJECTED'
  }
  return ['PROVIDER_REJECTED', 'PROVIDER_TEMPORARY_ERROR', 'PROVIDER_EMPTY_RESULT', 'INVALID_CREDENTIAL'].includes(message)
    ? message
    : 'CONNECTIVITY_FAILED'
}

/** One tiny structured completion through the model's own protocol or uploaded plugin. */
async function probeLanguageModel(row: ProviderCredentialRow, rawSecret: string, modelId: string): Promise<ProviderCredentialTestResult> {
  if (!row.enabled) return failed('PROMPT_MODEL_NOT_CONFIGURED')
  const r = await db().query(
    `SELECT vendor_model_id,language_protocol,max_output_tokens,reasoning_effort,plugin_id,plugin_version,base_url
       FROM model_configs WHERE id=$1 AND model_kind='language' AND deleted_at IS NULL`,
    [modelId],
  )
  const model = r.rows[0]
  if (!model) return failed('PROMPT_MODEL_NOT_CONFIGURED')
  try {
    const installed = installedLanguagePluginBinding({
      pluginId: model.plugin_id,
      pluginVersion: model.plugin_version,
      apiKey: rawSecret,
      credentialSchema: row.schema_id,
    })
    await callLanguageModel({
      protocol: model.language_protocol as LanguageProtocol,
      vendorModelId: model.vendor_model_id,
      baseUrl: row.base_url || model.base_url || undefined,
      apiKey: rawSecret,
      ...installed,
      system: 'Return only the requested JSON.',
      user: 'MuseCanvas language model connectivity test. Return {"ok":"yes"}.',
      schemaName: 'connectivity_test',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'string', const: 'yes' } },
        required: ['ok'],
      },
      maxOutputTokens: Math.min(1000, Number(model.max_output_tokens)),
      // These models reject a reasoning effort on structured output.
      reasoningEffort: ['gpt-5.4', 'gpt-5.5'].includes(model.vendor_model_id) ? 'none' : (model.reasoning_effort as ReasoningEffort | null) || undefined,
      timeoutMs: CREDENTIAL_PROBE_TIMEOUT_MS,
    })
    return { status: 'success' }
  } catch (error) {
    if (error instanceof NormalizedProviderError) return failed(credentialProbeErrorCode(error))
    return failed(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR')
  }
}

/**
 * Probes one credential. Returns null when the row no longer exists (deleted
 * while queued), which leaves nothing to settle.
 */
export async function probeCredential(id: string): Promise<ProviderCredentialTestResult | null> {
  const row = await findProviderCredential(db(), id)
  if (!row) return null
  if (!hasStoredCredentialSecret(row)) return failed('NO_API_KEY')
  let rawSecret: string
  try {
    rawSecret = decryptStoredCredential(row)
  } catch {
    return failed('INVALID_CREDENTIAL')
  }

  // A language model linked to the credential is the most specific test there is.
  const linked = await db().query<LinkedModel>(
    `SELECT id,model_kind,plugin_id,plugin_version,base_url
       FROM model_configs
      WHERE provider_credential_id=$1 AND deleted_at IS NULL
      ORDER BY CASE WHEN model_kind='language' THEN 0 ELSE 1 END,created_at ASC
      LIMIT 1`,
    [id],
  )
  const linkedModel = linked.rows[0]
  if (linkedModel?.model_kind === 'language') return probeLanguageModel(row, rawSecret, linkedModel.id)
  if (row.adapter === 'anthropic' || row.provider_id === 'anthropic') return failed('PROMPT_MODEL_NOT_CONFIGURED')

  const plugin = resolveCredentialPlugin(linkedModel, row as unknown as Record<string, unknown>) ?? probeCandidates(row)[0] ?? null
  if (!plugin) return failed('PLUGIN_NOT_LINKED')
  if (!isPluginAvailable(plugin.pluginId, plugin.pluginVersion)) return failed('PLUGIN_NOT_REGISTERED')
  try {
    const media = resolveMediaPlugin(plugin.pluginId, plugin.pluginVersion)
    const decoded = decodeStoredCredential(row, rawSecret, plugin)
    const baseUrl = row.base_url || decoded.baseUrl || linkedModel?.base_url || undefined
    const config = { baseUrl, credential: decoded, timeoutMs: CREDENTIAL_PROBE_TIMEOUT_MS }
    await media.validateConfig(config)
    // Configuration alone proves nothing about connectivity, so a plugin that
    // cannot probe reports exactly that instead of a hollow success.
    if (!media.probe) return failed('PLUGIN_PROBE_UNSUPPORTED')
    const result = await media.probe(config, createMediaExecutionContext(plugin.pluginId, plugin.pluginVersion, { config }))
    return result.healthy ? { status: 'success' } : failed('PROVIDER_REJECTED')
  } catch (error) {
    return failed(credentialProbeErrorCode(error))
  }
}

/**
 * Claims and settles open test requests. Each request is settled independently:
 * a failing probe records its failure, and an unexpected error leaves the claim
 * to go stale and be retried rather than stalling the others.
 */
export async function runCredentialTests(): Promise<number> {
  const claimed = await claimProviderCredentialTests(db(), CLAIM_LIMIT, CREDENTIAL_TEST_STALE_MS)
  await Promise.all(claimed.map(async (request) => {
    try {
      const result = await probeCredential(request.id)
      if (result) await recordProviderCredentialTest(db(), request.id, result, { actorId: request.requestedBy, requestedAt: request.requestedAt })
    } catch (error) {
      console.error('credential test failed', { code: error instanceof Error ? error.name : 'ERROR' })
    }
  }))
  return claimed.length
}
