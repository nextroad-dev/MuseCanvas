import { db } from '@musecanvas/database'
import {
  globalPluginRegistry,
  hostMatchesAllowlist,
  pluginCredentialSpec,
  validatePluginManifest,
  type AnyProviderManifest,
} from '@musecanvas/providers'
import { parseRevisionJsonField } from '../../shared/dto'
import { presetById } from '../../shared/model-helpers'
import { modelPresets, type ModelPreset } from '../../admin/model-preset-defs'

export type CatalogPluginSource = 'builtin' | 'installed'

export type CatalogPlugin = {
  source: CatalogPluginSource
  manifest: AnyProviderManifest
}

/** Prefix of a synthesized preset id; also the guard that skips the DB lookup. */
export const INSTALLED_PRESET_PREFIX = 'installed:'

const pluginKeyOf = (manifest: AnyProviderManifest): string => `${manifest.id}@${manifest.version}`

/**
 * THE API NEVER IMPORTS PLUGIN CODE. Loading a `.mjs` artifact requires the
 * worker's sandboxed import path, so for an installed plugin the row's whitelisted
 * manifest copy is the complete truth here: capabilities, hosts and models only.
 *
 * `model_configs.plugin_id` alone is not evidence of a usable plugin: an installed
 * row may since have been disabled, and migration 0012's backfill still left a few
 * ids that no plugin claims (`<adapter>-video` for a non-Seedance adapter, …).
 * Every "is this plugin usable" question therefore goes through this catalog — a
 * built-in registry key or a `status='active'` `provider_plugins` row.
 */
export async function listCatalogManifests(): Promise<CatalogPlugin[]> {
  const builtin = builtinCatalogPlugins()
  const installed = await listInstalledCatalogPlugins()
  const claimed = new Set(builtin.map(entry => pluginKeyOf(entry.manifest)))
  // A built-in key always wins: the worker cannot re-register a duplicate key, so a
  // colliding row could never be loaded and must not shadow the shipped plugin.
  return [...builtin, ...installed.filter(entry => !claimed.has(pluginKeyOf(entry.manifest)))]
}

export async function listInstalledCatalogPlugins(): Promise<CatalogPlugin[]> {
  const r = await db().query(
    `SELECT manifest FROM provider_plugins
      WHERE status='active' AND deleted_at IS NULL
      ORDER BY plugin_id, plugin_version`,
  )
  const entries: CatalogPlugin[] = []
  for (const row of r.rows) {
    const manifest = asCatalogManifest(row.manifest)
    if (manifest) entries.push({ source: 'installed', manifest })
  }
  return entries
}

export async function resolveCatalogPlugin(pluginId: string, pluginVersion: string): Promise<CatalogPlugin | null> {
  // Built-ins (media and language) resolve synchronously so the common path stays DB-free.
  const builtin = builtinCatalogPlugin(pluginId, pluginVersion)
  if (builtin) return builtin
  let row: Record<string, unknown> | undefined
  try {
    const r = await db().query(
      `SELECT manifest FROM provider_plugins
        WHERE plugin_id=$1 AND plugin_version=$2 AND status='active' AND deleted_at IS NULL LIMIT 1`,
      [pluginId, pluginVersion],
    )
    row = r.rows[0]
  } catch (error) {
    // A catalog read failure degrades to built-in-only membership, which is exactly
    // the pre-upload behavior: an installed plugin must be *proven* active before
    // anything may bind to it, so refusing is the safe direction. Listing endpoints
    // keep throwing (see listInstalledCatalogPlugins) because an empty catalog there
    // would silently hide rows.
    console.error('plugin catalog read failed', error instanceof Error ? `${error.name} ${error.message}`.trim() : error)
    return null
  }
  const manifest = row ? asCatalogManifest(row.manifest) : null
  return manifest ? { source: 'installed', manifest } : null
}

export async function isCatalogPluginActive(pluginId: string, pluginVersion: string): Promise<boolean> {
  return (await resolveCatalogPlugin(pluginId, pluginVersion)) !== null
}

/** Row jsonb is re-validated rather than trusted: a drifted manifest degrades to "unusable". */
function asCatalogManifest(value: unknown): AnyProviderManifest | null {
  const parsed = parseRevisionJsonField(value)
  if (!parsed) return null
  const validated = validatePluginManifest(parsed)
  return validated.ok ? validated.manifest : null
}

function builtinCatalogPlugins(): CatalogPlugin[] {
  return globalPluginRegistry.listManifests().map(manifest => ({ source: 'builtin' as const, manifest }))
}

function builtinCatalogPlugin(pluginId: string, pluginVersion: string): CatalogPlugin | null {
  switch (globalPluginRegistry.kindOf(pluginId, pluginVersion)) {
    case 'media':
      return { source: 'builtin', manifest: globalPluginRegistry.getMedia(pluginId, pluginVersion).manifest }
    case 'language':
      return { source: 'builtin', manifest: globalPluginRegistry.getLanguage(pluginId, pluginVersion).manifest }
    default:
      return null
  }
}

/** The plugin's declared (or derived) default endpoint, or '' when it names none. */
export function installedPluginBaseUrl(manifest: AnyProviderManifest): string {
  return pluginCredentialSpec(manifest).baseUrl.default ?? ''
}

/** Egress policy for a plugin, in exactly the grammar SafeHttpClient enforces. */
export function manifestAllowsHost(manifest: AnyProviderManifest, host: string): boolean {
  return hostMatchesAllowlist(host, manifest.allowedHosts || [])
}

/**
 * Pure so the derivation is testable without a database.
 *
 * An uploaded plugin publishes exactly what its manifest declares, which for a
 * preset means: its identity. Parameters, modes, input slots, batch ceilings and
 * defaults are read from the same manifest through `resolvePresetCapabilities`
 * when the model is saved, so there is no generic fallback here to drift from it.
 * A manifest that declares no contract therefore offers no contract, and the
 * admin sees an undeclared model instead of a fabricated one.
 */
export function presetsForCatalogPlugins(entries: CatalogPlugin[]): ModelPreset[] {
  const presets: ModelPreset[] = []
  for (const entry of entries) {
    const manifest = entry.manifest
    if (manifest.kind !== 'media') continue
    const baseUrl = installedPluginBaseUrl(manifest)
    for (const model of manifest.models || []) {
      // The per-model modality wins; the manifest list is only the inherited default.
      const modality = model.modalities?.[0] || manifest.modalities[0]
      if (modality !== 'image' && modality !== 'video') continue
      presets.push({
        modelKind: modality,
        id: `${INSTALLED_PRESET_PREFIX}${manifest.id}@${manifest.version}:${model.id}`,
        displayName: `${manifest.displayName} · ${model.name || model.id}`,
        providerId: pluginCredentialSpec(manifest).providerId,
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        vendorModelId: model.id,
        baseUrl,
        concurrencyLimit: 1,
      })
    }
  }
  return presets
}

/** Static presets plus one synthetic preset per model of every active installed media manifest. */
export async function listModelPresets(): Promise<ModelPreset[]> {
  const installed = (await listCatalogManifests()).filter(entry => entry.source === 'installed')
  return [...modelPresets, ...presetsForCatalogPlugins(installed)]
}

export async function resolvePresetById(value: unknown): Promise<ModelPreset | null> {
  const staticPreset = presetById(value)
  if (staticPreset) return staticPreset
  if (typeof value !== 'string' || !value.startsWith(INSTALLED_PRESET_PREFIX)) return null
  // Same degradation rule as resolveCatalogPlugin: an unreadable catalog means "no
  // such preset" rather than a write against an unverifiable plugin.
  const installed = await listInstalledCatalogPlugins().catch(() => [] as CatalogPlugin[])
  return presetsForCatalogPlugins(installed).find(preset => preset.id === value) || null
}
