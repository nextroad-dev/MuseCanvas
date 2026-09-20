import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import '../../packages/providers/src/plugins/index'
import { globalProviderRegistry } from '../../packages/providers/src/core/registry'

/**
 * The migration in `packages/database/src/migrate.ts` (section 10b) has to embed
 * each plugin's descriptor JSON as a SQL literal, because SQL cannot import
 * TypeScript. That is the one remaining copy in this architecture, and an
 * unpinned copy rots silently: the API would keep serving a contract the plugins
 * no longer declare, which is precisely the drift this whole change removes.
 *
 * So this test re-derives the declarations from the live plugin registry and
 * asserts every one of them appears verbatim in the migration text. Editing a
 * plugin's capabilities without regenerating the migration fails here.
 */

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../packages/database/src/migrate.ts', import.meta.url)),
  'utf8',
)

function section(): string {
  const start = MIGRATION.indexOf('10b. Plugin-declared')
  assert.ok(start > 0, 'migration section 10b must exist')
  const end = MIGRATION.indexOf('-- 11. Resumable', start)
  assert.ok(end > start, 'section 10b must be followed by section 11')
  return MIGRATION.slice(start, end)
}

/** Un-escape SQL single quotes so the embedded text can be parsed as JSON. */
function embeddedRows(text: string): Map<string, unknown> {
  const rows = new Map<string, unknown>()
  const pattern = /\('([a-z0-9-]+)', '([0-9.]+)', '([^']+)',\s*\n\s*'([\s\S]*?)'::jsonb,\s*\n\s*'([\s\S]*?)'::jsonb\)/g
  for (const match of text.matchAll(pattern)) {
    const [, pluginId, version, vendorModelId, capabilities, defaults] = match
    rows.set(`${pluginId}@${version}:${vendorModelId}`, {
      pluginId,
      version,
      vendorModelId,
      capabilities: JSON.parse(capabilities.replace(/''/g, "'")),
      defaults: JSON.parse(defaults.replace(/''/g, "'")),
    })
  }
  return rows
}

test('migration section 10b parses as SQL-escaped JSON rows', () => {
  const rows = embeddedRows(section())
  assert.ok(rows.size > 0, 'no declared rows were parsed — the SQL shape probably changed')
})

test('every manifest-declared model is present in the migration, byte-for-byte', () => {
  const rows = embeddedRows(section())
  const checked: string[] = []

  for (const manifest of globalProviderRegistry.listManifests()) {
    // Only the active version of each plugin is backfilled; legacy 1.0.0 image
    // registrations stay permissive on purpose so pinned revisions keep working.
    const isActive = manifest.id === 'openai-image' || manifest.id === 'seedream-image'
      ? manifest.version === '1.1.0'
      : true
    if (!isActive) continue

    for (const model of manifest.models ?? []) {
      if (!model.capabilities) continue
      const key = `${manifest.id}@${manifest.version}:${model.id}`
      const embedded = rows.get(key)
      assert.ok(embedded, `${key} is declared by its plugin but missing from migration section 10b`)

      // `declaredBy` is added by the backfill itself, not by the plugin.
      assert.deepEqual(
        embedded.capabilities,
        { ...model.capabilities, declaredBy: 'plugin-manifest' },
        `${key} capabilities in the migration differ from the plugin declaration`,
      )
      assert.deepEqual(
        embedded.defaults,
        model.defaults ?? {},
        `${key} defaults in the migration differ from the plugin declaration`,
      )
      checked.push(key)
    }
  }

  assert.ok(checked.length >= 9, `expected every built-in model to be covered, saw ${checked.length}`)
})

test('the migration carries no descriptor row for a model no plugin declares', () => {
  const rows = embeddedRows(section())
  const declared = new Set<string>()
  for (const manifest of globalProviderRegistry.listManifests()) {
    for (const model of manifest.models ?? []) {
      declared.add(`${manifest.id}@${manifest.version}:${model.id}`)
    }
  }
  for (const key of rows.keys()) {
    assert.ok(declared.has(key), `${key} is backfilled but no plugin declares it — stale migration row`)
  }
})
