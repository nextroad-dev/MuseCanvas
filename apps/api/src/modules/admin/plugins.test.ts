import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Actor } from '../../auth/security'
import type { AnyProviderManifest, MediaProviderManifest } from '../../../../../packages/providers/src/index'
import { PLUGIN_ARTIFACT_MAX_BYTES, pluginObjectKey, scanPluginSource } from '../../../../../packages/providers/src/index'
import {
  analyzePluginPackage,
  installPlugin,
  pluginArtifactIdentity,
  validatePluginPackage,
} from './plugins'
import {
  manifestAllowsHost,
  presetsForCatalogPlugins,
  resolveCatalogPlugin,
  type CatalogPlugin,
} from './plugin-catalog'

// These cases exercise only the branches that run before any I/O. That ordering is the
// point of the design — a rejected package never reaches S3 or Postgres — and it is also
// what lets this file run without a database, exactly like backend.test.ts.

process.env.ALLOW_PLUGIN_UPLOAD = 'true'

const ADMIN = { id: 'admin-1', role: 'admin' } as unknown as Actor

const GOOD_MANIFEST = {
  id: 'acme-image',
  version: '1.0.0',
  kind: 'media',
  displayName: 'Acme Image',
  description: 'Uploaded image plugin',
  allowedHosts: ['api.acme.example'],
  credentialSchemas: ['legacy-api-key-v1'],
  modalities: ['image'],
  models: [{ id: 'acme-1', name: 'Acme One', maxBatchSize: 3, maxInputImages: 2 }],
}

// Zero runtime imports, no globals, `export default`: the scan yields no findings at all.
const CLEAN_ARTIFACT = 'const meta = { id: "acme-image", version: "1.0.0" }\nexport default { meta }\n'
const UNSAFE_ARTIFACT = 'import { readFile } from "node:fs"\nconst token = process.env.API_TOKEN\nexport default { token, readFile }\n'

type PackageFields = Record<string, string | { bytes: Uint8Array; name: string }>

const packageRequest = (fields: PackageFields) => ({
  formData: async () => {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string') form.append(key, value)
      // Copy into a plain Uint8Array so a Buffer is accepted as a BlobPart.
      else form.append(key, new Blob([new Uint8Array(value.bytes)]), value.name)
    }
    return form
  },
})

const brokenRequest = {
  formData: async () => {
    throw new Error('not multipart')
  },
}

const uploadFields = (manifest: unknown, source: string = CLEAN_ARTIFACT): PackageFields => ({
  manifest: JSON.stringify(manifest),
  file: { bytes: new TextEncoder().encode(source), name: 'plugin.mjs' },
})

type Payload = { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } }
const payload = async (response: Response): Promise<Payload> => (await response.json()) as Payload
const errorCode = async (response: Response): Promise<string | undefined> => (await payload(response)).error?.code
const dataOf = async (response: Response): Promise<Record<string, unknown>> => (await payload(response)).data ?? {}
const findingRules = (data: Record<string, unknown>): Set<string> =>
  new Set(((data.findings ?? []) as { rule: string }[]).map(finding => finding.rule))

test('artifact identity pairs the object key with the sha256 of the exact bytes', () => {
  const bytes = Buffer.from(CLEAN_ARTIFACT, 'utf8')
  const { sha256, objectKey } = pluginArtifactIdentity('acme-image', '1.0.0', bytes)
  assert.equal(sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(objectKey, pluginObjectKey('acme-image', '1.0.0', sha256))
  assert.equal(objectKey, `plugin-packages/acme-image/1.0.0/${sha256}.mjs`)
  // One flipped byte moves the key, so a stored artifact can never be swapped silently.
  const mutated = Buffer.from(bytes)
  mutated[mutated.length - 1] = 0x20
  assert.notEqual(pluginArtifactIdentity('acme-image', '1.0.0', mutated).sha256, sha256)
})

test('validate reports the digest and warn-only findings without blocking', async () => {
  const bytes = Buffer.from(CLEAN_ARTIFACT, 'utf8')
  const data = await dataOf(await validatePluginPackage(packageRequest(uploadFields(GOOD_MANIFEST))))
  assert.equal(data.ok, true)
  assert.equal(data.pluginId, 'acme-image')
  assert.equal(data.pluginVersion, '1.0.0')
  assert.equal(data.kind, 'media')
  assert.deepEqual(data.modelIds, ['acme-1'])
  assert.deepEqual(data.allowedHosts, ['api.acme.example'])
  assert.equal(data.artifactDigest, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(data.artifactSizeBytes, bytes.byteLength)
  assert.deepEqual(data.warnings, [])
  // A bundle without `export default` is warn-only, so it still validates.
  const noDefault = await dataOf(await validatePluginPackage(packageRequest(uploadFields(GOOD_MANIFEST, 'const meta = 1\n'))))
  assert.equal(noDefault.ok, true)
  assert.deepEqual(noDefault.warnings, [{ rule: 'NO_DEFAULT_EXPORT', severity: 'warn', message: 'the plugin object is expected as `export default`' }])
})

test('the scanner is the shared one: error findings abort with PLUGIN_SCAN_FAILED', () => {
  const bytes = Buffer.from(UNSAFE_ARTIFACT, 'utf8')
  const source = bytes.toString('utf8')
  const analysis = analyzePluginPackage(JSON.stringify(GOOD_MANIFEST), source, bytes)
  assert.equal(analysis.ok, false)
  if (analysis.ok) return
  assert.equal(analysis.code, 'PLUGIN_SCAN_FAILED')
  const rules = findingRules({ findings: analysis.findings })
  assert.ok(scanPluginSource(source).length > 0)
  assert.equal(rules.has('FORBIDDEN_RUNTIME_IMPORT'), true)
  assert.equal(rules.has('FORBIDDEN_PROCESS_ENV'), true)
  assert.equal(rules.has('FORBIDDEN_NODE_BUILTIN'), true)
  assert.equal(analysis.findings.some(finding => finding.severity === 'error'), true)
})

test('install rejects an unsafe package before any write', async () => {
  const response = await installPlugin(ADMIN, packageRequest(uploadFields(GOOD_MANIFEST, UNSAFE_ARTIFACT)))
  assert.equal(response.status, 422)
  const data = await dataOf(response)
  assert.equal(data.ok, false)
  assert.equal(data.installed, false)
  assert.equal(data.code, 'PLUGIN_SCAN_FAILED')
  assert.ok(Array.isArray(data.findings) && data.findings.length > 0)
})

test('manifest validation failures abort with the manifest rule ids', async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['empty allowlist permits no egress', { ...GOOD_MANIFEST, allowedHosts: [] }, 'EMPTY_ALLOWED_HOSTS'],
    ['version must be semver', { ...GOOD_MANIFEST, version: '1.0' }, 'INVALID_PLUGIN_VERSION'],
    ['wildcard root host', { ...GOOD_MANIFEST, allowedHosts: ['*'] }, 'WILDCARD_HOST_FORBIDDEN'],
    ['loopback host', { ...GOOD_MANIFEST, allowedHosts: ['localhost'] }, 'PRIVATE_HOST_FORBIDDEN'],
    ['ip literal host', { ...GOOD_MANIFEST, allowedHosts: ['10.0.0.8'] }, 'IP_HOST_FORBIDDEN'],
    ['empty model list', { ...GOOD_MANIFEST, models: [] }, 'EMPTY_MODEL_LIST'],
    ['media manifest must declare modalities', { ...GOOD_MANIFEST, modalities: [] }, 'INVALID_MODALITIES'],
    ['unknown credential schema', { ...GOOD_MANIFEST, credentialSchemas: ['oauth-v9'] }, 'UNSUPPORTED_CREDENTIAL_SCHEMA'],
  ]
  for (const [label, manifest, rule] of cases) {
    const response = await validatePluginPackage(packageRequest(uploadFields(manifest)))
    assert.equal(response.status, 422, label)
    const data = await dataOf(response)
    assert.equal(data.code, 'PLUGIN_SCAN_FAILED', label)
    assert.ok(findingRules(data).has(rule), `${label} -> ${[...findingRules(data)].join(',')}`)
  }
})

test('malformed manifest JSON is reported instead of being scanned as a plugin', () => {
  const bytes = Buffer.from(CLEAN_ARTIFACT, 'utf8')
  const analysis = analyzePluginPackage('{broken', bytes.toString('utf8'), bytes)
  assert.equal(analysis.ok, false)
  if (analysis.ok) return
  assert.equal(analysis.code, 'INVALID_PLUGIN_MANIFEST')
  assert.equal(analysis.findings[0]?.severity, 'error')
})

test('a built-in plugin key is refused before the catalog is consulted', async () => {
  // Reaching PLUGIN_ID_RESERVED proves scanning passed and that the registry guard
  // runs first: the duplicate-version lookup that follows it needs a database.
  const reserved = { ...GOOD_MANIFEST, id: 'openai-image', version: '1.1.0' }
  const response = await installPlugin(ADMIN, packageRequest(uploadFields(reserved)))
  assert.equal(response.status, 400)
  assert.equal(await errorCode(response), 'PLUGIN_ID_RESERVED')
})

test('uploads are refused while ALLOW_PLUGIN_UPLOAD is off', async () => {
  for (const value of [undefined, 'false', 'TRUE']) {
    if (value === undefined) delete process.env.ALLOW_PLUGIN_UPLOAD
    else process.env.ALLOW_PLUGIN_UPLOAD = value
    try {
      for (const handler of [
        () => installPlugin(ADMIN, packageRequest(uploadFields(GOOD_MANIFEST))),
        () => validatePluginPackage(packageRequest(uploadFields(GOOD_MANIFEST))),
      ]) {
        const response = await handler()
        assert.equal(response.status, 400)
        assert.equal(await errorCode(response), 'PLUGIN_UPLOAD_DISABLED')
      }
    } finally {
      process.env.ALLOW_PLUGIN_UPLOAD = 'true'
    }
  }
})

test('the artifact size cap is enforced before hashing or scanning', async () => {
  const oversized = Buffer.alloc(PLUGIN_ARTIFACT_MAX_BYTES + 1, 0x61)
  const rejected = await installPlugin(ADMIN, packageRequest({
    manifest: JSON.stringify(GOOD_MANIFEST),
    file: { bytes: oversized, name: 'plugin.mjs' },
  }))
  assert.equal(rejected.status, 400)
  const error = (await payload(rejected)).error
  assert.equal(error?.code, 'PLUGIN_ARTIFACT_TOO_LARGE')
  assert.match(error?.message ?? '', new RegExp(String(PLUGIN_ARTIFACT_MAX_BYTES)))
  // Exactly at the cap the gate opens and the package is analyzed normally.
  const atCap = await validatePluginPackage(packageRequest({
    manifest: JSON.stringify(GOOD_MANIFEST),
    file: { bytes: Buffer.alloc(PLUGIN_ARTIFACT_MAX_BYTES, 0x61), name: 'plugin.mjs' },
  }))
  const data = await dataOf(atCap)
  assert.equal(data.ok, true)
  assert.equal(data.artifactSizeBytes, PLUGIN_ARTIFACT_MAX_BYTES)
  assert.equal(data.artifactDigest, createHash('sha256').update(Buffer.alloc(PLUGIN_ARTIFACT_MAX_BYTES, 0x61)).digest('hex'))
})

test('the multipart envelope accepts exactly one manifest field and one .mjs file', async () => {
  const fields = uploadFields(GOOD_MANIFEST)
  const cases: [string, PackageFields][] = [
    ['extra field', { ...fields, payload: 'x' }],
    ['missing manifest', { file: fields.file }],
    ['blank manifest', { ...fields, manifest: '  ' }],
    ['missing file', { manifest: fields.manifest }],
    ['wrong extension', { ...fields, file: { bytes: new TextEncoder().encode(CLEAN_ARTIFACT), name: 'plugin.cjs' } }],
    ['non-file field', { ...fields, file: 'not-a-file' }],
    ['empty artifact', { ...fields, file: { bytes: new Uint8Array(0), name: 'plugin.mjs' } }],
  ]
  for (const [label, requestFields] of cases) {
    const response = await installPlugin(ADMIN, packageRequest(requestFields))
    assert.equal(response.status, 400, label)
    assert.equal(await errorCode(response), 'INVALID_INPUT', label)
  }
  // A body that cannot be read as multipart is refused with the same code.
  assert.equal(await errorCode(await installPlugin(ADMIN, brokenRequest)), 'INVALID_INPUT')
  assert.equal(await errorCode(await validatePluginPackage(brokenRequest)), 'INVALID_INPUT')
  // Two files under `file` is ambiguous, so neither is stored.
  const duplicated = {
    formData: async () => {
      const form = new FormData()
      form.append('manifest', JSON.stringify(GOOD_MANIFEST))
      form.append('file', new Blob([CLEAN_ARTIFACT]), 'plugin.mjs')
      form.append('file', new Blob([CLEAN_ARTIFACT]), 'plugin-2.mjs')
      return form
    },
  }
  assert.equal(await errorCode(await installPlugin(ADMIN, duplicated)), 'INVALID_INPUT')
  assert.equal(await errorCode(await validatePluginPackage(duplicated)), 'INVALID_INPUT')
  // The empty artifact message is specific enough for the admin to act on.
  const empty = await installPlugin(ADMIN, packageRequest({ ...fields, file: { bytes: new Uint8Array(0), name: 'plugin.mjs' } }))
  assert.match((await payload(empty)).error?.message ?? '', /为空/)
})

test('synthesized presets carry the manifest identity and the first exact host as base URL', () => {
  const mediaManifest: MediaProviderManifest = {
    kind: 'media',
    id: 'acme-video',
    version: '2.1.0',
    displayName: 'Acme Video',
    modalities: ['video'],
    allowedHosts: ['*.mirror.acme.example', 'api.acme-video.example'],
    credentialSchemas: ['json-v1'],
    models: [
      { id: 'acme-fast', name: 'Acme Fast', modalities: ['video'], maxBatchSize: 4 },
      { id: 'acme-draw', modalities: ['image'], maxBatchSize: 99, maxInputImages: 2 },
    ],
  }
  const languageManifest = {
    kind: 'language',
    id: 'acme-language',
    version: '1.0.0',
    displayName: 'Acme Language',
    languageProtocols: ['openai_chat'],
    allowedHosts: ['llm.acme.example'],
    credentialSchemas: ['legacy-api-key-v1'],
    models: [{ id: 'acme-chat' }],
  } as AnyProviderManifest
  const entries: CatalogPlugin[] = [
    { source: 'installed', manifest: mediaManifest },
    { source: 'installed', manifest: languageManifest },
  ]
  const presets = presetsForCatalogPlugins(entries)
  assert.equal(presets.length, 2)
  const [fast, draw] = presets
  assert.equal(fast.modelKind, 'video')
  assert.equal(fast.id, 'installed:acme-video@2.1.0:acme-fast')
  assert.equal(fast.displayName, 'Acme Video · Acme Fast')
  assert.equal('pluginId' in fast && fast.pluginId, 'acme-video')
  assert.equal('pluginVersion' in fast && fast.pluginVersion, '2.1.0')
  assert.equal('providerId' in fast && fast.providerId, 'acme-video')
  // The first exact allowlisted host is the only endpoint the host may assume.
  assert.equal('baseUrl' in fast && fast.baseUrl, 'https://api.acme-video.example')
  assert.equal('adapter' in fast, false)
  // The per-model modality decides modelKind — and nothing else. A synthesized
  // preset carries identity only: no `maxCount` from `maxBatchSize`, no
  // `maxInputImages`, no empty `sizes`/`qualityOptions` placeholders and no
  // generic video parameters. All of that comes from the manifest through
  // `resolvePresetCapabilities` when the model is saved, so a manifest that
  // declares nothing offers nothing instead of being padded out here.
  const identityKeys = ['baseUrl', 'concurrencyLimit', 'displayName', 'id', 'modelKind', 'pluginId', 'pluginVersion', 'providerId', 'vendorModelId']
  for (const preset of presets) {
    assert.deepEqual(Object.keys(preset).sort(), [...identityKeys].sort(), preset.id)
  }
  assert.equal(draw.modelKind, 'image')
  assert.equal('maxCount' in fast, false)
  assert.equal('parameters' in fast, false)
  assert.equal('inputSlots' in fast, false)
  assert.equal('modes' in fast, false)
  assert.equal('defaults' in fast, false)
  assert.equal('sizes' in draw, false)
  assert.equal('qualityOptions' in draw, false)
  assert.equal('maxInputImages' in draw, false)
  // Language manifests never yield model presets: a model config binds media plugins only.
  assert.equal(presets.some(preset => 'pluginId' in preset && preset.pluginId === 'acme-language'), false)
})

test('host allowlist matching covers exact and *.suffix entries only', () => {
  const manifest = {
    kind: 'media',
    id: 'acme-image',
    version: '1.0.0',
    displayName: 'Acme',
    modalities: ['image'],
    allowedHosts: ['api.acme.example', '*.mirror.acme.example'],
    credentialSchemas: ['legacy-api-key-v1'],
    models: [{ id: 'm' }],
  } as AnyProviderManifest
  assert.equal(manifestAllowsHost(manifest, 'api.acme.example'), true)
  assert.equal(manifestAllowsHost(manifest, 'API.acme.example'), true)
  assert.equal(manifestAllowsHost(manifest, 'a.mirror.acme.example'), true)
  assert.equal(manifestAllowsHost(manifest, 'mirror.acme.example'), true)
  assert.equal(manifestAllowsHost(manifest, 'evil.acme.example'), false)
  assert.equal(manifestAllowsHost(manifest, 'api.acme.example.evil.net'), false)
})

test('built-in plugins resolve without a database, so catalog gating stays cheap', async () => {
  const builtin = await resolveCatalogPlugin('openai-image', '1.1.0')
  assert.equal(builtin?.source, 'builtin')
  assert.equal(builtin?.manifest.kind, 'media')
  // An uploaded key is invisible until a row proves it active. This runs with no
  // database at all: the built-in-only fallback is what protects existing models.
  assert.equal(await resolveCatalogPlugin('acme-image', '1.0.0'), null)
})

test('uploads dispatch before the JSON-only body reader and never match the id route', async () => {
  // The old catch-all read `await body(request)` unconditionally in POST, so a
  // multipart upload would die there, and /admin/plugins/{id} must not swallow
  // the static segments. Both hazards are about table order, and the table is now
  // data, so assert against the real routes and the real compiled matcher rather
  // than against a copy of either.
  const { GET_ROUTES, POST_ROUTES } = await import('../../router/routes')
  const { matchPath } = await import('../../router/match')

  const at = (routes: { path: string }[], needle: string) => {
    const index = routes.findIndex(route => route.path === needle)
    assert.ok(index >= 0, `no route registered for ${needle}`)
    return index
  }
  const upload = at(POST_ROUTES, 'admin/plugins/upload')
  const validate = at(POST_ROUTES, 'admin/plugins/validate')

  // Body-reading POST routes: `context.json()` is lazy, so being later in the
  // table is what keeps a multipart request from ever being parsed as JSON.
  for (const later of ['auth/otp/request', 'generations', 'admin/models', 'admin/provider-credentials']) {
    assert.ok(upload < at(POST_ROUTES, later), `upload must be dispatched before ${later}`)
    assert.ok(validate < at(POST_ROUTES, later), `validate must be dispatched before ${later}`)
  }

  // Neither upload handler may reach for the JSON body.
  const here = dirname(fileURLToPath(import.meta.url))
  const tableSource = readFileSync(join(here, '../../router/routes.ts'), 'utf8')
  for (const path of ['admin/plugins/upload', 'admin/plugins/validate']) {
    const line = tableSource.split('\n').find(entry => entry.includes(`path: '${path}'`))
    assert.ok(line, `${path} is missing from the route table source`)
    assert.equal(line.includes('context.json()'), false, `${path} must not consume the JSON body`)
  }

  // Static segments still win over the id route in GET, as before.
  assert.ok(at(GET_ROUTES, 'admin/plugins') < at(GET_ROUTES, 'admin/models'))

  // The registered `:hexid` matcher cannot capture either static segment. This
  // checks the pattern the dispatcher actually compiles.
  assert.equal(matchPath('admin/plugins/:hexid', 'admin/plugins/upload'), null)
  assert.equal(matchPath('admin/plugins/:hexid', 'admin/plugins/validate'), null)
  assert.ok(matchPath('admin/plugins/:hexid', 'admin/plugins/123e4567-e89b-12d3-a456-426614174000'))
})
