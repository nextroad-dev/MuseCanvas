import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Actor } from '../../auth/security'
import type { AnyProviderManifest, MediaProviderManifest } from '../../../../../packages/providers/src/index'
import {
  PLUGIN_PACKAGE_MAX_BYTES,
  PLUGIN_ARTIFACT_MAX_BYTES,
  createPluginPackageZip,
  pluginIconObjectKey,
  pluginObjectKey,
  pluginPackageObjectKey,
  scanPluginSource,
  validatePluginManifest,
} from '../../../../../packages/providers/src/index'
import {
  LEGACY_UPLOAD_WARNING,
  analyzePluginPackage,
  analyzeZipPluginPackage,
  getPluginDocs,
  installPlugin,
  pluginArtifactIdentity,
  pluginDocsFromRow,
  pluginDtoFromRow,
  pluginPackageFilename,
  validatePluginPackage,
  type PluginInstallDeps,
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
  assert.equal(data.packageFormat, 'mjs')
  assert.equal(data.packageDigest, null)
  // The legacy envelope still works, with a non-blocking notice to move to zip.
  assert.deepEqual(data.warnings, [LEGACY_UPLOAD_WARNING])
  // A bundle without `export default` is warn-only, so it still validates.
  const noDefault = await dataOf(await validatePluginPackage(packageRequest(uploadFields(GOOD_MANIFEST, 'const meta = 1\n'))))
  assert.equal(noDefault.ok, true)
  assert.deepEqual(noDefault.warnings, [
    { rule: 'NO_DEFAULT_EXPORT', severity: 'warn', message: 'the plugin object is expected as `export default`' },
    LEGACY_UPLOAD_WARNING,
  ])
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

test('an upload may not claim a built-in provider account', async () => {
  // Declared explicitly...
  const declared = {
    ...GOOD_MANIFEST,
    credential: {
      providerId: 'openai',
      schemaId: 'legacy-api-key-v1',
      secret: { format: 'text', label: 'Key' },
      baseUrl: { policy: 'allowlisted' },
    },
  }
  const response = await installPlugin(ADMIN, packageRequest(uploadFields(declared)))
  assert.equal(response.status, 400)
  assert.equal(await errorCode(response), 'PROVIDER_ID_RESERVED')
  // ...or derived from a plugin id that happens to name one.
  const derived = { ...GOOD_MANIFEST, id: 'volcengine' }
  const derivedResponse = await installPlugin(ADMIN, packageRequest(uploadFields(derived)))
  assert.equal(await errorCode(derivedResponse), 'PROVIDER_ID_RESERVED')
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

test('host allowlist matching follows the runtime egress grammar', () => {
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
  // The apex is not covered by `*.`: SafeHttpClient would refuse it at call time,
  // so accepting it on save would store a base URL that can never be called.
  assert.equal(manifestAllowsHost(manifest, 'mirror.acme.example'), false)
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

// ---------------------------------------------------------------------------
// Zip packages (plugin-package-spec): `package` field, storage keys, columns
// ---------------------------------------------------------------------------

const ZIP_MANIFEST = { ...GOOD_MANIFEST, id: 'acme-zip', version: '1.2.0' }
const ZIP_BUNDLE = `const manifest = ${JSON.stringify(ZIP_MANIFEST)}\nexport default { manifest, validateConfig() {}, validateRequest() {}, async submit() { return { status: 'succeeded', outputs: [] } } }\n`
// The canonical 1x1 RGBA PNG.
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const enc = (value: string) => new TextEncoder().encode(value)
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function zipPackage(overrides: Record<string, Uint8Array | null> = {}, packageBlock: Record<string, unknown> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'manifest.json': enc(JSON.stringify({
      ...ZIP_MANIFEST,
      package: { format: 1, entry: 'plugin.mjs', icon: 'assets/icon.png', author: 'Acme', license: 'MIT', homepage: 'https://acme.example', ...packageBlock },
    })),
    'plugin.mjs': enc(ZIP_BUNDLE),
    'README.md': enc('# Acme Zip\n'),
    'CHANGELOG.md': enc('## 1.2.0\n'),
    LICENSE: enc('MIT\n'),
    'assets/icon.png': new Uint8Array(PNG_1X1),
  }
  for (const [path, bytes] of Object.entries(overrides)) {
    if (bytes === null) delete files[path]
    else files[path] = bytes
  }
  return createPluginPackageZip(files)
}

const zipFields = (zip: Uint8Array, name = 'acme-zip-1.2.0.zip'): PackageFields => ({ package: { bytes: zip, name } })

test('a zip package validates through the same endpoint, with package details and no legacy warning', async () => {
  const zip = zipPackage()
  const response = await validatePluginPackage(packageRequest(zipFields(zip)))
  assert.equal(response.status, 200)
  const data = await dataOf(response)
  assert.equal(data.ok, true)
  assert.equal(data.pluginId, 'acme-zip')
  assert.equal(data.pluginVersion, '1.2.0')
  assert.equal(data.packageFormat, 'zip-v1')
  assert.equal(data.artifactDigest, sha(enc(ZIP_BUNDLE)))
  assert.equal(data.artifactSizeBytes, enc(ZIP_BUNDLE).byteLength)
  assert.equal(data.packageDigest, sha(zip))
  assert.equal(data.hasIcon, true)
  assert.deepEqual(data.packageMeta, { author: 'Acme', license: 'MIT', homepage: 'https://acme.example' })
  const files = data.packageFiles as Array<{ path: string; sizeBytes: number; sha256: string }>
  assert.deepEqual(files.map(file => file.path), ['CHANGELOG.md', 'LICENSE', 'README.md', 'assets/icon.png', 'manifest.json', 'plugin.mjs'])
  assert.equal(files.find(file => file.path === 'plugin.mjs')?.sha256, sha(enc(ZIP_BUNDLE)))
  assert.deepEqual(data.warnings, [])
})

test('analysis derives every storage key from content, and the entry key keeps the worker format', async () => {
  const zip = zipPackage()
  const analysis = await analyzeZipPluginPackage(Buffer.from(zip))
  assert.equal(analysis.ok, true)
  if (!analysis.ok || !analysis.package) return
  const entrySha = sha(enc(ZIP_BUNDLE))
  assert.equal(analysis.format, 'zip-v1')
  assert.equal(analysis.objectKey, pluginObjectKey('acme-zip', '1.2.0', entrySha))
  assert.equal(analysis.objectKey, `plugin-packages/acme-zip/1.2.0/${entrySha}.mjs`)
  assert.equal(analysis.package.packageObjectKey, pluginPackageObjectKey('acme-zip', '1.2.0', sha(zip)))
  assert.equal(analysis.package.icon?.objectKey, pluginIconObjectKey('acme-zip', '1.2.0', sha(PNG_1X1), 'png'))
  assert.equal(analysis.package.icon?.objectKey, `plugin-packages/acme-zip/1.2.0/icon-${sha(PNG_1X1)}.png`)
  // The stored manifest is manifest.json without its package block, normalized.
  const expected = validatePluginManifest(ZIP_MANIFEST)
  assert.ok(expected.ok)
  assert.deepEqual(analysis.manifest, expected.manifest)
})

test('zip rejections answer 422 with path-carrying findings', async () => {
  const cases: Array<[string, Uint8Array, string, string | undefined]> = [
    ['path traversal', zipPackage({ '../evil.md': enc('x') }), 'PLUGIN_PACKAGE_UNSAFE_PATH', '../evil.md'],
    ['second bundle', zipPackage({ 'extra.mjs': enc('export default {}') }), 'PLUGIN_PACKAGE_FORBIDDEN_FILE', 'extra.mjs'],
    ['missing entry', zipPackage({ 'plugin.mjs': null }), 'PLUGIN_PACKAGE_ENTRY_MISSING', 'manifest.json'],
    ['scan failure', zipPackage({ 'plugin.mjs': enc('const k = process.env.K\nexport default { k }\n') }), 'PLUGIN_SCAN_FAILED', 'plugin.mjs'],
    ['icon is not a png', zipPackage({ 'assets/icon.png': enc('nope') }), 'PLUGIN_PACKAGE_INVALID', 'assets/icon.png'],
    ['not a zip', enc('plain text'), 'PLUGIN_PACKAGE_INVALID', undefined],
  ]
  const install = (request: ReturnType<typeof packageRequest>) => installPlugin(ADMIN, request)
  for (const [label, zip, code, path] of cases) {
    for (const handler of [validatePluginPackage, install]) {
      const response = await handler(packageRequest(zipFields(zip)))
      assert.equal(response.status, 422, label)
      const data = await dataOf(response)
      assert.equal(data.ok, false, label)
      assert.equal(data.code, code, `${label}: ${JSON.stringify(data.findings)}`)
      if (path) assert.ok((data.findings as Array<{ path?: string }>).some(finding => finding.path === path), `${label} -> ${JSON.stringify(data.findings)}`)
    }
  }
  // The 6 MiB cap is part of the same envelope.
  const oversized = await validatePluginPackage(packageRequest(zipFields(new Uint8Array(PLUGIN_PACKAGE_MAX_BYTES + 1))))
  assert.equal(oversized.status, 422)
  assert.equal((await dataOf(oversized)).code, 'PLUGIN_PACKAGE_TOO_LARGE')
})

test('the package envelope is exclusive: one .zip, no legacy fields alongside', async () => {
  const zip = zipPackage()
  const cases: Array<[string, PackageFields | (() => FormData)]> = [
    ['package plus manifest', { ...zipFields(zip), manifest: JSON.stringify(ZIP_MANIFEST) }],
    ['package plus file', { ...zipFields(zip), file: { bytes: enc(ZIP_BUNDLE), name: 'plugin.mjs' } }],
    ['not a .zip name', zipFields(zip, 'plugin.tar')],
    ['empty zip', zipFields(new Uint8Array(0))],
    ['text field', { package: 'not-a-file' }],
    ['two packages', () => {
      const form = new FormData()
      form.append('package', new Blob([new Uint8Array(zip)]), 'a.zip')
      form.append('package', new Blob([new Uint8Array(zip)]), 'b.zip')
      return form
    }],
    ['no fields at all', {}],
  ]
  for (const [label, fields] of cases) {
    const request = typeof fields === 'function' ? { formData: async () => fields() } : packageRequest(fields)
    const response = await validatePluginPackage(request)
    assert.equal(response.status, 400, label)
    assert.equal(await errorCode(response), 'INVALID_INPUT', label)
  }
  // Upper-case extension is still a zip.
  assert.equal((await validatePluginPackage(packageRequest(zipFields(zip, 'ACME.ZIP')))).status, 200)
})

/** In-memory stand-ins for the pool and the bucket. */
function fakeInstallDeps(options: { failPutAt?: number; failInsert?: boolean } = {}) {
  const puts: Array<{ key: string; bytes: Buffer; contentType: string }> = []
  const deletes: string[] = []
  const statements: Array<{ sql: string; params: unknown[] }> = []
  const deps: PluginInstallDeps = {
    query: async (sql, params) => {
      statements.push({ sql, params })
      return { rows: [] }
    },
    transaction: async fn => fn({
      query: async (sql, params) => {
        statements.push({ sql, params })
        if (sql.startsWith('INSERT INTO provider_plugins')) {
          if (options.failInsert) throw new Error('insert failed')
          return { rows: [insertedRow(sql, params)] }
        }
        return { rows: [] }
      },
    }),
    putObject: async (key, bytes, contentType) => {
      if (options.failPutAt !== undefined && puts.length === options.failPutAt) throw new Error('bucket down')
      puts.push({ key, bytes, contentType })
    },
    deleteObject: async key => {
      deletes.push(key)
    },
  }
  return { deps, puts, deletes, statements }
}

/** Echoes the INSERT back as the row Postgres would return (jsonb parsed). */
function insertedRow(sql: string, params: unknown[]): Record<string, unknown> {
  const flat = sql.replace(/\s+/g, ' ')
  const columns = /provider_plugins\(([^)]*)\)/.exec(flat)?.[1].split(',').map(column => column.trim()) ?? []
  const placeholders = /VALUES\(([^)]*)\)/.exec(flat)?.[1].split(',').map(value => value.trim()) ?? []
  const row: Record<string, unknown> = { id: '123e4567-e89b-12d3-a456-426614174000', created_at: new Date(0), updated_at: new Date(0) }
  columns.forEach((column, index) => {
    const placeholder = placeholders[index] ?? ''
    const match = /^\$(\d+)(::jsonb)?$/.exec(placeholder)
    if (!match) {
      row[column] = placeholder.replace(/^'|'$/g, '')
      return
    }
    const value = params[Number(match[1]) - 1]
    row[column] = match[2] && typeof value === 'string' ? JSON.parse(value) : value
  })
  return row
}

test('a zip install writes bundle, zip and icon, and persists the package columns', async () => {
  const zip = zipPackage()
  const fake = fakeInstallDeps()
  const response = await installPlugin(ADMIN, packageRequest(zipFields(zip)), fake.deps)
  assert.equal(response.status, 201)
  const entrySha = sha(enc(ZIP_BUNDLE))
  assert.deepEqual(fake.puts.map(put => [put.key, put.contentType]), [
    [`plugin-packages/acme-zip/1.2.0/${entrySha}.mjs`, 'text/javascript'],
    [`plugin-packages/acme-zip/1.2.0/${sha(zip)}.zip`, 'application/zip'],
    [`plugin-packages/acme-zip/1.2.0/icon-${sha(PNG_1X1)}.png`, 'image/png'],
  ])
  assert.equal(fake.puts[0].bytes.equals(Buffer.from(enc(ZIP_BUNDLE))), true)
  assert.equal(fake.puts[1].bytes.equals(Buffer.from(zip)), true)
  assert.deepEqual(fake.deletes, [])

  const insert = fake.statements.find(statement => statement.sql.startsWith('INSERT INTO provider_plugins'))
  assert.ok(insert)
  const row = insertedRow(insert.sql, insert.params)
  assert.equal(row.object_key, `plugin-packages/acme-zip/1.2.0/${entrySha}.mjs`)
  assert.equal(row.artifact_sha256, entrySha)
  assert.equal(row.package_format, 'zip-v1')
  assert.equal(row.package_object_key, `plugin-packages/acme-zip/1.2.0/${sha(zip)}.zip`)
  assert.equal(row.package_sha256, sha(zip))
  assert.equal(row.readme, '# Acme Zip\n')
  assert.equal(row.changelog, '## 1.2.0\n')
  assert.equal(row.license_text, 'MIT\n')
  assert.deepEqual((row.package_meta as Record<string, unknown>).icon, {
    path: 'assets/icon.png',
    objectKey: `plugin-packages/acme-zip/1.2.0/icon-${sha(PNG_1X1)}.png`,
    sha256: sha(PNG_1X1),
    mimeType: 'image/png',
    width: 1,
    height: 1,
  })
  assert.equal((row.package_files as unknown[]).length, 6)
  assert.equal((row.manifest as Record<string, unknown>).package, undefined)

  const result = (await payload(response)).data as { installed: boolean; plugin: Record<string, unknown>; warnings: unknown[] }
  assert.equal(result.installed, true)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.plugin.packageFormat, 'zip-v1')
  assert.equal(result.plugin.packageDigest, sha(zip))
  assert.equal(result.plugin.hasIcon, true)
  assert.deepEqual(result.plugin.packageMeta, { author: 'Acme', license: 'MIT', homepage: 'https://acme.example' })
  assert.deepEqual(result.plugin.docs, { readme: true, changelog: true, licenseText: true })
  assert.equal('readme' in result.plugin, false)
  // Storage keys never reach the client.
  assert.equal(JSON.stringify(result).includes('plugin-packages/'), false)
})

test('a legacy install keeps the mjs columns and warns', async () => {
  const fake = fakeInstallDeps()
  const response = await installPlugin(ADMIN, packageRequest(uploadFields(GOOD_MANIFEST)), fake.deps)
  assert.equal(response.status, 201)
  assert.deepEqual(fake.puts.map(put => put.key), [pluginArtifactIdentity('acme-image', '1.0.0', Buffer.from(CLEAN_ARTIFACT)).objectKey])
  const insert = fake.statements.find(statement => statement.sql.startsWith('INSERT INTO provider_plugins'))
  assert.ok(insert)
  const row = insertedRow(insert.sql, insert.params)
  assert.equal(row.package_format, 'mjs')
  assert.equal(row.package_object_key, null)
  assert.deepEqual(row.package_files, [])
  assert.deepEqual(row.package_meta, {})
  const result = (await payload(response)).data as { plugin: Record<string, unknown>; warnings: unknown[] }
  assert.deepEqual(result.warnings, [LEGACY_UPLOAD_WARNING])
  assert.equal(result.plugin.packageFormat, 'mjs')
  assert.equal(result.plugin.hasIcon, false)
})

test('a failed write rolls back every object already stored', async () => {
  const zip = zipPackage()
  const storeFailure = fakeInstallDeps({ failPutAt: 2 })
  const stored = await installPlugin(ADMIN, packageRequest(zipFields(zip)), storeFailure.deps)
  assert.equal(stored.status, 503)
  assert.equal(await errorCode(stored), 'PLUGIN_ARTIFACT_STORE_FAILED')
  assert.deepEqual(storeFailure.deletes, storeFailure.puts.map(put => put.key))
  assert.equal(storeFailure.deletes.length, 2)

  const dbFailure = fakeInstallDeps({ failInsert: true })
  const inserted = await installPlugin(ADMIN, packageRequest(zipFields(zip)), dbFailure.deps)
  assert.equal(inserted.status, 503)
  assert.equal(await errorCode(inserted), 'PLUGIN_INSTALL_FAILED')
  assert.deepEqual(dbFailure.deletes, dbFailure.puts.map(put => put.key))
  assert.equal(dbFailure.deletes.length, 3)
})

test('the DTO exposes package fields for zip rows only, and never a storage key', () => {
  const base = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    plugin_id: 'acme-zip',
    plugin_version: '1.2.0',
    kind: 'media',
    display_name: 'Acme',
    status: 'active',
    source: 'uploaded',
    object_key: 'plugin-packages/acme-zip/1.2.0/x.mjs',
    artifact_sha256: 'a'.repeat(64),
    artifact_size_bytes: 10,
    manifest: { modalities: ['image'] },
    allowed_hosts: ['api.acme.example'],
    credential_schemas: ['legacy-api-key-v1'],
    scan_report: [{ rule: 'NO_DEFAULT_EXPORT', severity: 'warn', message: 'm', path: 'plugin.mjs' }],
    created_at: new Date(0),
    updated_at: new Date(0),
  }
  const zipRow = pluginDtoFromRow({
    ...base,
    package_format: 'zip-v1',
    package_object_key: 'plugin-packages/acme-zip/1.2.0/z.zip',
    package_sha256: 'b'.repeat(64),
    package_files: JSON.stringify([{ path: 'plugin.mjs', sizeBytes: 10, sha256: 'a'.repeat(64) }]),
    package_meta: { format: 1, entry: 'plugin.mjs', author: 'Acme', icon: { objectKey: 'plugin-packages/acme-zip/1.2.0/icon-c.png', mimeType: 'image/png' } },
    readme: '# hi',
    changelog: null,
    license_text: 'MIT',
  })
  assert.equal(zipRow.packageFormat, 'zip-v1')
  assert.equal(zipRow.packageDigest, 'b'.repeat(64))
  assert.deepEqual(zipRow.packageFiles, [{ path: 'plugin.mjs', sizeBytes: 10, sha256: 'a'.repeat(64) }])
  assert.deepEqual(zipRow.packageMeta, { author: 'Acme' })
  assert.equal(zipRow.hasIcon, true)
  // Flags only: the doc texts never ride along in the DTO.
  assert.deepEqual(zipRow.docs, { readme: true, changelog: false, licenseText: true })
  assert.equal(JSON.stringify(zipRow).includes('# hi'), false)
  assert.deepEqual(zipRow.scanReport, [{ rule: 'NO_DEFAULT_EXPORT', severity: 'warn', message: 'm', path: 'plugin.mjs' }])
  assert.equal(JSON.stringify(zipRow).includes('plugin-packages/'), false)

  // The list query selects has_* booleans instead of the texts.
  const listed = pluginDtoFromRow({ ...base, package_format: 'zip-v1', has_readme: false, has_changelog: true, has_license_text: false })
  assert.deepEqual(listed.docs, { readme: false, changelog: true, licenseText: false })

  // A legacy row: defaults, whatever stray columns say.
  const legacy = pluginDtoFromRow({ ...base, package_meta: { icon: { objectKey: 'k', mimeType: 'image/png' } }, readme: 'stray', has_changelog: true })
  assert.equal(legacy.packageFormat, 'mjs')
  assert.equal(legacy.packageDigest, null)
  assert.deepEqual(legacy.packageFiles, [])
  assert.deepEqual(legacy.packageMeta, {})
  assert.equal(legacy.hasIcon, false)
  assert.deepEqual(legacy.docs, { readme: false, changelog: false, licenseText: false })
})

test('the docs payload carries the texts for zip rows and nulls for legacy rows', () => {
  assert.deepEqual(
    pluginDocsFromRow({ package_format: 'zip-v1', readme: '# hi', changelog: null, license_text: 'MIT' }),
    { readme: '# hi', changelog: null, licenseText: 'MIT' },
  )
  assert.deepEqual(
    pluginDocsFromRow({ package_format: 'mjs', readme: 'stray', changelog: 'stray', license_text: 'stray' }),
    { readme: null, changelog: null, licenseText: null },
  )
})

test('the docs endpoint rejects a malformed id before touching the database', async () => {
  const response = await getPluginDocs('not-a-uuid')
  assert.equal(response.status, 404)
  assert.equal(await errorCode(response), 'NOT_FOUND')
})

test('the download filename is derived from the plugin identity only', () => {
  assert.equal(pluginPackageFilename('acme-zip', '1.2.0'), 'acme-zip-1.2.0.zip')
  assert.equal(pluginPackageFilename('a"b', '1/2'), 'a_b-1_2.zip')
})
