import { createHash } from 'node:crypto'
import { db, transaction } from '../../../../../packages/database/src/index'
import { createModelConfigRevision } from '@musecanvas/database'
import type { JsonValue, ModelCapabilities } from '@musecanvas/contracts'
import { enumOptionValues } from '@musecanvas/contracts'
import { type Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { capabilitiesFromRow, defaultsFromRow, legacyColumnsFromCapabilities, modelDto } from '../../shared/dto'
import { normalizedProviderBaseUrl, sanitizeReasoningEffort } from '../../shared/model-helpers'
import { resolveCatalogPlugin, resolvePresetById } from '../admin/plugin-catalog'
import { globalProviderRegistry, MAX_INPUT_IMAGES } from '../../../../../packages/providers/src/index'
import type { AnyProviderManifest } from '../../../../../packages/providers/src/index'
import type { MediaProviderPlugin } from '../../../../../packages/providers/src/index'
import { resolvePresetCapabilities, type ModelPreset } from '../../admin/model-presets'
import { hasForbiddenManualModelFields, modelOverrideError, modelSavePath, presetRevisionOrRow } from './upsert-internal'

// Plugin-first validation. New image configuration targets the hardened active
// keys (openai-image@1.1.0, seedream-image@1.1.0); exact registered 1.0.0 keys
// remain accepted so already-pinned historical revisions stay readable.
// Runtime selection never maps adapter/provider strings to a plugin — the only
// authority is the catalog (static registry plus active provider_plugins rows)
// and the manifest modality.
export const ACTIVE_IMAGE_PLUGIN_VERSION = '1.1.0'
const IMAGE_PLUGIN_IDS: Record<string, true> = { 'openai-image': true, 'seedream-image': true }

export function modelDeleteIdFromPath(path: string): string | null {
  return path.match(/^admin\/models\/([0-9a-f-]+)$/)?.[1] ?? null
}

/**
 * Modality gate over a manifest. Language manifests have no `modalities`, so they
 * are rejected here: a model config may only bind to a media plugin.
 */
export function manifestMediaSelection(
  manifest: AnyProviderManifest,
  modelKind: string,
): { ok: true; mediaKind: 'image' | 'video' } | { ok: false } {
  const modalities: string[] = manifest.kind === 'media' ? manifest.modalities : []
  if (!modalities.includes(modelKind)) return { ok: false }
  return { ok: true, mediaKind: modelKind as 'image' | 'video' }
}

export function validatePluginSelection(
  pluginId: string,
  pluginVersion: string,
  modelKind: string,
): { ok: true; mediaKind: 'image' | 'video' } | { ok: false; error: 'INVALID_PLUGIN' | 'INVALID_MODALITY' } {
  if (!globalProviderRegistry.has(pluginId, pluginVersion)) return { ok: false, error: 'INVALID_PLUGIN' }
  const selection = manifestMediaSelection(globalProviderRegistry.get(pluginId, pluginVersion).manifest, modelKind)
  if (!selection.ok) return { ok: false, error: 'INVALID_MODALITY' }
  return selection
}

// Manifest vendor-model gate for the hardened image keys. An empty model list
// means the plugin accepts any vendor model ID; a nonempty list is exhaustive.
export function manifestSupportsVendorModel(
  manifestModels: { id: string }[] | undefined,
  vendorModelId: string,
): boolean {
  if (!manifestModels || manifestModels.length === 0) return true
  return manifestModels.some((model) => model.id === vendorModelId)
}

// Official endpoint hosts for the hardened image keys. Active image
// configuration must point at these hosts (or leave the base URL empty so the
// plugin default applies); compatible/custom endpoints cannot use 1.1.0.
export const IMAGE_PLUGIN_OFFICIAL_HOSTS: Record<string, string> = {
  'openai-image': 'api.openai.com',
  'seedream-image': 'ark.cn-beijing.volces.com',
}

export function imageBaseUrlAllowed(pluginId: string, baseUrl: string | null | undefined): boolean {
  const official = IMAGE_PLUGIN_OFFICIAL_HOSTS[pluginId]
  if (!official) return true
  if (baseUrl === undefined || baseUrl === null || baseUrl === '') return true
  try {
    return new URL(baseUrl).hostname.toLowerCase() === official
  } catch {
    return false
  }
}

export type ImageModelContract = {
  vendorModelId: string
  /** The contract the shipped plugin itself declared for this vendor model. */
  capabilities: ModelCapabilities
}

/**
 * The smoke gate for a *built-in* image plugin: does the shipped plugin actually
 * accept its own declaration?
 *
 * The values exercised here are no longer read off `model_configs` columns — they
 * are the declared image-size presets, the declared enum options and the declared
 * integer bounds, fed back into the plugin's own `validateRequest`. That makes
 * this a check that the manifest and the adapter agree, which is the only thing
 * the host can still verify without the plugin's source in front of it: an
 * installed plugin's code is never imported here, so its manifest is taken at its
 * word and only exercised at generation time.
 */
export async function validateImageModelContract(
  plugin: Pick<MediaProviderPlugin, 'validateRequest' | 'manifest'>,
  contract: ImageModelContract,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const send = async (
    extra: { size?: string; quality?: string; count?: number; parameters?: Record<string, JsonValue> },
  ): Promise<void> => {
    await plugin.validateRequest({
      modality: 'image',
      vendorModelId: contract.vendorModelId,
      prompt: 'MuseCanvas model contract check',
      ...extra,
    }, {})
  }

  try {
    await send({})
    for (const descriptor of contract.capabilities.parameters) {
      if (descriptor.type === 'image-size') {
        for (const preset of descriptor.presets) await send({ size: preset.value })
        continue
      }
      if (descriptor.type === 'enum') {
        for (const option of enumOptionValues(descriptor.options)) {
          if (descriptor.name === 'size') await send({ size: option })
          else if (descriptor.name === 'quality') await send({ quality: option })
          else await send({ parameters: { [descriptor.name]: option } })
        }
        continue
      }
      // Only the declared bounds are exercised: they are the two values a caller
      // can get wrong by one, and the plugin owns the arithmetic in between.
      if (descriptor.type === 'integer' || descriptor.type === 'number') {
        for (const bound of [descriptor.min, descriptor.max]) {
          if (typeof bound !== 'number') continue
          if (descriptor.name === 'count') await send({ count: bound })
          else await send({ parameters: { [descriptor.name]: bound } })
        }
      }
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '模型配置与插件契约不符' }
  }
  // The declared reference slot may not promise more input images than the host
  // can actually stage, and a model that declares no slot accepts none.
  const declaredReferences = contract.capabilities.inputSlots
    .find(slot => slot.role === 'reference_image')?.maxCount ?? 0
  if (!Number.isInteger(declaredReferences) || declaredReferences < 0 || declaredReferences > MAX_INPUT_IMAGES) {
    return { ok: false, message: `reference_image slot must declare an integer count between 0 and ${MAX_INPUT_IMAGES}` }
  }
  return { ok: true }
}


/**
 * True when a caller-supplied capabilities/defaults override carries no content
 * (absent, null, empty object/array/string). Anything else is rejected on
 * **every** media write, image and video alike: the contract is the plugin's
 * declaration, so a body that brings its own `capabilities` is not configuring a
 * model, it is authoring one from outside the manifest.
 */
export function isEmptyInputOverride(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0
  return false
}


function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`
}

function snapshotDigest(parts: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(parts)).digest('hex')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}

function configuredPluginIdentity(row: Record<string, unknown>): {
  pluginId?: string
  pluginVersion?: string
  hasIdentityField: boolean
} {
  let configured: Record<string, unknown> = {}
  if (typeof row.configured_fields === 'object' && row.configured_fields !== null) {
    configured = row.configured_fields as Record<string, unknown>
  } else if (typeof row.configured_fields === 'string') {
    try {
      const parsed = JSON.parse(row.configured_fields) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        configured = parsed as Record<string, unknown>
      }
    } catch {
      configured = {}
    }
  }
  const pluginId =
    typeof configured.pluginId === 'string' && configured.pluginId.trim()
      ? configured.pluginId.trim()
      : undefined
  const pluginVersion =
    typeof configured.pluginVersion === 'string' && configured.pluginVersion.trim()
      ? configured.pluginVersion.trim()
      : undefined
  return {
    pluginId,
    pluginVersion,
    hasIdentityField: pluginId !== undefined || pluginVersion !== undefined,
  }
}

export function providerCredentialMatchesPluginTarget(
  credential: Record<string, unknown>,
  target: { providerId: string; pluginId: string; pluginVersion: string },
): boolean {
  const identity = configuredPluginIdentity(credential)
  if (identity.hasIdentityField) {
    return identity.pluginId === target.pluginId && identity.pluginVersion === target.pluginVersion
  }
  return credential.provider_id === target.providerId
}

export function presetMatchesPersistedModel(
  preset: ModelPreset,
  model: Record<string, unknown>,
): boolean {
  const pluginId = typeof model.plugin_id === 'string' && model.plugin_id ? model.plugin_id : undefined
  const pluginVersion =
    typeof model.plugin_version === 'string' && model.plugin_version ? model.plugin_version : undefined
  if (!pluginId && !pluginVersion) return true
  return (
    'pluginId' in preset &&
    preset.pluginId === pluginId &&
    preset.pluginVersion === pluginVersion &&
    preset.vendorModelId === model.vendor_model_id
  )
}

/** The immutable contract a media revision stores, taken from the plugin manifest. */
export type ModelRevisionContract = {
  capabilities: ModelCapabilities
  defaults: Record<string, JsonValue>
}

/**
 * What a preset contributes to a saved model: its identity. Everything else is
 * read back from the manifest the preset points at, so an image preset and a
 * video preset are the same code path and a preset can never smuggle a parameter
 * the plugin does not accept.
 *
 * A language preset has no media manifest and therefore no contract, which is
 * reported as `null` rather than as an empty one.
 */
export async function presetRevisionContract(
  preset: ModelPreset | null | undefined,
): Promise<ModelRevisionContract | null> {
  if (!preset || preset.modelKind === 'language') return null
  const resolved = await resolvePresetCapabilities(preset.pluginId, preset.pluginVersion, preset.vendorModelId)
  return { capabilities: resolved.capabilities, defaults: resolved.defaults }
}

/**
 * `model_configs.max_input_images` still carries a `CHECK (… <= 4)` from before
 * role-aware input slots existed. The declared slot is the truth the API serves;
 * this only caps the deprecated mirror column so a wide declaration cannot fail
 * the row write.
 */
const LEGACY_MAX_INPUT_IMAGES_CEILING = 4

/**
 * The deprecated flat columns, always derived from the resolved contract.
 *
 * These used to be an input: `input.sizes`, `input.qualityOptions`,
 * `input.maxCount` and `input.maxInputImages` were validated against the plugin
 * and stored, which gave the same fact two authors. They now have exactly one
 * author — the manifest — and the columns are a projection of it, because the
 * columns are NOT NULL in the base schema and `jobDto` still echoes them.
 */
function legacyColumnValues(
  capabilities: ModelCapabilities | null,
  mediaKind: 'image' | 'video' | null,
): { sizes: string | null; qualityOptions: string; maxCount: number | null; maxInputImages: number } {
  const derived = capabilities ? legacyColumnsFromCapabilities(capabilities) : null
  const maxCount = derived?.maxCount
  return {
    sizes: mediaKind === 'image' ? JSON.stringify(derived?.sizes ?? []) : null,
    qualityOptions: mediaKind === 'image' ? JSON.stringify(derived?.qualityOptions ?? []) : '[]',
    maxCount: Number.isInteger(maxCount) && (maxCount as number) >= 1 && (maxCount as number) <= 10
      ? (maxCount as number)
      : null,
    maxInputImages: derived && mediaKind
      ? Math.min(Math.max(derived.maxInputImages, 0), LEGACY_MAX_INPUT_IMAGES_CEILING)
      : 0,
  }
}

async function snapshotRevisionForRow(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  row: Record<string, unknown>,
  actorId: string,
  contract?: ModelRevisionContract | null,
): Promise<Record<string, unknown>> {
  const providerId = (row.provider_id as string) || 'legacy'
  const pluginId = (row.plugin_id as string) || 'legacy-image'
  const pluginVersion = (row.plugin_version as string) || '1.0.0'
  const capabilities = (contract?.capabilities ?? capabilitiesFromRow(row)) as unknown as Record<string, unknown>
  const defaults = contract?.defaults ?? { ...(defaultsFromRow(row)), ...(asRecord(row.defaults) || {}) }
  const digest = snapshotDigest({ modelId: row.id, providerId, pluginId, pluginVersion, capabilities, defaults })
  const existing = await client.query(
    'SELECT id FROM model_config_revisions WHERE model_id=$1 AND snapshot_digest=$2 ORDER BY revision DESC LIMIT 1',
    [row.id, digest],
  )
  let revisionId = existing.rows[0]?.id as string | undefined
  let revision = existing.rows[0] ? Number((await client.query('SELECT revision FROM model_config_revisions WHERE id=$1', [revisionId])).rows[0]?.revision || 1) : 1
  if (!revisionId) {
    const created = await createModelConfigRevision(client as never, {
      modelId: row.id as string,
      providerId,
      pluginId,
      pluginVersion,
      vendorModelId: (row.vendor_model_id as string) || null,
      baseUrl: (row.base_url as string) || null,
      credentialId: (row.provider_credential_id as string) || null,
      credentialSchemaVersion: 1,
      capabilities,
      normalizedConfig: {
        vendorModelId: row.vendor_model_id,
        baseUrl: row.base_url,
        concurrencyLimit: row.concurrency_limit,
        watermark: row.watermark,
        modelKind: row.model_kind,
      },
      defaults,
      snapshotDigest: digest,
      createdBy: actorId,
    })
    revisionId = created.id
    revision = created.revision
  } else {
    await client.query('UPDATE model_configs SET latest_revision_id=$1 WHERE id=$2', [revisionId, row.id])
  }
  return { ...row, capabilities, defaults, revision, latest_revision_id: revisionId }
}

export async function upsertModel(
  actor: Actor,
  input: Record<string, unknown>,
  id?: string,
) {
  const existing = id
    ? (await db().query('SELECT * FROM model_configs WHERE id=$1 AND deleted_at IS NULL', [id]))
        .rows[0]
    : null
  if (id && !existing) return fail('NOT_FOUND', '模型不存在', 404)

  // Uniform across every media kind and both write paths: the parameter contract
  // belongs to the plugin manifest, so a body carrying its own capabilities or
  // defaults is refused instead of persisted. Previously only the hardened image
  // write rejected them, so a video write could author a contract the plugin had
  // never declared. An omitted or empty override stays accepted.
  const overrideError = modelOverrideError(input)
  if (overrideError === 'capabilities') {
    return fail('INVALID_INPUT', 'capabilities 由插件 manifest 声明，不接受自定义覆盖')
  }
  if (overrideError === 'defaults') {
    return fail('INVALID_INPUT', 'defaults 由插件 manifest 声明，不接受自定义覆盖')
  }

  return modelSavePath(input) === 'plugin'
    ? savePluginModel(actor, input, id, existing)
    : savePresetModel(actor, input, id, existing)
}

async function savePluginModel(
  actor: Actor,
  input: Record<string, unknown>,
  id: string | undefined,
  existing: Record<string, any> | null | undefined,
) {
  // Plugin-driven path: explicit provider/plugin identity (image or video).
  // The static registry plus the manifest modality is the only authority:
  // no adapter/provider-string mapping. New image configuration targets the
  // hardened 1.1.0 keys, whose declared contract is then exercised by the
  // plugin's own validateRequest (vendor model, presets, options, integer
  // bounds, reference slot ceiling, endpoint host).
  // Exact 1.0.0 image keys are accepted only when updating an existing row
  // already pinned to that exact key; all other image writes use 1.1.0.
    const pluginId = (input.pluginId as string).trim()
    const pluginVersion = typeof input.pluginVersion === 'string' && input.pluginVersion.trim()
      ? input.pluginVersion.trim()
      : (IMAGE_PLUGIN_IDS[pluginId] ? ACTIVE_IMAGE_PLUGIN_VERSION : '1.0.0')
    const requestedKind = typeof input.modelKind === 'string' && ['image', 'video'].includes(input.modelKind)
      ? input.modelKind
      : (existing?.model_kind as string) || null
    // Catalog membership — not `model_configs.plugin_id` and not the static
    // registry alone — decides whether a plugin exists: an uploaded plugin is
    // bindable once the worker has activated its row.
    const catalog = await resolveCatalogPlugin(pluginId, pluginVersion)
    if (!catalog) return fail('INVALID_PLUGIN', '供应商插件不存在或版本不受支持')
    const provisionalKind = requestedKind || (catalog.manifest.kind === 'media' ? catalog.manifest.modalities[0] : undefined)
    if (!provisionalKind) return fail('INVALID_PLUGIN', '供应商插件不存在或版本不受支持')
    const selection = manifestMediaSelection(catalog.manifest, provisionalKind)
    if (!selection.ok) {
      return fail('INVALID_PLUGIN', '供应商插件不支持该媒体类型')
    }
    const mediaKind = selection.mediaKind
    // The hardened 1.1.0 rules are built-in image keys only. An uploaded image
    // plugin publishes whatever version its manifest declares, so forcing 1.1.0
    // for every image write would make a 1.0.0 upload permanently unbindable.
    const hardenedImageWrite = mediaKind === 'image' && catalog.source === 'builtin' && Boolean(IMAGE_PLUGIN_IDS[pluginId])
    if (hardenedImageWrite && pluginVersion !== ACTIVE_IMAGE_PLUGIN_VERSION) {
      const pinned = id && existing?.plugin_id === pluginId && existing?.plugin_version === pluginVersion
      if (!pinned) return fail('INVALID_INPUT', '新的图片模型配置必须使用插件版本 1.1.0')
    }
    const providerId = (typeof input.providerId === 'string' && input.providerId.trim()
      ? input.providerId.trim()
      : existing?.provider_id || null) as string | null
    if (!providerId) return fail('INVALID_INPUT', '供应商 ID（providerId）必填')
    const displayName = (typeof input.displayName === 'string' && input.displayName.trim()
      ? input.displayName.trim()
      : existing?.display_name) as string | undefined
    if (!displayName) return fail('INVALID_INPUT', '模型名称不能为空')
    const vendorModelId = (typeof input.vendorModelId === 'string' && input.vendorModelId.trim()
      ? input.vendorModelId.trim()
      : existing?.vendor_model_id) as string | undefined
    if (!vendorModelId) return fail('INVALID_INPUT', '供应商模型 ID（vendorModelId）必填')
    // Hardened image keys carry an exhaustive manifest model list: unknown or
    // custom vendor IDs are rejected here so they never reach strict plugin
    // validation. Historical 1.0.0 revisions stay permissive.
    if (hardenedImageWrite) {
      const supported = manifestSupportsVendorModel(
        globalProviderRegistry.get(pluginId, pluginVersion).manifest.models,
        vendorModelId,
      )
      if (!supported) return fail('INVALID_INPUT', '供应商模型 ID（vendorModelId）不受该插件版本支持')
    }
    const baseUrl = input.baseUrl !== undefined
      ? normalizedProviderBaseUrl(input.baseUrl)
      : (existing?.base_url ?? undefined)
    if (baseUrl === null) return fail('INVALID_BASE_URL', 'Base URL 必须是安全的 HTTPS 地址')
    if (hardenedImageWrite) {
      const effectiveBase = (baseUrl === undefined ? existing?.base_url : baseUrl) as string | null | undefined
      if (!imageBaseUrlAllowed(pluginId, effectiveBase)) {
        return fail('INVALID_BASE_URL', '图片插件 1.1.0 仅支持官方服务端点')
      }
    }
    const credId = input.providerCredentialId
    const effectiveCredId = credId === undefined ? existing?.provider_credential_id : credId
    if (typeof effectiveCredId === 'string' && effectiveCredId) {
      const cred = await db().query(
        'SELECT id,base_url,provider_id,configured_fields FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL',
        [effectiveCredId],
      )
      if (!cred.rows[0]) return fail('INVALID_INPUT', '供应商凭据不存在')
      if (!providerCredentialMatchesPluginTarget(cred.rows[0], { providerId, pluginId, pluginVersion })) {
        return fail('INVALID_INPUT', '供应商凭据与模型插件不匹配')
      }
      // A credential base URL overrides the model base URL at runtime, so a
      // custom-host credential must be rejected for hardened image keys even
      // when the model itself points at the official endpoint.
      if (hardenedImageWrite) {
        const credBase = cred.rows[0]?.base_url as string | null | undefined
        if (!imageBaseUrlAllowed(pluginId, credBase)) {
          return fail('INVALID_BASE_URL', '该供应商凭据的 Base URL 非官方服务端点，不能用于图片插件 1.1.0')
        }
      }
    }
    const concurrencyLimit = input.concurrencyLimit === undefined
      ? Number(existing?.concurrency_limit ?? 1)
      : Number(input.concurrencyLimit)
    const sortOrder = input.sortOrder === undefined ? Number(existing?.sort_order ?? 0) : Number(input.sortOrder)
    if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 50 || !Number.isInteger(sortOrder)) {
      return fail('INVALID_INPUT', '并发或排序配置无效')
    }
    // One contract source for both media kinds. Whatever the plugin declares is
    // what the model offers; a model the manifest does not describe (an uploaded
    // plugin that shipped no `capabilities`, or a historical key whose manifest
    // predates the contract) resolves to `undeclared` and offers nothing, which
    // the submit path then refuses. Re-resolving on every save is what keeps the
    // persisted snapshot a copy of the manifest rather than a second opinion.
    const resolved = await resolvePresetCapabilities(pluginId, pluginVersion, vendorModelId)
    if (resolved.findings && resolved.findings.length > 0) {
      return fail('INVALID_MODEL_CAPABILITIES', `插件声明的参数契约无效：${resolved.findings[0].message}`)
    }
    const capabilities = resolved.capabilities
    const defaults = resolved.defaults
    const watermark = typeof input.watermark === 'boolean' ? input.watermark : Boolean(existing?.watermark ?? false)
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : Boolean(existing?.enabled ?? false)
    const columns = legacyColumnValues(capabilities, mediaKind)
    if (hardenedImageWrite) {
      const contract = await validateImageModelContract(globalProviderRegistry.get(pluginId, pluginVersion), {
        vendorModelId,
        capabilities,
      })
      if (!contract.ok) return fail('INVALID_INPUT', contract.message)
    }
    const pluginSource = catalog.source === 'installed' ? 'installed' : 'builtin'
    const row = await transaction(async (client) => {
      let record: Record<string, unknown>
      if (id) {
        const updated = await client.query(
          `UPDATE model_configs SET display_name=$1,vendor_model_id=$2,base_url=$3,sizes=$4::jsonb,quality_options=$5::jsonb,max_count=$6,
            concurrency_limit=$7,enabled=$8,watermark=$9,sort_order=$10,
            provider_credential_id=CASE WHEN $11::text IS NULL THEN provider_credential_id WHEN $11::text = '' THEN NULL ELSE $11::uuid END,
            model_kind=$12,provider_id=$13,plugin_id=$14,plugin_version=$15,max_input_images=$16,plugin_source=$18,updated_at=now()
           WHERE id=$17 AND deleted_at IS NULL RETURNING *`,
          [displayName, vendorModelId, baseUrl === undefined ? existing?.base_url || null : baseUrl || null,
            columns.sizes, columns.qualityOptions, columns.maxCount, concurrencyLimit, enabled, watermark, sortOrder,
            credId === undefined ? null : credId, mediaKind, providerId, pluginId, pluginVersion,
            columns.maxInputImages, id, pluginSource],
        )
        if (!updated.rows[0]) throw new Error('NOT_FOUND')
        record = updated.rows[0]
      } else {
        const inserted = await client.query(
          `INSERT INTO model_configs(display_name,vendor_model_id,base_url,sizes,quality_options,max_count,concurrency_limit,enabled,
            watermark,sort_order,created_by,provider_credential_id,model_kind,provider_id,plugin_id,plugin_version,max_input_images,plugin_source)
           VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
          [displayName, vendorModelId, baseUrl || null, columns.sizes, columns.qualityOptions, columns.maxCount, concurrencyLimit, enabled,
            watermark, sortOrder, actor.id,
            typeof effectiveCredId === 'string' && effectiveCredId ? effectiveCredId : null,
            mediaKind, providerId, pluginId, pluginVersion, columns.maxInputImages, pluginSource],
        )
        record = inserted.rows[0]
      }
      const digest = snapshotDigest({ modelId: record.id, providerId, pluginId, pluginVersion, capabilities, defaults })
      const created = await createModelConfigRevision(client as never, {
        modelId: record.id as string,
        providerId,
        pluginId,
        pluginVersion,
        vendorModelId,
        baseUrl: (baseUrl === undefined ? existing?.base_url : baseUrl) as string | null,
        credentialId: (typeof effectiveCredId === 'string' && effectiveCredId ? effectiveCredId : null) as string | null,
        credentialSchemaVersion: 1,
        capabilities: capabilities as unknown as Record<string, unknown>,
        normalizedConfig: { vendorModelId, concurrencyLimit, watermark, modelKind: mediaKind },
        defaults,
        snapshotDigest: digest,
        createdBy: actor.id,
      })
      await client.query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,summary) VALUES($1,$2,$3,$4,$5)', [
        actor.id, id ? 'model.update' : 'model.create', 'model', record.id, { pluginId, pluginVersion },
      ])
      return { ...record, capabilities, defaults, revision: created.revision, latest_revision_id: created.id }
    })
    return ok(modelDto(row))
}

async function savePresetModel(
  actor: Actor,
  input: Record<string, unknown>,
  id: string | undefined,
  existing: Record<string, any> | null | undefined,
) {
  if (hasForbiddenManualModelFields(input))
    return fail('INVALID_INPUT', '模型参数只能通过预设选择')
  // Preset resolution is catalog-aware so a model can be re-saved from a preset
  // synthesized from an active installed manifest.
  const storedPreset = existing?.preset_id ? await resolvePresetById(existing.preset_id) : null
  const preset =
    input.presetId === undefined
      ? storedPreset && presetMatchesPersistedModel(storedPreset, existing!)
        ? storedPreset
        : null
      : await resolvePresetById(input.presetId)
  if (!id && !preset) return fail('INVALID_PRESET', '请选择模型预设')
  if (input.presetId !== undefined && !preset) return fail('INVALID_PRESET', '模型预设不存在')
  const targetPreset = preset
  const credId = input.providerCredentialId
  const effectiveCredId = credId === undefined ? existing?.provider_credential_id : credId
  const targetKind = targetPreset?.modelKind || existing?.model_kind || 'image'
  if (targetKind === 'language' && (typeof effectiveCredId !== 'string' || !effectiveCredId))
    return fail('LANGUAGE_MODEL_CONFIG_INVALID', '语言模型必须选择供应商凭据')
  if (typeof effectiveCredId === 'string' && effectiveCredId) {
    const cred = await db().query(
      'SELECT id,provider_id,configured_fields FROM provider_credentials WHERE id=$1 AND deleted_at IS NULL',
      [effectiveCredId],
    )
    if (!cred.rows[0]) return fail('INVALID_INPUT', '供应商凭据不存在')
    if (
      targetPreset &&
      'pluginId' in targetPreset &&
      !providerCredentialMatchesPluginTarget(cred.rows[0], {
        providerId: targetPreset.providerId,
        pluginId: targetPreset.pluginId,
        pluginVersion: targetPreset.pluginVersion,
      })
    ) {
      return fail('INVALID_INPUT', '供应商凭据与模型插件不匹配')
    }
  }
  if (targetPreset && 'adapter' in targetPreset && !['openai', 'seedream', 'anthropic'].includes(String(targetPreset.adapter)))
    return fail('INVALID_INPUT', '模型配置无效')
  const concurrencyLimit =
    input.concurrencyLimit === undefined
      ? existing?.concurrency_limit ?? targetPreset?.concurrencyLimit ?? 1
      : Number(input.concurrencyLimit)
  const sortOrder =
    input.sortOrder === undefined ? existing?.sort_order ?? 0 : Number(input.sortOrder)
  if (
    !Number.isInteger(concurrencyLimit) ||
    concurrencyLimit < 1 ||
    concurrencyLimit > 50 ||
    !Number.isInteger(sortOrder)
  )
    return fail('INVALID_INPUT', '并发或排序配置无效')
  const reasoningFallback =
    existing?.reasoning_effort ||
    (targetPreset && 'reasoningEffort' in targetPreset ? targetPreset.reasoningEffort : null) ||
    'medium'
  const reasoningEffort =
    targetKind === 'language' ? sanitizeReasoningEffort(input.reasoningEffort, reasoningFallback) : null
  if (reasoningEffort === undefined && targetKind === 'language')
    return fail('INVALID_INPUT', '思考等级无效')

  // Which resolution path this write pins: 'installed' only when the preset's exact
  // key resolves to an active provider_plugins row. Built-in and language presets
  // keep 'builtin'. Membership is probed in the catalog, never inferred from the
  // backfilled model_configs.plugin_id column.
  const presetPluginId = targetPreset && 'pluginId' in targetPreset ? targetPreset.pluginId : null
  const presetPluginVersion = targetPreset && 'pluginVersion' in targetPreset ? String(targetPreset.pluginVersion) : '1.0.0'
  const presetPluginSource = (presetPluginId && (await resolveCatalogPlugin(presetPluginId, presetPluginVersion))?.source === 'installed')
    ? 'installed'
    : 'builtin'

  // A preset carries identity only, so the contract is read from the manifest it
  // points at — the same lookup the plugin-selected write uses — and the
  // deprecated flat columns are a projection of it rather than a preset field.
  const revisionContract = await presetRevisionContract(targetPreset)
  const presetMediaKind = targetPreset && targetPreset.modelKind !== 'language' ? targetPreset.modelKind : null
  const presetColumns = legacyColumnValues(revisionContract?.capabilities ?? null, presetMediaKind)
  // Seedream declares `watermark` as a parameter; the column is the request
  // default, not a capability, so it stays the admin's choice and off otherwise.
  const presetWatermark = presetMediaKind !== null && input.watermark === true

  let result
  if (id && !targetPreset) {
    result = await db().query(
      `UPDATE model_configs SET concurrency_limit=$1,enabled=COALESCE($2,enabled),watermark=COALESCE($3,watermark),sort_order=$4,provider_credential_id=CASE WHEN $5::text IS NULL THEN provider_credential_id WHEN $5::text = '' THEN NULL ELSE $5::uuid END,reasoning_effort=CASE WHEN model_kind='language' THEN $6 ELSE NULL END,updated_at=now() WHERE id=$7 AND deleted_at IS NULL RETURNING *`,
      [
        concurrencyLimit,
        typeof input.enabled === 'boolean' ? input.enabled : null,
        typeof input.watermark === 'boolean' ? input.watermark : null,
        sortOrder,
        credId === undefined ? null : credId,
        reasoningEffort ?? null,
        id,
      ],
    )
  } else if (id && targetPreset) {
    result = await db().query(
      `UPDATE model_configs SET preset_id=$1,display_name=$2,adapter=$3,vendor_model_id=$4,base_url=$5,sizes=$6,quality_options=$7,max_count=$8,concurrency_limit=$9,enabled=COALESCE($10,enabled),watermark=$11,sort_order=$12,provider_credential_id=CASE WHEN $13::text IS NULL THEN provider_credential_id WHEN $13::text = '' THEN NULL ELSE $13::uuid END,model_kind=$14,language_protocol=$15,max_output_tokens=$16,temperature=$17,reasoning_effort=$18,max_input_images=$19,provider_id=$20,plugin_id=$21,plugin_version=$22,plugin_source=$24,updated_at=now() WHERE id=$23 AND deleted_at IS NULL RETURNING *`,
      [
        targetPreset.id,
        targetPreset.displayName,
        'adapter' in targetPreset ? targetPreset.adapter : existing?.adapter,
        targetPreset.vendorModelId,
        targetPreset.baseUrl,
        presetColumns.sizes,
        presetColumns.qualityOptions,
        presetColumns.maxCount,
        concurrencyLimit,
        typeof input.enabled === 'boolean' ? input.enabled : null,
        presetWatermark,
        sortOrder,
        credId === undefined ? null : credId,
        targetPreset.modelKind,
        targetPreset.modelKind === 'language' ? targetPreset.languageProtocol : null,
        targetPreset.modelKind === 'language' ? targetPreset.maxOutputTokens : null,
        targetPreset.modelKind === 'language' && targetPreset.temperature !== undefined
          ? targetPreset.temperature
          : null,
        targetPreset.modelKind === 'language' ? reasoningEffort ?? null : null,
        presetColumns.maxInputImages,
        'providerId' in targetPreset ? targetPreset.providerId : existing?.provider_id || null,
        'pluginId' in targetPreset ? targetPreset.pluginId : existing?.plugin_id || null,
        'pluginVersion' in targetPreset ? targetPreset.pluginVersion : existing?.plugin_version || '1.0.0',
        id,
        presetPluginSource,
      ],
    )
  } else if (targetPreset) {
    result = await db().query(
      'INSERT INTO model_configs(preset_id,display_name,adapter,vendor_model_id,base_url,sizes,quality_options,max_count,concurrency_limit,enabled,watermark,sort_order,created_by,provider_credential_id,model_kind,language_protocol,max_output_tokens,temperature,reasoning_effort,max_input_images,provider_id,plugin_id,plugin_version,plugin_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *',
      [
        targetPreset.id,
        targetPreset.displayName,
        'adapter' in targetPreset ? targetPreset.adapter : null,
        targetPreset.vendorModelId,
        targetPreset.baseUrl,
        presetColumns.sizes,
        presetColumns.qualityOptions,
        presetColumns.maxCount,
        concurrencyLimit,
        input.enabled === true,
        presetWatermark,
        sortOrder,
        actor.id,
        typeof credId === 'string' && credId ? credId : null,
        targetPreset.modelKind,
        targetPreset.modelKind === 'language' ? targetPreset.languageProtocol : null,
        targetPreset.modelKind === 'language' ? targetPreset.maxOutputTokens : null,
        targetPreset.modelKind === 'language' && targetPreset.temperature !== undefined
          ? targetPreset.temperature
          : null,
        targetPreset.modelKind === 'language' ? reasoningEffort ?? null : null,
        presetColumns.maxInputImages,
        'providerId' in targetPreset ? targetPreset.providerId : null,
        'pluginId' in targetPreset ? targetPreset.pluginId : null,
        'pluginVersion' in targetPreset ? targetPreset.pluginVersion : '1.0.0',
        presetPluginSource,
      ],
    )
  } else {
    return fail('INVALID_PRESET', '请选择模型预设')
  }
  if (!result.rows[0]) return fail('NOT_FOUND', '模型不存在', 404)
  await db().query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,summary) VALUES($1,$2,$3,$4,$5)', [actor.id, id ? 'model.update' : 'model.create', 'model', result.rows[0].id, {}])
  const withRevision = await presetRevisionOrRow(result.rows[0], () => snapshotRevisionForRow(
    db(),
    result.rows[0],
    actor.id,
    revisionContract,
  ))
  return ok(modelDto(withRevision))
}

export async function deleteModel(actor: Actor, id: string) {
  const deleted = await transaction(async (client) => {
    const r = await client.query(
      'UPDATE model_configs SET deleted_at=now(),enabled=false,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id',
      [id],
    )
    if (!r.rows[0]) return false
    await client.query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,summary) VALUES($1,$2,$3,$4,$5)', [actor.id, 'model.delete', 'model', id, {}])
    await client.query(
      'UPDATE prompt_optimization_settings SET enabled=false,language_model_config_id=NULL,updated_by=$2,updated_at=now() WHERE language_model_config_id=$1',
      [id, actor.id],
    )
    return true
  })
  return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '模型不存在', 404)
}
