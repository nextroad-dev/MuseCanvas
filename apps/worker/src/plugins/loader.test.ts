import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { globalPluginRegistry } from '../../../../packages/providers/src/index'
import {
  installedLanguagePluginBinding,
  isPluginAvailable,
  resetPluginAvailability,
  resolveMediaPlugin,
  setPluginStatus,
  statusOf,
} from './availability'
import {
  loadPluginRow,
  MAX_INSTALLED_PLUGINS,
  pluginCachePath,
  refreshPlugins,
  resetPluginLoaderState,
  type PluginLoaderDeps,
  type PluginRow,
} from './loader'

/*
 * Fixtures are real ESM bundles written to a real (temp) cache dir and loaded with a
 * real dynamic import(), because import() is the behaviour under test. The S3 read and
 * the provider_plugins writes are fakes: no bucket, no Postgres, no network.
 */

function mediaSource(id: string, version = '1.0.0'): string {
  return `const manifest = {
  kind: 'media',
  id: '${id}',
  version: '${version}',
  displayName: 'Loader Test Media',
  modalities: ['image'],
  allowedHosts: ['api.example.com'],
  credentialSchemas: ['legacy-api-key-v1'],
  models: [{ id: 'test-model', modalities: ['image'] }],
}
export default {
  manifest,
  validateConfig() {},
  validateRequest() {},
  async submit() {
    return { status: 'succeeded', outputs: [] }
  },
}
`
}

function languageSource(id: string, version = '1.0.0'): string {
  return `const manifest = {
  kind: 'language',
  id: '${id}',
  version: '${version}',
  displayName: 'Loader Test Language',
  languageProtocols: ['openai_chat'],
  allowedHosts: ['api.example.com'],
  credentialSchemas: ['legacy-api-key-v1'],
  models: [{ id: 'test-llm' }],
}
export default {
  manifest,
  validateConfig() {},
  async complete() {
    return { text: 'ok' }
  },
}
`
}

function forbiddenSource(): string {
  return `const manifest = {
  kind: 'media',
  id: 'loader-test-forbidden',
  version: '1.0.0',
  displayName: 'Loader Test Forbidden',
  modalities: ['image'],
  allowedHosts: ['api.example.com'],
  credentialSchemas: ['legacy-api-key-v1'],
  models: [{ id: 'test-model', modalities: ['image'] }],
}
export default {
  manifest,
  validateConfig() {},
  validateRequest() {},
  async submit(request, config, context) {
    const data = await fetch('https://api.example.com/leak')
    return { status: 'succeeded', outputs: [], extra: { k: process.env.APP_MASTER_KEY, d: data } }
  },
}
`
}

function rowFor(pluginId: string, bytes: Uint8Array, overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: `row-${pluginId}`,
    pluginId,
    pluginVersion: '1.0.0',
    kind: 'media',
    status: 'pending',
    objectKey: `plugin-packages/${pluginId}/1.0.0/${sha(bytes)}.mjs`,
    artifactSha256: sha(bytes),
    artifactSizeBytes: bytes.length,
    manifest: {},
    updatedAtMs: Date.now(),
    ...overrides,
  }
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const cacheRoot = await mkdtemp(join(tmpdir(), 'musecanvas-plugin-loader-'))
after(async () => {
  await rm(cacheRoot, { recursive: true, force: true })
})

function testDeps(source: string, pluginId: string, extra: Partial<PluginLoaderDeps> = {}): {
  deps: PluginLoaderDeps
  bytes: Uint8Array
  digest: string
  calls: { getObject: number; promotes: Array<{ status: string; code?: string }> }
} {
  const bytes = Buffer.from(source, 'utf8')
  const digest = sha(bytes)
  const calls = { getObject: 0, promotes: [] as Array<{ status: string; code?: string }> }
  const deps: PluginLoaderDeps = {
    cacheDir: join(cacheRoot, pluginId),
    getObject: async () => {
      calls.getObject += 1
      return bytes
    },
    promote: async (_row, status, failure) => {
      calls.promotes.push({ status, ...(failure ? { code: failure.code } : {}) })
      return true
    },
    ...extra,
  }
  return { deps, bytes, digest, calls }
}

test('a valid bundle loads, registers and materializes under its verified digest', async () => {
  const fixture = testDeps(mediaSource('loader-test-media'), 'loader-test-media')
  const row = rowFor('loader-test-media', fixture.bytes)
  const outcome = await loadPluginRow(row, fixture.deps)

  assert.deepEqual(outcome, { status: 'active', cacheHit: false })
  assert.equal(globalPluginRegistry.has('loader-test-media', '1.0.0'), true)
  assert.equal(globalPluginRegistry.kindOf('loader-test-media', '1.0.0'), 'media')
  assert.equal(isPluginAvailable('loader-test-media', '1.0.0'), true)
  assert.equal(resolveMediaPlugin('loader-test-media', '1.0.0').manifest.displayName, 'Loader Test Media')
  assert.equal(fixture.calls.getObject, 1)
  assert.deepEqual(fixture.calls.promotes, [{ status: 'active' }])

  const materialized = await readFile(pluginCachePath(fixture.digest, join(cacheRoot, 'loader-test-media')))
  assert.equal(materialized.equals(fixture.bytes), true)
  assert.equal(existsSync(join(cacheRoot, 'loader-test-media', `${fixture.digest}.mjs.part`)), false)

  // Second load of the same digest: served from the in-process registry, no object read.
  const again = await loadPluginRow(row, fixture.deps)
  assert.deepEqual(again, { status: 'active', cacheHit: true })
  assert.equal(fixture.calls.getObject, 1)
  assert.deepEqual(fixture.calls.promotes, [{ status: 'active' }])
})

test('a language bundle registers into the language kernel', async () => {
  const source = languageSource('loader-test-language')
  const bytes = Buffer.from(source, 'utf8')
  const fixture = testDeps(source, 'loader-test-language')
  const outcome = await loadPluginRow(rowFor('loader-test-language', bytes, { kind: 'language' }), fixture.deps)
  assert.equal(outcome.status, 'active')
  assert.equal(globalPluginRegistry.kindOf('loader-test-language', '1.0.0'), 'language')
  assert.deepEqual(fixture.calls.promotes, [{ status: 'active' }])
  // The worker's own language call site is what consumes this: load -> register -> gate.
  assert.deepEqual(
    installedLanguagePluginBinding({ pluginId: 'loader-test-language', pluginVersion: '1.0.0', apiKey: 'sk-x' }),
    { pluginId: 'loader-test-language', pluginVersion: '1.0.0', credential: { schema: 'legacy-api-key-v1', apiKey: 'sk-x' } },
  )
})

test('an artifact whose digest moved is refused before it touches disk', async () => {
  const bytes = Buffer.from(mediaSource('loader-test-tampered'), 'utf8')
  const realDigest = sha(bytes)
  const fixture = testDeps(mediaSource('loader-test-tampered'), 'loader-test-tampered')
  const row = rowFor('loader-test-tampered', bytes, { artifactSha256: 'f'.repeat(64) })
  const outcome = await loadPluginRow(row, fixture.deps)

  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.code, 'PLUGIN_ARTIFACT_HASH_MISMATCH')
  assert.equal(globalPluginRegistry.has('loader-test-tampered', '1.0.0'), false)
  assert.equal(isPluginAvailable('loader-test-tampered', '1.0.0'), false)
  assert.deepEqual(fixture.calls.promotes, [{ status: 'failed', code: 'PLUGIN_ARTIFACT_HASH_MISMATCH' }])
  // Nothing unverified was materialized: neither the claimed name nor the real one.
  assert.equal(existsSync(pluginCachePath('f'.repeat(64), join(cacheRoot, 'loader-test-tampered'))), false)
  assert.equal(existsSync(pluginCachePath(realDigest, join(cacheRoot, 'loader-test-tampered'))), false)
})

test('a stale file already sitting at the digest path is verified, not trusted', async () => {
  const source = mediaSource('loader-test-warm')
  const bytes = Buffer.from(source, 'utf8')
  const digest = sha(bytes)
  const cacheDir = join(cacheRoot, 'loader-test-warm')
  const fixture = testDeps(source, 'loader-test-warm')
  await mkdir(cacheDir, { recursive: true })
  // Same length, different content: what bit rot or an edited cache file looks
  // like, and the exact case a size-only "already cached?" check waves through.
  await writeFile(join(cacheDir, `${digest}.mjs`), bytes.map(byte => byte ^ 0x20))
  const outcome = await loadPluginRow(rowFor('loader-test-warm', bytes), fixture.deps)
  assert.equal(outcome.status, 'active')
  assert.equal((await readFile(join(cacheDir, `${digest}.mjs`))).equals(bytes), true)
  assert.equal(globalPluginRegistry.kindOf('loader-test-warm', '1.0.0'), 'media')
})

test('a bundle reaching for global fetch or process.env is refused by the scan', async () => {
  const bytes = Buffer.from(forbiddenSource(), 'utf8')
  const fixture = testDeps(forbiddenSource(), 'loader-test-forbidden')
  const outcome = await loadPluginRow(rowFor('loader-test-forbidden', bytes), fixture.deps)
  assert.equal(outcome.code, 'PLUGIN_ARTIFACT_SCAN_FAILED')
  assert.equal(globalPluginRegistry.has('loader-test-forbidden', '1.0.0'), false)
})

test('manifest identity drift fails with a specific code', async () => {
  const cases: Array<{ claim: string; source: string; kind: PluginRow['kind']; code: string }> = [
    { claim: 'loader-test-claim-id', source: mediaSource('loader-test-drift-id'), kind: 'media', code: 'PLUGIN_ID_MISMATCH' },
    { claim: 'loader-test-claim-version', source: mediaSource('loader-test-claim-version', '2.0.0'), kind: 'media', code: 'PLUGIN_VERSION_MISMATCH' },
    { claim: 'loader-test-claim-kind', source: languageSource('loader-test-claim-kind'), kind: 'media', code: 'PLUGIN_KIND_MISMATCH' },
  ]
  for (const item of cases) {
    const bytes = Buffer.from(item.source, 'utf8')
    const row = rowFor(item.claim, bytes, { kind: item.kind })
    const fixture = testDeps(item.source, item.claim)
    const outcome = await loadPluginRow(row, fixture.deps)
    assert.equal(outcome.status, 'failed', item.code)
    assert.equal(outcome.code, item.code)
    assert.equal(globalPluginRegistry.has(item.claim, '1.0.0'), false, item.code)
    assert.deepEqual(fixture.calls.promotes, [{ status: 'failed', code: item.code }], item.code)
  }
})

test('a bundle missing its kernel interface fails instead of half-registering', async () => {
  const source = `const manifest = {
  kind: 'media',
  id: 'loader-test-partial',
  version: '1.0.0',
  displayName: 'Partial',
  modalities: ['image'],
  allowedHosts: ['api.example.com'],
  credentialSchemas: ['legacy-api-key-v1'],
  models: [{ id: 'test-model', modalities: ['image'] }],
}
export default { manifest, validateConfig() {}, validateRequest() {} }
`
  const bytes = Buffer.from(source, 'utf8')
  const outcome = await loadPluginRow(rowFor('loader-test-partial', bytes), testDeps(source, 'loader-test-partial').deps)
  assert.equal(outcome.code, 'PLUGIN_INTERFACE_INVALID')
  assert.equal(globalPluginRegistry.has('loader-test-partial', '1.0.0'), false)
})

test('a disabled or failed row is never imported, and a built-in id is refused', async () => {
  const bytes = Buffer.from(mediaSource('loader-test-disabled'), 'utf8')
  const disabled = testDeps(mediaSource('loader-test-disabled'), 'loader-test-disabled')
  const outcome = await loadPluginRow(rowFor('loader-test-disabled', bytes, { status: 'disabled' }), disabled.deps)
  assert.deepEqual(outcome, { status: 'disabled', cacheHit: false })
  assert.equal(disabled.calls.getObject, 0)
  assert.equal(disabled.calls.promotes.length, 0)
  assert.equal(statusOf('loader-test-disabled', '1.0.0'), 'disabled')

  // The API never issues this row, but a hand-inserted one must not shadow the image.
  const reservedBytes = Buffer.from(mediaSource('openai-image', '1.1.0'), 'utf8')
  const reserved = testDeps(mediaSource('openai-image', '1.1.0'), 'loader-test-reserved')
  const reservedOutcome = await loadPluginRow(
    rowFor('openai-image', reservedBytes, { pluginVersion: '1.1.0' }),
    reserved.deps,
  )
  assert.equal(reservedOutcome.code, 'PLUGIN_RESERVED_KEY')
  assert.equal(reserved.calls.getObject, 0)
})

test('a transient storage outage keeps the row pending instead of failing it', async () => {
  const bytes = Buffer.from(mediaSource('loader-test-outage'), 'utf8')
  const outcome = await loadPluginRow(rowFor('loader-test-outage', bytes), {
    cacheDir: join(cacheRoot, 'loader-test-outage'),
    getObject: async () => {
      throw new Error('STORAGE_NOT_CONFIGURED')
    },
    promote: async () => {
      throw new Error('must not write the catalog')
    },
  })
  assert.equal(outcome.status, 'pending')
  assert.equal(outcome.code, 'PLUGIN_ARTIFACT_FETCH_PENDING')
  assert.equal(statusOf('loader-test-outage', '1.0.0'), 'untracked')
  assert.equal(globalPluginRegistry.has('loader-test-outage', '1.0.0'), false)
})

test('an oversized artifact is refused without an object read', async () => {
  const bytes = Buffer.from(mediaSource('loader-test-oversized'), 'utf8')
  const fixture = testDeps(mediaSource('loader-test-oversized'), 'loader-test-oversized')
  const outcome = await loadPluginRow(
    rowFor('loader-test-oversized', bytes, { artifactSizeBytes: 6_000_000 }),
    fixture.deps,
  )
  assert.equal(outcome.code, 'PLUGIN_ARTIFACT_TOO_LARGE')
  assert.equal(fixture.calls.getObject, 0)
})

test('the loader refuses a 41st package instead of growing without bound', async () => {
  const bytes = Buffer.from(mediaSource('loader-test-cap'), 'utf8')
  const fixture = testDeps(mediaSource('loader-test-cap'), 'loader-test-cap')
  resetPluginAvailability()
  for (let index = 0; index < MAX_INSTALLED_PLUGINS; index += 1) {
    setPluginStatus(`cap-filler-${index}`, '1.0.0', 'active')
  }
  const outcome = await loadPluginRow(rowFor('loader-test-cap', bytes), fixture.deps)
  assert.equal(outcome.code, 'PLUGIN_CAPACITY_EXCEEDED')
  assert.equal(fixture.calls.getObject, 0)
  assert.deepEqual(fixture.calls.promotes, [{ status: 'failed', code: 'PLUGIN_CAPACITY_EXCEEDED' }])
  resetPluginAvailability()
})

test('a bundle that never settles at import time times out and fails', async () => {
  const bytes = Buffer.from(mediaSource('loader-test-hang'), 'utf8')
  const fixture = testDeps(mediaSource('loader-test-hang'), 'loader-test-hang', {
    importModule: () => new Promise<never>(() => {}),
    importTimeoutMs: 25,
  })
  const outcome = await loadPluginRow(rowFor('loader-test-hang', bytes), fixture.deps)
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.code, 'PLUGIN_IMPORT_TIMEOUT')
  assert.equal(globalPluginRegistry.has('loader-test-hang', '1.0.0'), false)
})

test('refresh mirrors the catalog, loads pending rows and advances the watermark', async () => {
  resetPluginLoaderState()
  resetPluginAvailability()
  const source = mediaSource('loader-refresh-media')
  const bytes = Buffer.from(source, 'utf8')
  const digest = sha(bytes)
  const cacheDir = join(cacheRoot, 'loader-refresh-media')
  const promotes: Array<{ status: string; code?: string }> = []
  let status = 'pending'
  const catalogRow = (): Record<string, unknown> => ({
    id: 'row-loader-refresh-media',
    plugin_id: 'loader-refresh-media',
    plugin_version: '1.0.0',
    kind: 'media',
    status,
    object_key: `plugin-packages/loader-refresh-media/1.0.0/${digest}.mjs`,
    artifact_sha256: digest,
    artifact_size_bytes: bytes.length,
    manifest: {},
    updated_at_ms: 1_700_000_000_000,
    watermark_ms: 1_700_000_000_500,
  })
  const deps: PluginLoaderDeps = {
    cacheDir,
    getObject: async () => bytes,
    promote: async (_row, next, failure) => {
      promotes.push({ status: next, ...(failure ? { code: failure.code } : {}) })
      status = next
      return true
    },
    query: async () => ({ rows: [catalogRow()] }),
  }

  const first = await refreshPlugins(deps)
  assert.equal(first.mode, 'full')
  assert.equal(first.loaded, 1)
  assert.equal(isPluginAvailable('loader-refresh-media', '1.0.0'), true)
  assert.equal(first.watermarkMs, 1_700_000_000_500)
  assert.deepEqual(promotes, [{ status: 'active' }])

  // The catalog now reports the row as active; the second pass must not re-import it.
  const second = await refreshPlugins(deps)
  assert.equal(second.mode, 'incremental')
  assert.equal(second.loaded, 0)
  assert.equal(second.changed, 0)
  assert.equal(isPluginAvailable('loader-refresh-media', '1.0.0'), true)
  assert.deepEqual(promotes, [{ status: 'active' }])

  // An admin disables it: the registry still holds the module (append-only), but the
  // gate closes and a full sweep stops trusting a row that vanished entirely.
  status = 'disabled'
  const disabledPass = await refreshPlugins(deps)
  assert.equal(disabledPass.changed, 1)
  assert.equal(isPluginAvailable('loader-refresh-media', '1.0.0'), false)
  assert.throws(() => resolveMediaPlugin('loader-refresh-media', '1.0.0'), { name: 'NormalizedProviderError' })

  status = 'active'
  const pruned = await refreshPlugins({ ...deps, full: true, query: async () => ({ rows: [] }) })
  assert.equal(pruned.rows, 0)
  assert.equal(pruned.changed, 1)
  assert.equal(statusOf('loader-refresh-media', '1.0.0'), 'untracked')
  assert.equal(existsSync(join(cacheDir, `${digest}.mjs`)), true)
  resetPluginLoaderState()
})

test('a refresh whose read throws is contained and reports nothing', async () => {
  resetPluginLoaderState()
  const result = await refreshPlugins({
    query: async () => {
      throw new Error('connection reset')
    },
  })
  assert.deepEqual(result, { mode: 'full', rows: 0, loaded: 0, failed: 0, changed: 0, watermarkMs: null })
  resetPluginLoaderState()
})

test('the cache dir never resolves inside the image layer', async () => {
  const original = process.env.PLUGIN_CACHE_DIR
  process.env.PLUGIN_CACHE_DIR = '/app/plugins'
  const path = pluginCachePath('a'.repeat(64))
  assert.equal(path.startsWith('/app'), false)
  assert.match(path, /musecanvas-plugin-cache/)
  process.env.PLUGIN_CACHE_DIR = join(cacheRoot, 'env-dir')
  assert.equal(pluginCachePath('b'.repeat(64)), join(cacheRoot, 'env-dir', `${'b'.repeat(64)}.mjs`))
  if (original === undefined) delete process.env.PLUGIN_CACHE_DIR
  else process.env.PLUGIN_CACHE_DIR = original
})
