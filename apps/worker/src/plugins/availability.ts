import {
  decodeCredential,
  formatPluginKey,
  globalPluginRegistry,
  globalProviderRegistry,
  isBuiltinLanguagePluginKey,
  NormalizedProviderError,
  parsePluginKey,
} from '@musecanvas/providers'
import type {
  DecodedCredential,
  ExecutionContext,
  LanguageProviderPlugin,
  MediaProviderPlugin,
  ProviderConfig,
} from '@musecanvas/providers'

/*
 * The gate between the append-only plugin registries and the mutable catalog.
 *
 * `globalProviderRegistry` / `globalPluginRegistry` can never forget a key (no
 * unregister by design), so registration alone says nothing about whether an
 * admin still considers a package usable. This module mirrors `provider_plugins`
 * into memory: an installed key resolves only while the catalog says `active`.
 *
 * Built-in keys (media and language) are the exception and are checked first:
 * they ship in the image, have no `provider_plugins` row, and must keep resolving
 * no matter what the catalog (or a bogus row shadowing their id) claims.
 */

export type PluginAvailability = 'active' | 'disabled' | 'failed' | 'untracked'

/** Snapshot taken before any artifact is loaded: exactly the bundled built-in plugins, both kinds. */
const BUILTIN_KEYS: ReadonlySet<string> = new Set(
  globalPluginRegistry.listManifests().map(manifest => formatPluginKey(manifest.id, manifest.version)),
)

const statuses = new Map<string, PluginAvailability>()

export function isBuiltinPluginKey(pluginId: string, version: string): boolean {
  return BUILTIN_KEYS.has(formatPluginKey(pluginId, version))
}

/** Registered built-in keys, for boot assertions and call-site invariants. */
export function builtinPluginKeys(): string[] {
  return [...BUILTIN_KEYS]
}

/**
 * Asserts the built-in invariant instead of assuming it: every key the image
 * registered must resolve through this gate with an empty catalog, or the worker
 * would come up serving nothing. Returns the count for boot logging.
 */
export function assertBuiltinPluginsAvailable(): number {
  for (const key of BUILTIN_KEYS) {
    const { id, version } = parsePluginKey(key)
    if (globalPluginRegistry.kindOf(id, version) === 'language') resolveLanguagePlugin(id, version)
    else resolveMediaPlugin(id, version)
  }
  return BUILTIN_KEYS.size
}

export function statusOf(pluginId: string, version: string): PluginAvailability {
  if (isBuiltinPluginKey(pluginId, version)) return 'active'
  return statuses.get(formatPluginKey(pluginId, version)) ?? 'untracked'
}

/**
 * `untracked` (no catalog row seen, or a refresh that never completed) is
 * deliberately not available: an installed plugin the worker cannot account for
 * must not run on the strength of a stale registry entry.
 */
export function isPluginAvailable(pluginId: string, version: string): boolean {
  return statusOf(pluginId, version) === 'active'
}

export function setPluginStatus(pluginId: string, version: string, status: 'active' | 'disabled' | 'failed'): void {
  statuses.set(formatPluginKey(pluginId, version), status)
}

/** Drops a key back to `untracked`, so the next refresh re-reads the truth. */
export function forgetPluginStatus(pluginId: string, version: string): void {
  statuses.delete(formatPluginKey(pluginId, version))
}

/** Installed (non-builtin) keys currently marked active — the loader's 40-plugin cap counter. */
export function installedActiveCount(): number {
  let count = 0
  for (const [key, status] of statuses) {
    if (status !== 'active' || BUILTIN_KEYS.has(key)) continue
    count += 1
  }
  return count
}

/** Keys mirrored from the catalog, so a full sweep can prune the ones that vanished. */
export function trackedPluginKeys(): Array<{ pluginId: string; pluginVersion: string }> {
  return [...statuses.keys()].map(key => {
    const at = key.lastIndexOf('@')
    return { pluginId: key.slice(0, at), pluginVersion: key.slice(at + 1) }
  })
}

/**
 * Disabled and unaccounted-for plugins fail with the *same* error the registries
 * already throw for an unregistered key, so `classifySubmitError` and every job
 * path keep working unchanged.
 */
function unavailable(pluginId: string, version: string, status: PluginAvailability): NormalizedProviderError {
  const key = formatPluginKey(pluginId, version)
  const reason = status === 'disabled' ? 'is disabled' : status === 'failed' ? 'failed to load' : 'is not registered'
  return NormalizedProviderError.create(pluginId, version, 'PROVIDER_NOT_CONFIGURED', `Plugin '${key}' ${reason}`)
}

export function resolveMediaPlugin(pluginId: string, version: string): MediaProviderPlugin {
  const status = statusOf(pluginId, version)
  if (status !== 'active') throw unavailable(pluginId, version, status)
  return globalProviderRegistry.get(pluginId, version)
}

export function resolveLanguagePlugin(pluginId: string, version: string): LanguageProviderPlugin {
  const status = statusOf(pluginId, version)
  if (status !== 'active') throw unavailable(pluginId, version, status)
  return globalPluginRegistry.getLanguage(pluginId, version)
}

/**
 * An egress-capable context is only ever handed out after the availability gate,
 * so a disabled plugin cannot keep talking to its provider via a registry entry
 * that outlives its catalog status.
 */
export function createMediaExecutionContext(
  pluginId: string,
  version: string,
  options?: { config?: ProviderConfig; fetchImpl?: typeof globalThis.fetch; additionalAllowedHosts?: string[] },
): ExecutionContext {
  resolveMediaPlugin(pluginId, version)
  return globalProviderRegistry.createExecutionContext(pluginId, version, options)
}

/**
 * Extra payload for `callLanguageModel`, or `undefined` to keep the native
 * protocol path byte-identical. This is the language kernel's availability gate
 * for uploaded language plugins: `callLanguageModel` itself only checks registry
 * membership, so a caller that skipped this helper would keep using a disabled
 * package.
 *
 * Built-in language keys ('openai-language@1.0.0', 'anthropic-language@1.0.0' —
 * the ids migration 0012 backfilled onto historical rows) are the native protocol
 * path itself, so they return `undefined` too. Any other key that is not a
 * registered language plugin also stays on the native path.
 */
export function installedLanguagePluginBinding(input: {
  pluginId?: string | null
  pluginVersion?: string | null
  apiKey: string
  credentialSchema?: string | null
}): { pluginId: string; pluginVersion: string; credential: DecodedCredential } | undefined {
  const pluginId = input.pluginId
  const pluginVersion = input.pluginVersion
  if (!pluginId || !pluginVersion) return undefined
  if (isBuiltinLanguagePluginKey(pluginId, pluginVersion)) return undefined
  if (globalPluginRegistry.kindOf(pluginId, pluginVersion) !== 'language') return undefined
  resolveLanguagePlugin(pluginId, pluginVersion)
  return {
    pluginId,
    pluginVersion,
    credential: decodeCredential(input.apiKey, input.credentialSchema || undefined, pluginId, pluginVersion),
  }
}

/** Test/inspection helper: clears every mirrored catalog status (registries stay untouched). */
export function resetPluginAvailability(): void {
  statuses.clear()
}
