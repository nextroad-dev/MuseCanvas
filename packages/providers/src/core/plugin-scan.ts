import type { LanguageProviderManifest, MediaProviderManifest } from './types'
import { isPrivateProviderHost } from './url-guard'
import { validateModelCapabilities } from '@musecanvas/contracts'
import type { JsonValue, ModelCapabilities } from '@musecanvas/contracts'

/*
 * LINT, NOT A SANDBOX: this is textual scanning without a JS parser, so `'pr'+'ocess'`,
 * `globalThis[['fe','tch']]` and String.fromCharCode-built specifiers all evade it, while
 * a forbidden token inside a comment or string is still reported. Containment comes from
 * the zero-runtime-import rule plus the host-supplied allowlisted SafeHttpClient.
 *
 * ZERO RUNTIME IMPORTS is required because @musecanvas/providers exports raw TypeScript
 * (package.json "." -> ./src/index.ts), which a plain import() from a worker cache
 * directory cannot parse; only type-only imports survive erasure.
 *
 * Pure and deterministic: no node builtins, no I/O, no clock, so apps/api and apps/worker
 * share one copy and unit-test it without fixtures.
 */

export type PluginScanSeverity = 'error' | 'warn'

export type PluginScanFinding = {
  rule: string
  severity: PluginScanSeverity
  line?: number
  column?: number
  message: string
}

export type AnyProviderManifest = MediaProviderManifest | LanguageProviderManifest

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/
export const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
export const SUPPORTED_CREDENTIAL_SCHEMAS = ['legacy-api-key-v1', 'json-v1', 'access-token-v1'] as const
export const SUPPORTED_LANGUAGE_PROTOCOLS = ['openai_chat', 'openai_responses', 'anthropic_messages'] as const
export const SUPPORTED_MEDIA_MODALITIES = ['image', 'video'] as const
/** Cap for the uploaded .mjs artifact; enforced by the host before any scanning happens. */
export const PLUGIN_ARTIFACT_MAX_BYTES = 5_242_880
/** plugin-packages/<pluginId>/<version>/<sha256>.mjs — the host owns the S3 write. */
export function pluginObjectKey(pluginId: string, version: string, sha256: string): string {
  return `plugin-packages/${pluginId}/${version}/${sha256}.mjs`
}

const NODE_BUILTIN_NAMES = new Set([
  'fs', 'path', 'os', 'net', 'http', 'https', 'dns', 'dgram', 'tls', 'child_process',
  'worker_threads', 'cluster', 'vm', 'module', 'crypto', 'v8', 'perf_hooks', 'worker',
])

const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/

type PatternRule = { rule: string; pattern: RegExp; message: string; precedence: number }

// `precedence` breaks ties when two rules report the same offset; the more specific rule wins.
const PATTERN_RULES: PatternRule[] = [
  {
    rule: 'FORBIDDEN_GLOBAL_FETCH',
    pattern: /globalThis\s*\.\s*fetch\b|globalThis\s*\[\s*['"`]fetch['"`]\s*\]|\bfetch\s*\(/g,
    message: 'global fetch is unavailable; every outbound request must go through ExecutionContext.http',
    precedence: 0,
  },
  {
    rule: 'FORBIDDEN_PROCESS_BRIDGE',
    pattern: /\bprocess\s*\.\s*(?:binding|mainModule)\b/g,
    message: 'process native bridges are forbidden',
    precedence: -1,
  },
  {
    rule: 'FORBIDDEN_PROCESS_ENV',
    pattern: /\bprocess\s*[.[]/g,
    message: 'process.* is forbidden; configuration arrives only through ProviderConfig',
    precedence: 0,
  },
  {
    rule: 'FORBIDDEN_REQUIRE',
    pattern: /\brequire\s*\(|\bcreateRequire\b/g,
    message: 'CommonJS require is forbidden in a self-contained ESM bundle',
    precedence: 0,
  },
  {
    rule: 'FORBIDDEN_DYNAMIC_EVAL',
    pattern: /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/g,
    message: 'runtime code generation is forbidden',
    precedence: 0,
  },
  {
    rule: 'FORBIDDEN_BRACKET_GLOBAL',
    pattern: /globalThis\s*\[/g,
    message: 'computed globalThis access is forbidden',
    precedence: 0,
  },
]

export function scanPluginSource(source: string): PluginScanFinding[] {
  const lineStarts = collectLineStarts(source)
  const hits: Array<{ offset: number; precedence: number; finding: PluginScanFinding }> = []

  const report = (offset: number, precedence: number, rule: string, message: string, severity: PluginScanSeverity = 'error') => {
    const { line, column } = positionOf(lineStarts, offset)
    hits.push({ offset, precedence, finding: { rule, severity, line, column, message } })
  }

  for (const rule of PATTERN_RULES) {
    for (const match of matchAll(source, rule.pattern)) {
      report(match.index, rule.precedence, rule.rule, rule.message)
    }
  }

  // Runtime imports: `import type` and `import.meta` are erased and therefore permitted.
  for (const match of matchAll(source, /\bimport\b/g)) {
    if (isMemberAccess(source, match.index)) continue
    const tail = source.slice(match.index + 'import'.length, match.index + 'import'.length + 40)
    if (/^\s*type\b/.test(tail) || /^\s*\./.test(tail)) continue
    report(
      match.index,
      0,
      'FORBIDDEN_RUNTIME_IMPORT',
      /^\s*\(/.test(tail)
        ? 'dynamic import() is forbidden; the artifact must carry zero runtime imports'
        : 'import statements are forbidden; the artifact must be a self-contained bundle (type-only imports are erased)',
    )
  }
  for (const pattern of [/\bexport\s+(?!type\b)\{[^}]*\}\s*from\b/g, /\bexport\s+(?!type\b)\*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s+from\b/g]) {
    for (const match of matchAll(source, pattern)) {
      report(match.index, 0, 'FORBIDDEN_RUNTIME_IMPORT', 're-exporting from another module is a runtime import')
    }
  }

  for (const match of matchAll(source, /(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*['"`]([^'"`\n]+)['"`]/g)) {
    const specifier = match[1].trim()
    if (!isNodeBuiltinSpecifier(specifier)) continue
    // Point at the specifier itself so the finding never shares a column with the import/require rule.
    report(match.index + match[0].indexOf(match[1]), 0, 'FORBIDDEN_NODE_BUILTIN', `'${specifier}' is a Node builtin; the bundle cannot import platform modules`)
  }

  for (const offset of topLevelAwaitOffsets(source)) {
    report(offset, 0, 'FORBIDDEN_TOP_LEVEL_AWAIT', 'top-level await runs at import time, before any manifest or scan check')
  }

  if (!/\bexport\s+default\b/.test(source)) {
    hits.push({
      offset: source.length,
      precedence: 0,
      finding: { rule: 'NO_DEFAULT_EXPORT', severity: 'warn', message: 'the plugin object is expected as `export default`' },
    })
  }

  const seen = new Set<string>()
  const findings: PluginScanFinding[] = []
  for (const hit of hits.sort((a, b) => a.offset - b.offset || a.precedence - b.precedence)) {
    const key = `${hit.finding.line}:${hit.finding.column}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push(hit.finding)
  }
  return findings
}

export function validatePluginManifest(
  input: unknown,
): { ok: true; manifest: AnyProviderManifest } | { ok: false; findings: PluginScanFinding[] } {
  const source = isRecord(input) ? input : {}
  const findings: PluginScanFinding[] = []
  const reject = (rule: string, message: string) => {
    findings.push({ rule, severity: 'error', message })
  }

  const id = typeof source.id === 'string' ? source.id : ''
  if (!PLUGIN_ID_PATTERN.test(id)) reject('INVALID_PLUGIN_ID', 'id must match ^[a-z][a-z0-9-]{1,40}$')

  const version = typeof source.version === 'string' ? source.version : ''
  if (!PLUGIN_VERSION_PATTERN.test(version)) reject('INVALID_PLUGIN_VERSION', 'version must match ^\\d+\\.\\d+\\.\\d+$')

  const kind = source.kind
  if (kind !== 'media' && kind !== 'language') reject('INVALID_PLUGIN_KIND', "kind must be 'media' or 'language'")

  const displayName = typeof source.displayName === 'string' ? source.displayName.trim() : ''
  if (!displayName) reject('INVALID_DISPLAY_NAME', 'displayName must be a non-empty string')

  const hosts = Array.isArray(source.allowedHosts) ? source.allowedHosts : null
  if (!hosts || hosts.length === 0) reject('EMPTY_ALLOWED_HOSTS', 'allowedHosts must be a non-empty array; an empty allowlist permits no egress')
  for (const host of hosts || []) validateHost(host, reject)

  const schemas = Array.isArray(source.credentialSchemas) ? source.credentialSchemas : null
  if (!schemas || schemas.length === 0) reject('UNSUPPORTED_CREDENTIAL_SCHEMA', 'credentialSchemas must be a non-empty array')
  for (const schema of schemas || []) {
    if (!isSupportedCredentialSchema(schema)) reject('UNSUPPORTED_CREDENTIAL_SCHEMA', `credentialSchemas entry '${String(schema)}' is not one of ${SUPPORTED_CREDENTIAL_SCHEMAS.join(', ')}`)
  }

  const models = Array.isArray(source.models) ? source.models : null
  if (!models || models.length === 0) {
    reject('EMPTY_MODEL_LIST', 'models must be a non-empty array; the active version rejects models outside this list, so an empty list silently permits everything')
  } else {
    for (const model of models) {
      if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) {
        reject('EMPTY_MODEL_LIST', 'every models entry needs a non-empty string id')
        continue
      }
      // A model's parameter contract is attacker-supplied text that the browser
      // renders and the API validates against, so it is checked here, at the
      // door, rather than independently at each consumer. `normalizeMediaModel`
      // then clones what it is given without re-litigating it.
      //
      // Only *malformed* declarations are rejected. A model that declares no
      // contract at all is legitimate for a simple plugin and is reported
      // downstream as `declaredBy: 'undeclared'`, where an admin can see it —
      // this function fails on any finding at all, so a warning here would turn
      // "no parameters declared" into "plugin cannot be installed".
      if (kind === 'media') {
        for (const finding of inspectModelCapabilities(model).findings) {
          reject(finding.rule, `model '${model.id}': ${finding.message}`)
        }
      }
    }
  }

  const declaredModalities = Array.isArray(source.modalities) ? source.modalities : null
  if (kind === 'media') {
    if (!declaredModalities || declaredModalities.length === 0) {
      reject('INVALID_MODALITIES', 'media manifests must declare a non-empty modalities array')
    } else {
      for (const modality of declaredModalities) {
        if (!SUPPORTED_MEDIA_MODALITIES.includes(modality as (typeof SUPPORTED_MEDIA_MODALITIES)[number])) {
          reject('INVALID_MODALITIES', `modalities entry '${String(modality)}' must be 'image' or 'video'`)
        }
      }
    }
  }

  const declaredProtocols = Array.isArray(source.languageProtocols) ? source.languageProtocols : null
  if (kind === 'language') {
    if (!declaredProtocols || declaredProtocols.length === 0) {
      reject('INVALID_LANGUAGE_PROTOCOLS', 'language manifests must declare a non-empty languageProtocols array')
    } else {
      for (const protocol of declaredProtocols) {
        if (!isSupportedLanguageProtocol(protocol)) {
          reject('INVALID_LANGUAGE_PROTOCOLS', `languageProtocols entry '${String(protocol)}' must be one of ${SUPPORTED_LANGUAGE_PROTOCOLS.join(', ')}`)
        }
      }
    }
  }

  if (findings.length) return { ok: false, findings }

  const manifest = kind === 'media'
    ? {
        kind: 'media',
        id,
        version,
        displayName,
        modalities: dedupeStrings(declaredModalities as string[]) as MediaProviderManifest['modalities'],
        ...(typeof source.description === 'string' ? { description: source.description } : {}),
        allowedHosts: dedupeStrings(hosts as string[]),
        credentialSchemas: dedupeStrings(schemas as string[]),
        models: (models as Array<Record<string, unknown>>).map(model => normalizeMediaModel(model, declaredModalities as string[])),
      } satisfies MediaProviderManifest
    : {
        kind: 'language',
        id,
        version,
        displayName,
        ...(typeof source.description === 'string' ? { description: source.description } : {}),
        languageProtocols: dedupeStrings(declaredProtocols as string[]) as LanguageProviderManifest['languageProtocols'],
        allowedHosts: dedupeStrings(hosts as string[]),
        credentialSchemas: dedupeStrings(schemas as string[]),
        models: (models as Array<Record<string, unknown>>).map(normalizeLanguageModel),
      } satisfies LanguageProviderManifest

  return { ok: true, manifest }
}

export function isSupportedCredentialSchema(value: unknown): value is (typeof SUPPORTED_CREDENTIAL_SCHEMAS)[number] {
  return typeof value === 'string' && (SUPPORTED_CREDENTIAL_SCHEMAS as readonly string[]).includes(value)
}

export function isSupportedLanguageProtocol(value: unknown): value is (typeof SUPPORTED_LANGUAGE_PROTOCOLS)[number] {
  return typeof value === 'string' && (SUPPORTED_LANGUAGE_PROTOCOLS as readonly string[]).includes(value)
}

function validateHost(host: unknown, reject: (rule: string, message: string) => void): void {
  const raw = typeof host === 'string' ? host.trim() : ''
  if (!raw || /\s/.test(raw)) {
    reject('INVALID_HOST_PATTERN', 'allowedHosts entries must be non-empty host strings without whitespace')
    return
  }
  if (raw === '*' || (raw.includes('*') && !raw.startsWith('*.'))) {
    reject('WILDCARD_HOST_FORBIDDEN', `'${raw}' is too broad; only an exact host or a '*.' prefix is permitted`)
    return
  }
  // '*.localhost' is as private as 'localhost'; the wildcard only widens the label count.
  const bare = raw.startsWith('*.') ? raw.slice(2) : raw
  if (isIpLiteralHost(bare)) {
    reject('IP_HOST_FORBIDDEN', `'${raw}' is an IP literal; hostnames only`)
    return
  }
  if (isPrivateProviderHost(bare)) {
    reject('PRIVATE_HOST_FORBIDDEN', `'${raw}' is a loopback or private address range`)
    return
  }
  if (!HOST_PATTERN.test(raw)) {
    reject('INVALID_HOST_PATTERN', `'${raw}' must be an exact hostname (scheme, port and path are not permitted)`)
  }
}

function isIpLiteralHost(host: string): boolean {
  if (IPV4_PATTERN.test(host)) return true
  if (/^\[[^\]]*\]$/.test(host)) return true
  return /^[0-9a-f:.]+$/.test(host.toLowerCase()) && host.includes(':')
}

function isNodeBuiltinSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  return NODE_BUILTIN_NAMES.has(specifier.split('/')[0])
}

function normalizeMediaModel(
  model: Record<string, unknown>,
  inheritedModalities: string[],
): NonNullable<MediaProviderManifest['models']>[number] {
  const own = Array.isArray(model.modalities) ? model.modalities.filter(isMediaModality) : []
  const capabilities = inspectModelCapabilities(model).capabilities
  return {
    id: String(model.id),
    ...(typeof model.name === 'string' ? { name: model.name } : {}),
    modalities: (own.length ? own : inheritedModalities) as MediaProviderManifest['modalities'],
    ...(Array.isArray(model.supportedAspectRatios)
      ? { supportedAspectRatios: model.supportedAspectRatios.filter((value): value is string => typeof value === 'string') }
      : {}),
    ...(typeof model.maxBatchSize === 'number' ? { maxBatchSize: model.maxBatchSize } : {}),
    ...(typeof model.maxInputImages === 'number' ? { maxInputImages: model.maxInputImages } : {}),
    ...(typeof model.supportsMask === 'boolean' ? { supportsMask: model.supportsMask } : {}),
    // Until recently this whitelist ended above, which silently dropped every
    // richer field an uploaded plugin declared. That made third-party plugins
    // structurally unable to state their own parameters, so the host had to
    // guess them — the exact coupling this contract removes.
    ...(capabilities ? { capabilities } : {}),
    ...(isRecord(model.defaults) ? { defaults: cloneJsonRecord(model.defaults) } : {}),
    ...(typeof model.deprecated === 'boolean' ? { deprecated: model.deprecated } : {}),
    ...(typeof model.deprecationNote === 'string' ? { deprecationNote: model.deprecationNote } : {}),
  }
}

/**
 * Validate and structurally clone a manifest model's declared parameter contract.
 *
 * `defaults` is a sibling of `capabilities` in the manifest but is validated
 * together with it, because a default value is only meaningful against the
 * descriptors it belongs to. `validateModelCapabilities` consumes it for that
 * check and deliberately does not copy it into the returned contract, so
 * merging it in here cannot leak it into the persisted manifest.
 *
 * The returned `capabilities` is a field-by-field rebuild, never the input
 * object: this manifest is persisted as jsonb and re-served to the browser on
 * every model listing, so untrusted keys must not ride along.
 */
function inspectModelCapabilities(model: Record<string, unknown>): {
  findings: Array<{ rule: string; message: string }>
  capabilities?: ModelCapabilities
} {
  const raw = model.capabilities
  if (raw === undefined) return { findings: [] }
  if (!isRecord(raw)) {
    return { findings: [{ rule: 'INVALID_MODEL_CAPABILITIES', message: 'capabilities must be an object when present' }] }
  }
  const probe = { ...raw, ...(isRecord(model.defaults) ? { defaults: model.defaults } : {}) }
  const result = validateModelCapabilities(probe)
  if (!result.ok || !result.capabilities) return { findings: result.findings }
  return { findings: [], capabilities: result.capabilities }
}

/** Keep only JSON-safe entries so a manifest copy cannot smuggle in nesting depth. */
function cloneJsonRecord(source: Record<string, unknown>): Record<string, JsonValue> {
  const cloned: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === null) {
      cloned[key] = null
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (typeof value !== 'number' || Number.isFinite(value)) cloned[key] = value
    } else if (Array.isArray(value) && value.every((entry) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry))) {
      cloned[key] = value as JsonValue
    }
    // Nested objects are dropped: a parameter default is a scalar or a flat list.
  }
  return cloned
}

function normalizeLanguageModel(model: Record<string, unknown>): NonNullable<LanguageProviderManifest['models']>[number] {
  return {
    id: String(model.id),
    ...(typeof model.name === 'string' ? { name: model.name } : {}),
    ...(typeof model.maxInputTokens === 'number' ? { maxInputTokens: model.maxInputTokens } : {}),
    ...(typeof model.maxOutputTokensDefault === 'number' ? { maxOutputTokensDefault: model.maxOutputTokensDefault } : {}),
    ...(typeof model.supportsStructuredOutput === 'boolean' ? { supportsStructuredOutput: model.supportsStructuredOutput } : {}),
  }
}

function isMediaModality(value: unknown): value is 'image' | 'video' {
  return value === 'image' || value === 'video'
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function matchAll(source: string, pattern: RegExp): RegExpExecArray[] {
  const clone = new RegExp(pattern.source, pattern.flags)
  const matches: RegExpExecArray[] = []
  let match: RegExpExecArray | null
  while ((match = clone.exec(source)) !== null) {
    if (match[0] === '') clone.lastIndex += 1
    matches.push(match)
  }
  return matches
}

function isMemberAccess(source: string, index: number): boolean {
  const previous = source[index - 1]
  return previous === '.' || previous === '$'
}

function collectLineStarts(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function positionOf(lineStarts: number[], index: number): { line: number; column: number } {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (lineStarts[middle] <= index) low = middle
    else high = middle - 1
  }
  return { line: low + 1, column: index - lineStarts[low] + 1 }
}

/**
 * Brace-depth walk (strings, template interpolations and comments skipped) that yields the
 * offsets of `await` tokens outside every brace block. An `await` nested in a top-level
 * `if {}` block is not reported; the bundle rule is what actually contains import-time work.
 */
function topLevelAwaitOffsets(source: string): number[] {
  const offsets: number[] = []
  let depth = 0
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index)
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index)
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      index = skipQuoted(source, index)
      continue
    }
    if (char === '{') {
      depth += 1
      index += 1
      continue
    }
    if (char === '}') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (isIdentifierStart(char)) {
      const end = readIdentifier(source, index)
      const word = source.slice(index, end)
      if (word === 'await' && depth === 0 && source[index - 1] !== '.' && !isInsideNonBracedAsync(source, index)) offsets.push(index)
      index = end
      continue
    }
    index += 1
  }
  return offsets
}

/** `async () => await x` has no braces, so an unbraced async body is detected textually. */
function isInsideNonBracedAsync(source: string, index: number): boolean {
  return /\basync\b[^{};]*$/.test(source.slice(Math.max(0, index - 120), index))
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char)
}

function readIdentifier(source: string, start: number): number {
  let index = start
  while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1
  return index
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf('\n', start)
  return newline === -1 ? source.length : newline + 1
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf('*/', start + 2)
  return end === -1 ? source.length : end + 2
}

function skipQuoted(source: string, start: number): number {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) return index + 1
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      index = skipInterpolation(source, index + 1)
      continue
    }
    // An unterminated ' or " is a parse error anyway; bail so the rest of the file is still scanned.
    if (quote !== '`' && char === '\n') return index + 1
    index += 1
  }
  return index
}

function skipInterpolation(source: string, start: number): number {
  let depth = 0
  let index = start
  while (index < source.length) {
    const char = source[index]
    if (char === '"' || char === "'" || char === '`') {
      index = skipQuoted(source, index)
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      index += 1
      if (depth === 0) return index
      continue
    }
    index += 1
  }
  return index
}
