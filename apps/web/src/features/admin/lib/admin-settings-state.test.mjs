import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adminSettingsDraftChanged, hasNewerAdminSettingsRevision, requireVerifiedAdminSettings, resolveAdminConcurrency } from './admin-settings-state.ts'

test('unchanged or omitted keep-value fields are no-op saves; nonempty write-only secrets are changes', () => {
  const baseline = { host: 'smtp.example.com', port: 465, revision: 1, hasSecret: true }
  assert.equal(adminSettingsDraftChanged({ host: undefined, port: undefined, password: undefined }, baseline), false)
  assert.equal(adminSettingsDraftChanged({ host: 'smtp.example.com', port: 465 }, baseline), false)
  assert.equal(adminSettingsDraftChanged({ host: 'new.example.com' }, baseline), true)
  assert.equal(adminSettingsDraftChanged({ password: 'new draft secret' }, baseline), true)
})

test('external newer revision is signaled without treating older post-save cache as new configuration', () => {
  const loaded = { revision: 5 }
  assert.equal(hasNewerAdminSettingsRevision(loaded, { revision: 6 }), true)
  assert.equal(hasNewerAdminSettingsRevision(loaded, { revision: 5 }), false)
  assert.equal(hasNewerAdminSettingsRevision(loaded, { revision: 4 }), false)
  assert.deepEqual(loaded, { revision: 5 })
})

test('only successful verified test responses supply a persisted baseline to adopt', () => {
  const settings = { revision: 6, status: 'verified' }
  assert.strictEqual(requireVerifiedAdminSettings({ success: true, data: { verified: true, settings } }, 'failed'), settings)
  for (const response of [
    { success: false, data: { verified: true, settings } },
    { success: true, data: { verified: false, settings } },
    { success: true, data: { verified: true } },
    { success: true },
  ]) assert.throws(() => requireVerifiedAdminSettings(response, 'test failed'), /test failed/)
  assert.deepEqual(settings, { revision: 6, status: 'verified' })
})

test('model concurrency rejects zero, 51, fraction, empty, nonfinite and malformed drafts without parseInt coercion', () => {
  for (const raw of ['0', '51', '1.5', '', ' ', 'NaN', 'Infinity', '3abc', '-1']) {
    const result = resolveAdminConcurrency(raw)
    assert.equal(result.value, undefined, raw)
    assert.ok(result.error, raw)
  }
  for (const raw of ['1', '50', ' 2 ', '1.0']) {
    assert.equal(resolveAdminConcurrency(raw).value, Number(raw))
    assert.equal(resolveAdminConcurrency(raw).error, undefined)
  }
})
