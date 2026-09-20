import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLUGIN_ARTIFACT_MAX_BYTES,
  pluginObjectKey,
  scanPluginSource,
  validatePluginManifest,
  type PluginScanFinding,
} from './index'

const errorFindings = (source: string): PluginScanFinding[] =>
  scanPluginSource(source).filter(finding => finding.severity === 'error')

const rulesOf = (source: string): string[] => errorFindings(source).map(finding => finding.rule)

/** Asserts the source trips exactly one error-severity rule and returns it. */
function onlyRule(source: string): string {
  const rules = rulesOf(source)
  assert.equal(rules.length, 1, `${source} -> ${JSON.stringify(scanPluginSource(source))}`)
  return rules[0]
}

const VALID_MEDIA_MANIFEST = {
  kind: 'media',
  id: 'acme-image',
  version: '1.0.0',
  displayName: 'Acme Image',
  modalities: ['image', 'video'],
  allowedHosts: ['api.acme-image.com', '*.slot.acme-image.com'],
  credentialSchemas: ['legacy-api-key-v1', 'json-v1'],
  models: [
    { id: 'acme-1', name: 'Acme One', supportedAspectRatios: ['1:1'], maxBatchSize: 4 },
    { id: 'acme-2', modalities: ['video'] },
  ],
  // Unknown keys must never reach the stored manifest JSON.
  evil: '<script>alert(1)</script>',
}

const VALID_LANGUAGE_MANIFEST = {
  kind: 'language',
  id: 'acme-llm',
  version: '2.1.3',
  displayName: 'Acme LLM',
  languageProtocols: ['openai_chat', 'anthropic_messages'],
  allowedHosts: ['api.acme-llm.com'],
  credentialSchemas: ['access-token-v1'],
  models: [{ id: 'acme-large', maxInputTokens: 200000, supportsStructuredOutput: true }],
}

// A realistic self-contained artifact: type-only import (erased), no fetch/process/require,
// every await inside a method body, plugin object as `export default`.
const CLEAN_BUNDLE = [
  "import type { LanguageExecutionContext, LanguageRequest, ProviderConfig } from '@musecanvas/providers'",
  'const manifest = {',
  "  kind: 'language',",
  "  id: 'acme-llm',",
  "  version: '1.0.0',",
  "  displayName: 'Acme LLM',",
  "  allowedHosts: ['api.acme-llm.com'],",
  '}',
  'const plugin = {',
  '  manifest,',
  '  validateConfig() {},',
  '  async complete(request, config, context) {',
  "    const response = await context.http.post('https://api.acme-llm.com/v1/chat', JSON.stringify({ prompt: request.user }), { timeoutMs: request.timeoutMs })",
  '    const body = await response.json()',
  "    return { text: body.output_text || '' }",
  '  },',
  '}',
  'export default plugin',
]

test('clean self-contained bundle yields zero findings', () => {
  assert.deepEqual(scanPluginSource(CLEAN_BUNDLE.join('\n')), [])
})

test('FORBIDDEN_GLOBAL_FETCH catches bare fetch and globalThis.fetch', () => {
  const findings = errorFindings("const f = fetch('https://api.example.com')")
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'FORBIDDEN_GLOBAL_FETCH')
  assert.equal(findings[0].severity, 'error')
  assert.equal(findings[0].line, 1)
  assert.equal(findings[0].column, 11)
  assert.equal(onlyRule('const f = globalThis.fetch'), 'FORBIDDEN_GLOBAL_FETCH')
  assert.equal(onlyRule('const f = globalThis["fetch"]'), 'FORBIDDEN_GLOBAL_FETCH')
  assert.deepEqual(rulesOf("const f = fetch('x')\nconst g = globalThis.fetch"), [
    'FORBIDDEN_GLOBAL_FETCH',
    'FORBIDDEN_GLOBAL_FETCH',
  ])
})

test('FORBIDDEN_PROCESS_ENV catches process.env and any process member access', () => {
  const findings = errorFindings('const a = 1\nconst b = 2\nconst c = process.env.API_KEY')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'FORBIDDEN_PROCESS_ENV')
  assert.equal(findings[0].line, 3)
  assert.equal(findings[0].column, 11)
  assert.equal(onlyRule('const t = process.hrtime()'), 'FORBIDDEN_PROCESS_ENV')
  assert.equal(onlyRule("const k = process['env']"), 'FORBIDDEN_PROCESS_ENV')
})

test('FORBIDDEN_PROCESS_BRIDGE is reported instead of the broader process rule at the same spot', () => {
  assert.equal(onlyRule("const b = process.binding('fs')"), 'FORBIDDEN_PROCESS_BRIDGE')
  assert.equal(onlyRule('const m = process.mainModule'), 'FORBIDDEN_PROCESS_BRIDGE')
})

test('FORBIDDEN_REQUIRE catches require calls and createRequire', () => {
  assert.equal(onlyRule('const r = createRequire(import.meta.url)'), 'FORBIDDEN_REQUIRE')
  assert.deepEqual(rulesOf('const m = require("other")'), ['FORBIDDEN_REQUIRE'])
})

test('FORBIDDEN_RUNTIME_IMPORT catches imports and dynamic import but not type-only forms', () => {
  assert.equal(onlyRule("import { decodeCredential } from './core/credentials'"), 'FORBIDDEN_RUNTIME_IMPORT')
  assert.equal(onlyRule("const m = import('https://cdn.example/plugin.mjs')"), 'FORBIDDEN_RUNTIME_IMPORT')
  assert.equal(onlyRule("export { helper } from './helper.mjs'"), 'FORBIDDEN_RUNTIME_IMPORT')
  assert.equal(onlyRule("export * as ns from './ns.mjs'"), 'FORBIDDEN_RUNTIME_IMPORT')
  // `import type` and `import.meta` are erased by the bundler, so they are permitted.
  assert.deepEqual(rulesOf("import type { ProviderConfig } from '@musecanvas/providers'"), [])
  assert.deepEqual(rulesOf("export type { ProviderConfig } from '@musecanvas/providers'"), [])
  assert.deepEqual(rulesOf('const u = import.meta.url\nexport default u'), [])
})

test('FORBIDDEN_NODE_BUILTIN catches node-prefixed and bare builtin specifiers', () => {
  assert.deepEqual(rulesOf("import fs from 'node:fs'").sort(), [
    'FORBIDDEN_NODE_BUILTIN',
    'FORBIDDEN_RUNTIME_IMPORT',
  ])
  assert.deepEqual(rulesOf("const c = require('crypto')").sort(), [
    'FORBIDDEN_NODE_BUILTIN',
    'FORBIDDEN_REQUIRE',
  ])
  assert.deepEqual(
    rulesOf("export default { load() { return import('node:worker_threads') } }").sort(),
    ['FORBIDDEN_NODE_BUILTIN', 'FORBIDDEN_RUNTIME_IMPORT'],
  )
  // A relative, non-builtin specifier is not reported by the builtin rule.
  assert.deepEqual(rulesOf("import styles from './plugin.css'"), ['FORBIDDEN_RUNTIME_IMPORT'])
})

test('FORBIDDEN_DYNAMIC_EVAL catches eval, new Function and Function()', () => {
  assert.equal(onlyRule("const v = eval('1 + 1')"), 'FORBIDDEN_DYNAMIC_EVAL')
  assert.equal(onlyRule("const f = new Function('return 1')()"), 'FORBIDDEN_DYNAMIC_EVAL')
  assert.equal(onlyRule("const g = Function('return 1')"), 'FORBIDDEN_DYNAMIC_EVAL')
})

test('FORBIDDEN_TOP_LEVEL_AWAIT catches import-time await but not await inside a method', () => {
  const findings = scanPluginSource('const ready = await boot()\nexport default { ready }')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'FORBIDDEN_TOP_LEVEL_AWAIT')
  assert.equal(findings[0].line, 1)
  // Parentheses do not open a block, so a parenthesized top-level await is still caught.
  assert.deepEqual(rulesOf('const ready = (await boot())\nexport default ready'), ['FORBIDDEN_TOP_LEVEL_AWAIT'])
  assert.deepEqual(rulesOf('export default { async go() { await Promise.resolve(1) } }'), [])
  assert.deepEqual(rulesOf('export default { go: async () => await Promise.resolve(1) }'), [])
  // An unbraced async arrow body has no braces to hide behind; the textual `async` guard covers it.
  assert.deepEqual(rulesOf('const go = async () => await Promise.resolve(1)\nexport default go'), [])
})

test('FORBIDDEN_BRACKET_GLOBAL catches computed globalThis access', () => {
  assert.equal(onlyRule("const w = globalThis['loc' + 'ation']"), 'FORBIDDEN_BRACKET_GLOBAL')
})

test('NO_DEFAULT_EXPORT is the only warn-severity finding and carries no position', () => {
  const findings = scanPluginSource('const helper = 1')
  assert.deepEqual(findings, [
    { rule: 'NO_DEFAULT_EXPORT', severity: 'warn', message: 'the plugin object is expected as `export default`' },
  ])
  assert.deepEqual(
    scanPluginSource("const f = fetch('x')").map(finding => finding.severity).sort(),
    ['error', 'warn'],
  )
  assert.ok(scanPluginSource(CLEAN_BUNDLE.join('\n')).every(finding => finding.severity === 'error'))
})

test('findings are ordered by position and report a 1-based line and column', () => {
  const findings = scanPluginSource("const f = fetch('x')\nimport fs from 'node:fs'\nexport default process.env")
  assert.deepEqual(findings.map(finding => finding.line), [1, 2, 2, 3])
  assert.deepEqual(findings.map(finding => finding.rule), [
    'FORBIDDEN_GLOBAL_FETCH',
    'FORBIDDEN_RUNTIME_IMPORT',
    'FORBIDDEN_NODE_BUILTIN',
    'FORBIDDEN_PROCESS_ENV',
  ])
  for (const finding of findings) {
    assert.ok((finding.line ?? 0) >= 1)
    assert.ok((finding.column ?? 0) >= 1)
    assert.equal(typeof finding.message, 'string')
  }
})

test('validatePluginManifest accepts well-formed media and language manifests and normalizes them', () => {
  const media = validatePluginManifest(VALID_MEDIA_MANIFEST)
  assert.equal(media.ok, true)
  if (!media.ok) return
  assert.equal(media.manifest.kind, 'media')
  assert.equal(media.manifest.id, 'acme-image')
  assert.deepEqual(media.manifest.allowedHosts, ['api.acme-image.com', '*.slot.acme-image.com'])
  // Unknown keys are dropped before the manifest is persisted as authoritative JSON.
  assert.equal('evil' in media.manifest, false)
  if (media.manifest.kind !== 'media') return
  assert.deepEqual(media.manifest.models?.[0]?.modalities, ['image', 'video'])
  assert.deepEqual(media.manifest.models?.[1]?.modalities, ['video'])
  assert.deepEqual(media.manifest.models?.[0]?.supportedAspectRatios, ['1:1'])

  const language = validatePluginManifest(VALID_LANGUAGE_MANIFEST)
  assert.equal(language.ok, true)
  if (!language.ok || language.manifest.kind !== 'language') return
  assert.deepEqual(language.manifest.languageProtocols, ['openai_chat', 'anthropic_messages'])
  assert.equal(language.manifest.models?.[0]?.maxInputTokens, 200000)
})

test('validatePluginManifest reports one stable rule per contract violation', () => {
  const rulesFor = (patch?: Record<string, unknown>): string[] => {
    const result = validatePluginManifest(patch === undefined ? undefined : { ...VALID_MEDIA_MANIFEST, ...patch })
    return result.ok ? [] : result.findings.map(finding => finding.rule)
  }

  assert.ok(rulesFor({ id: 'Acme' }).includes('INVALID_PLUGIN_ID'))
  assert.ok(rulesFor({ id: 'a' }).includes('INVALID_PLUGIN_ID'))
  assert.ok(rulesFor({ version: '1.0' }).includes('INVALID_PLUGIN_VERSION'))
  assert.ok(rulesFor({ kind: 'storage' }).includes('INVALID_PLUGIN_KIND'))
  assert.ok(rulesFor({ displayName: '  ' }).includes('INVALID_DISPLAY_NAME'))
  assert.ok(rulesFor({ allowedHosts: [] }).includes('EMPTY_ALLOWED_HOSTS'))
  assert.ok(rulesFor({ allowedHosts: ['*'] }).includes('WILDCARD_HOST_FORBIDDEN'))
  assert.ok(rulesFor({ allowedHosts: ['api*.example.com'] }).includes('WILDCARD_HOST_FORBIDDEN'))
  assert.ok(rulesFor({ allowedHosts: ['203.0.113.7'] }).includes('IP_HOST_FORBIDDEN'))
  assert.ok(rulesFor({ allowedHosts: ['[::1]'] }).includes('IP_HOST_FORBIDDEN'))
  assert.ok(rulesFor({ allowedHosts: ['localhost'] }).includes('PRIVATE_HOST_FORBIDDEN'))
  assert.ok(rulesFor({ allowedHosts: ['*.localhost'] }).includes('PRIVATE_HOST_FORBIDDEN'))
  assert.ok(rulesFor({ allowedHosts: ['*.192.168.1.1'] }).includes('IP_HOST_FORBIDDEN'))
  assert.ok(rulesFor({ allowedHosts: ['api.example.com:8443'] }).includes('INVALID_HOST_PATTERN'))
  assert.ok(rulesFor({ allowedHosts: ['https://api.example.com'] }).includes('INVALID_HOST_PATTERN'))
  assert.ok(rulesFor({ allowedHosts: ['api_example'] }).includes('INVALID_HOST_PATTERN'))
  assert.ok(rulesFor({ credentialSchemas: [] }).includes('UNSUPPORTED_CREDENTIAL_SCHEMA'))
  assert.ok(rulesFor({ credentialSchemas: ['oauth-box-v9'] }).includes('UNSUPPORTED_CREDENTIAL_SCHEMA'))
  assert.ok(rulesFor({ models: [] }).includes('EMPTY_MODEL_LIST'))
  assert.ok(rulesFor({ models: [{ name: 'no id' }] }).includes('EMPTY_MODEL_LIST'))
  assert.ok(rulesFor({ modalities: [] }).includes('INVALID_MODALITIES'))
  assert.ok(rulesFor({ modalities: ['audio'] }).includes('INVALID_MODALITIES'))
  assert.deepEqual(rulesFor({ credentialSchemas: ['json-v1', 'json-v1'] }), [])
  assert.deepEqual(rulesFor().sort(), [
    'EMPTY_ALLOWED_HOSTS',
    'EMPTY_MODEL_LIST',
    'INVALID_DISPLAY_NAME',
    'INVALID_PLUGIN_ID',
    'INVALID_PLUGIN_KIND',
    'INVALID_PLUGIN_VERSION',
    'UNSUPPORTED_CREDENTIAL_SCHEMA',
  ])
})

test('language manifests must declare a supported protocol list', () => {
  const missing = validatePluginManifest({ ...VALID_LANGUAGE_MANIFEST, languageProtocols: undefined })
  assert.equal(missing.ok, false)
  if (missing.ok) return
  assert.ok(missing.findings.some(finding => finding.rule === 'INVALID_LANGUAGE_PROTOCOLS'))
  assert.ok(missing.findings.every(finding => finding.severity === 'error'))
  const bogus = validatePluginManifest({ ...VALID_LANGUAGE_MANIFEST, languageProtocols: ['mistral_chat'] })
  assert.equal(bogus.ok, false)
  if (bogus.ok) return
  assert.deepEqual(bogus.findings.map(finding => finding.rule), ['INVALID_LANGUAGE_PROTOCOLS'])
})

test('artifact caps and the S3 key layout are exported for the upload endpoints', () => {
  assert.equal(PLUGIN_ARTIFACT_MAX_BYTES, 5 * 1024 * 1024)
  assert.equal(
    pluginObjectKey('acme-llm', '1.0.0', 'a'.repeat(64)),
    `plugin-packages/acme-llm/1.0.0/${'a'.repeat(64)}.mjs`,
  )
})
