import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CANVAS_AGENT_NUMERIC_FIELDS,
  CANVAS_AGENT_SETTING_LIMITS,
  canvasAgentDraftChanged,
  canvasAgentSaveError,
  canvasAgentSettingsDraft,
  hasNewerCanvasAgentSettings,
  validateCanvasAgentDraft,
} from './canvas-agent-settings-state.ts'

// Mirrors the server default row (packages/database/migrations/0031_canvas_agent.sql
// + CANVAS_AGENT_SETTINGS_DEFAULTS in packages/contracts/src/canvas.ts).
const defaults = () => ({
  enabled: false,
  languageModelConfigId: null,
  maxToolCallsPerTurn: 12,
  maxJobsPerTurn: 4,
  timeoutMs: 120_000,
  maxAutoContinuations: 3,
  updatedAt: '2026-10-06T00:00:00.000Z',
})

const available = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']

test('server defaults map to a disabled draft with no model selected', () => {
  const draft = canvasAgentSettingsDraft(defaults())
  assert.equal(draft.enabled, false)
  assert.equal(draft.languageModelConfigId, '')
  assert.deepEqual(
    CANVAS_AGENT_NUMERIC_FIELDS.map((field) => draft[field]),
    ['12', '4', '120000', '3'],
  )
})

test('an unbound disabled draft never auto-binds an available model and saves null', () => {
  const draft = canvasAgentSettingsDraft(defaults())
  const result = validateCanvasAgentDraft(draft, available)
  assert.deepEqual(result.errors, {})
  assert.equal(result.payload.languageModelConfigId, null)
  assert.equal(result.payload.enabled, false)
  assert.deepEqual(Object.keys(result.payload).sort(), [
    'enabled',
    'languageModelConfigId',
    'maxAutoContinuations',
    'maxJobsPerTurn',
    'maxToolCallsPerTurn',
    'timeoutMs',
  ])
  // The save path carries only settings identity: no connectivity/test switch.
  for (const forbidden of ['test', 'verify', 'connect', 'providerCredentialId', 'baseUrl', 'apiKey']) {
    assert.equal(forbidden in result.payload, false, forbidden)
  }
})

test('numeric fields enforce exactly the server bounds, rejecting empty, fractional and non-numeric drafts', () => {
  assert.deepEqual(CANVAS_AGENT_SETTING_LIMITS, {
    maxToolCallsPerTurn: { min: 1, max: 32 },
    maxJobsPerTurn: { min: 1, max: 8 },
    timeoutMs: { min: 1_000, max: 300_000 },
    maxAutoContinuations: { min: 0, max: 10 },
  })
  for (const field of CANVAS_AGENT_NUMERIC_FIELDS) {
    const { min, max } = CANVAS_AGENT_SETTING_LIMITS[field]
    for (const raw of [String(min - 1), String(max + 1), '', ' ', '1.5', 'abc', 'NaN', 'Infinity', '12abc', '-1']) {
      const draft = { ...canvasAgentSettingsDraft(defaults()), [field]: raw }
      const result = validateCanvasAgentDraft(draft, available)
      assert.equal(result.payload, undefined, `${field}=${raw}`)
      assert.ok(result.errors[field], `${field}=${raw}`)
      assert.ok(result.errors[field].includes(`${min}–${max}`), result.errors[field])
    }
    for (const raw of [String(min), String(max), ` ${min} `, max.toFixed(1)]) {
      const draft = { ...canvasAgentSettingsDraft(defaults()), [field]: raw }
      assert.equal(validateCanvasAgentDraft(draft, available).errors[field], undefined, `${field}=${raw}`)
    }
  }
})

test('enabling requires a selected model and rejects a model missing from the catalog', () => {
  const enabledWithoutModel = { ...canvasAgentSettingsDraft(defaults()), enabled: true }
  const missing = validateCanvasAgentDraft(enabledWithoutModel, available)
  assert.equal(missing.payload, undefined)
  assert.match(missing.errors.languageModelConfigId, /必须选择/)

  const stale = { ...canvasAgentSettingsDraft(defaults()), languageModelConfigId: '99999999-9999-4999-8999-999999999999' }
  assert.match(validateCanvasAgentDraft(stale, available).errors.languageModelConfigId, /不在可用列表/)

  const ok = { ...canvasAgentSettingsDraft(defaults()), enabled: true, languageModelConfigId: available[1] }
  const accepted = validateCanvasAgentDraft(ok, available)
  assert.equal(accepted.errors.languageModelConfigId, undefined)
  assert.equal(accepted.payload.languageModelConfigId, available[1])
})

test('a catalog that failed to load cannot fabricate a selection error from an empty list', () => {
  const draft = { ...canvasAgentSettingsDraft(defaults()), enabled: true, languageModelConfigId: available[0] }
  // `availableModelIds` is empty when the models request failed: the server still
  // validates, so the client must not claim the stored binding is invalid.
  assert.equal(validateCanvasAgentDraft(draft, []).errors.languageModelConfigId, undefined)
})

test('dirty tracking compares every field against the persisted row', () => {
  const settings = defaults()
  const baseline = canvasAgentSettingsDraft(settings)
  assert.equal(canvasAgentDraftChanged(baseline, settings), false)
  assert.equal(canvasAgentDraftChanged({ ...baseline, enabled: true }, settings), true)
  assert.equal(canvasAgentDraftChanged({ ...baseline, languageModelConfigId: available[0] }, settings), true)
  assert.equal(canvasAgentDraftChanged({ ...baseline, timeoutMs: '60000' }, settings), true)
  assert.equal(canvasAgentDraftChanged({ ...baseline, timeoutMs: '120000' }, settings), false)
  assert.equal(canvasAgentDraftChanged({ ...baseline, timeoutMs: '' }, settings), true)
})

test('save errors map known server codes to actionable copy without echoing payloads', () => {
  assert.match(canvasAgentSaveError({ code: 'CANVAS_AGENT_NOT_CONFIGURED', message: 'Provider https://internal.example' }), /语言模型当前不可用/)
  assert.match(canvasAgentSaveError({ code: 'CANVAS_AGENT_MODEL_UNSUPPORTED' }), /openai_chat/)
  assert.match(canvasAgentSaveError({ code: 'INVALID_INPUT' }), /超出服务端允许范围/)
  assert.match(canvasAgentSaveError({ code: 'FORBIDDEN' }), /仅管理员/)
  assert.equal(canvasAgentSaveError({ code: 'NETWORK_ERROR', message: '网络连接失败' }), '网络连接失败')
  assert.equal(canvasAgentSaveError(null), '保存 Canvas Agent 设置失败')
  assert.equal(canvasAgentSaveError({ message: '   ' }), '保存 Canvas Agent 设置失败')
})

test('refetch revision comparison treats older or equal cache as current', () => {
  const loaded = '2026-10-06T10:00:00.000Z'
  assert.equal(hasNewerCanvasAgentSettings(loaded, '2026-10-06T10:00:00.000Z'), false)
  assert.equal(hasNewerCanvasAgentSettings(loaded, '2026-10-06T09:00:00.000Z'), false)
  assert.equal(hasNewerCanvasAgentSettings(loaded, '2026-10-06T11:00:00.000Z'), true)
})
