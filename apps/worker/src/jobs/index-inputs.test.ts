import assert from 'node:assert/strict'
import test from 'node:test'
import type pg from 'pg'
import { loadMediaInputRows } from './index'

type Link = { upload_id?: string; asset_id?: string; input_image_id?: string; role: string; position: number }

/** Recording row adapter: no database, storage, runtime settings or provider calls. */
function fixture(links: Link[], absent: string[] = []) {
  const statements: string[] = []
  const query = async (sql: string, params: unknown[]) => {
    statements.push(sql)
    assert.deepEqual(params, ['job'])
    if (sql.includes('SELECT count(*)')) {
      assert.match(sql, /input_image_id IS NOT NULL/)
      return { rows: [{ count: links.length }] }
    }
    assert.match(sql, /JOIN generation_input_images gii ON gii.id = gji.input_image_id/)
    assert.match(sql, /gji.upload_id IS NULL AND gji.asset_id IS NULL AND gii.deleted_at IS NULL/)
    assert.match(sql, /SELECT gji.position, gji.role, gii.id/)
    assert.match(sql, /ORDER BY inputs.position ASC/)
    const resolved = links.filter(link => !absent.includes(link.upload_id ?? link.asset_id ?? link.input_image_id!))
      .sort((a, b) => a.position - b.position)
      .map(link => ({ id: link.upload_id ?? link.asset_id ?? link.input_image_id, role: link.role, position: link.position }))
    return { rows: resolved }
  }
  return { database: { query } as unknown as Pick<pg.Pool, 'query'>, statements }
}

test('legacy-only input row is included with its declared role and position', async () => {
  const f = fixture([{ input_image_id: 'legacy', role: 'mask', position: 0 }])
  assert.deepEqual(await loadMediaInputRows('job', f.database), [{ id: 'legacy', role: 'mask', position: 0 }])
})

test('mixed legacy+upload and legacy+asset reads preserve ordering and role without duplicating mirrors', async () => {
  for (const other of [
    { upload_id: 'upload', input_image_id: 'upload', role: 'mask', position: 1 },
    { asset_id: 'asset', role: 'reference_image', position: 1 },
  ]) {
    const f = fixture([other, { input_image_id: 'legacy', role: 'reference_image', position: 0 }])
    const rows = await loadMediaInputRows('job', f.database)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(row => [row.id, row.position, row.role]), [
      ['legacy', 0, 'reference_image'], [other.upload_id ?? other.asset_id, 1, other.role],
    ])
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length)
  }
})

test('missing or deleted legacy input cannot silently produce a partial mixed request', async () => {
  for (const links of [
    [{ input_image_id: 'missing-or-deleted', role: 'mask', position: 0 }],
    [{ input_image_id: 'missing-or-deleted', role: 'reference_image', position: 0 }, { asset_id: 'asset', role: 'reference_image', position: 1 }],
  ]) {
    const f = fixture(links, ['missing-or-deleted'])
    await assert.rejects(loadMediaInputRows('job', f.database), /INPUT_IMAGE_UNAVAILABLE/)
  }
})

test('input count SQL failures propagate instead of disabling completeness validation', async () => {
  const f = fixture([])
  const failure = new Error('synthetic count failure')
  const query = async (sql: string) => { if (sql.includes('SELECT count(*)')) throw failure; return { rows: [] } }
  await assert.rejects(loadMediaInputRows('job', { query } as unknown as Pick<pg.Pool, 'query'>), error => error === failure)
  assert.equal(f.statements.length, 0)
})
