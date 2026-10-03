// Zip plugin package round trip: pack -> upload (API analysis + install) -> worker load -> invoke.
//
// Runner: node --import tsx --test tests/integration/plugin-package-roundtrip.test.ts
// Fully mocked: no Postgres, no S3, no network. The API's install takes its I/O
// seams as PluginInstallDeps and the worker's loader takes PluginLoaderDeps, so
// one in-memory "bucket" and one captured INSERT stand in for the two shared
// resources the real processes communicate through. The worker reads back only
// what the API stored under the entry key, exactly as in production: it never
// sees the zip.
//
// Relative imports into apps/* are confined to this root-level test, which is
// the only place both halves of the hand-off can be exercised together.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DefaultSafeHttpClient,
  createPluginPackageZip,
  globalPluginRegistry,
  type ExecutionContext,
} from '../../packages/providers/src/index.ts'
import { installPlugin, type PluginInstallDeps } from '../../apps/api/src/modules/admin/plugins.ts'
import { loadPluginRow, type PluginRow } from '../../apps/worker/src/plugins/loader.ts'
import type { Actor } from '../../apps/api/src/auth/security.ts'

process.env.ALLOW_PLUGIN_UPLOAD = 'true'

const ADMIN = { id: 'admin-1', role: 'admin' } as unknown as Actor
const encode = (value: string) => new TextEncoder().encode(value)

const MANIFEST = {
  kind: 'media',
  id: 'roundtrip-video',
  version: '1.0.0',
  displayName: 'Roundtrip Video',
  modalities: ['video'],
  allowedHosts: ['api.roundtrip.example'],
  credentialSchemas: ['legacy-api-key-v1'],
  credential: {
    providerId: 'roundtrip',
    schemaId: 'legacy-api-key-v1',
    secret: { format: 'text', label: 'Roundtrip API Key' },
    baseUrl: { default: 'https://api.roundtrip.example', policy: 'fixed' },
  },
  models: [{ id: 'rt-1', modalities: ['video'] }],
}

/** What an author's build produces: the bundle inlines manifest.json (spec §8). */
function bundleFor(manifest: unknown): string {
  return `const manifest = ${JSON.stringify(manifest)}
export default {
  manifest,
  validateConfig() {},
  validateRequest() {},
  async submit(request, config, context) {
    const response = await context.http.post('https://api.roundtrip.example/v1/videos', JSON.stringify({ model: request.vendorModelId, prompt: request.prompt }), {
      headers: { 'content-type': 'application/json' },
    })
    const body = await response.json()
    return { status: 'running', remoteId: body.id }
  },
}
`
}

function packageFor(bundleManifest: unknown, id = MANIFEST.id): Uint8Array {
  const manifest = { ...MANIFEST, id, credential: { ...MANIFEST.credential, providerId: `${id}-account` } }
  const declared = { ...(bundleManifest as Record<string, unknown>), id, credential: manifest.credential }
  return createPluginPackageZip({
    'manifest.json': encode(JSON.stringify({ ...manifest, package: { format: 1, entry: 'dist/plugin.mjs', author: 'Roundtrip' } })),
    'dist/plugin.mjs': encode(bundleFor(declared)),
    'README.md': encode('# Roundtrip\n'),
  })
}

// No top-level await: the repository root is not `type: module`, so tsx loads
// this file as CommonJS.
let cacheRoot = ''
before(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'musecanvas-plugin-roundtrip-'))
})
after(async () => {
  if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true })
})

/** Upload through the real API handler, capturing the bucket and the row it wrote. */
async function upload(zip: Uint8Array): Promise<{ status: number; bucket: Map<string, Buffer>; row: Record<string, unknown> | null }> {
  const bucket = new Map<string, Buffer>()
  let row: Record<string, unknown> | null = null
  const deps: PluginInstallDeps = {
    query: async () => ({ rows: [] }),
    transaction: async fn => fn({
      query: async (sql, params) => {
        if (!sql.startsWith('INSERT INTO provider_plugins')) return { rows: [] }
        const flat = sql.replace(/\s+/g, ' ')
        const columns = (/provider_plugins\(([^)]*)\)/.exec(flat)?.[1] ?? '').split(',').map(column => column.trim())
        const values = (/VALUES\(([^)]*)\)/.exec(flat)?.[1] ?? '').split(',').map(value => value.trim())
        const inserted: Record<string, unknown> = { id: 'row-roundtrip', created_at: new Date(0), updated_at: new Date(0) }
        columns.forEach((column, index) => {
          const match = /^\$(\d+)(::jsonb)?$/.exec(values[index] ?? '')
          const value = match ? params[Number(match[1]) - 1] : (values[index] ?? '').replace(/^'|'$/g, '')
          inserted[column] = match?.[2] && typeof value === 'string' ? JSON.parse(value) : value
        })
        row = inserted
        return { rows: [inserted] }
      },
    }),
    putObject: async (key, bytes) => {
      bucket.set(key, Buffer.from(bytes))
    },
    deleteObject: async key => {
      bucket.delete(key)
    },
  }
  const request = {
    formData: async () => {
      const form = new FormData()
      form.append('package', new Blob([new Uint8Array(zip)]), 'plugin.zip')
      return form
    },
  }
  const response = await installPlugin(ADMIN, request, deps)
  return { status: response.status, bucket, row }
}

/** The worker's catalog view of the stored row (what mapCatalogRow yields). */
function catalogRow(row: Record<string, unknown>): PluginRow {
  return {
    id: String(row.id),
    pluginId: String(row.plugin_id),
    pluginVersion: String(row.plugin_version),
    kind: row.kind as PluginRow['kind'],
    status: 'pending',
    objectKey: String(row.object_key),
    artifactSha256: String(row.artifact_sha256),
    artifactSizeBytes: Number(row.artifact_size_bytes),
    manifest: row.manifest,
    packageFormat: row.package_format as PluginRow['packageFormat'],
    updatedAtMs: 0,
  }
}

test('a zip package uploads, loads in the worker from the entry key alone, and runs', async () => {
  const uploaded = await upload(packageFor(MANIFEST))
  assert.equal(uploaded.status, 201)
  assert.ok(uploaded.row)
  assert.equal(uploaded.row.package_format, 'zip-v1')
  // Bundle and archive; this package ships no icon.
  assert.deepEqual([...uploaded.bucket.keys()].map(key => key.split('.').pop()).sort(), ['mjs', 'zip'])

  const fetchedKeys: string[] = []
  const promotes: string[] = []
  const outcome = await loadPluginRow(catalogRow(uploaded.row), {
    cacheDir: join(cacheRoot, 'ok'),
    getObject: async key => {
      fetchedKeys.push(key)
      const bytes = uploaded.bucket.get(key)
      if (!bytes) throw new Error(`no object ${key}`)
      return bytes
    },
    promote: async (_row, status) => {
      promotes.push(status)
      return true
    },
  })
  assert.deepEqual(outcome, { status: 'active', cacheHit: false })
  assert.deepEqual(promotes, ['active'])
  // The worker read the entry bundle only, under the unchanged .mjs key format.
  assert.deepEqual(fetchedKeys, [uploaded.row.object_key])
  assert.match(String(uploaded.row.object_key), /^plugin-packages\/roundtrip-video\/1\.0\.0\/[0-9a-f]{64}\.mjs$/)

  // Invoke: egress is held to the allowlist that came from manifest.json.
  const calls: string[] = []
  const http = new DefaultSafeHttpClient({
    pluginId: 'roundtrip-video',
    version: '1.0.0',
    allowedHosts: MANIFEST.allowedHosts,
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ id: 'remote-42' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
  })
  const context: ExecutionContext = {
    pluginId: 'roundtrip-video',
    version: '1.0.0',
    http,
    readOutput: async () => {
      throw new Error('not used')
    },
  }
  const plugin = globalPluginRegistry.getMedia('roundtrip-video', '1.0.0')
  const result = await plugin.submit({ modality: 'video', vendorModelId: 'rt-1', prompt: 'a calm sea' }, {}, context)
  assert.deepEqual(result, { status: 'running', remoteId: 'remote-42' })
  assert.deepEqual(calls, ['https://api.roundtrip.example/v1/videos'])
})

test('a bundle that drifts from its own manifest.json passes the upload but is refused at load', async () => {
  // Same identity, wider egress in the bundle: invisible to the API, which only
  // scans text, and exactly what the worker's deep comparison exists to catch.
  const drifted = { ...MANIFEST, allowedHosts: [...MANIFEST.allowedHosts, 'exfil.example.net'] }
  const uploaded = await upload(packageFor(drifted, 'roundtrip-drift'))
  assert.equal(uploaded.status, 201)
  assert.ok(uploaded.row)
  const failures: string[] = []
  const outcome = await loadPluginRow(catalogRow(uploaded.row), {
    cacheDir: join(cacheRoot, 'drift'),
    getObject: async key => uploaded.bucket.get(key) as Buffer,
    promote: async (_row, status, failure) => {
      if (failure) failures.push(`${status}:${failure.code}`)
      return true
    },
  })
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.code, 'PLUGIN_MANIFEST_MISMATCH')
  assert.deepEqual(failures, ['failed:PLUGIN_MANIFEST_MISMATCH'])
  assert.equal(globalPluginRegistry.has('roundtrip-drift', '1.0.0'), false)
})
