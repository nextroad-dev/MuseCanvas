import assert from 'node:assert/strict'
import test from 'node:test'
import { focusAdminRecordDialogMode, restoreAdminRecordListFocus } from './admin-record-dialog-focus.ts'

function target(name, calls, isConnected = true) {
  return { isConnected, focus: (options) => calls.push({ name, options }) }
}

test('detail/confirmation content switch focuses cancel, then the retained detail control', () => {
  const calls = []
  const cancel = target('cancel', calls)
  const detailButton = target('detail-delete', calls)
  const panel = target('detail-panel', calls)
  focusAdminRecordDialogMode(true, cancel, detailButton, panel)
  focusAdminRecordDialogMode(false, cancel, detailButton, panel)
  assert.deepEqual(calls, [
    { name: 'cancel', options: { preventScroll: true } },
    { name: 'detail-delete', options: { preventScroll: true } },
  ])
})

test('returning to details uses the detail panel when the old control no longer exists', () => {
  const calls = []
  focusAdminRecordDialogMode(false, null, target('old-control', calls, false), target('detail-panel', calls))
  assert.deepEqual(calls, [{ name: 'detail-panel', options: { preventScroll: true } }])
})

test('list fallback leaves a restored trigger alone and safely handles a removed trigger', () => {
  const calls = []
  const trigger = target('trigger', calls)
  const list = target('list', calls)
  restoreAdminRecordListFocus(trigger, list, true)
  assert.deepEqual(calls, [])
  trigger.isConnected = false
  restoreAdminRecordListFocus(trigger, list, false)
  assert.deepEqual(calls, [{ name: 'list', options: { preventScroll: true } }])
  list.isConnected = false
  restoreAdminRecordListFocus(trigger, list, false)
  restoreAdminRecordListFocus(trigger, null, false)
  assert.equal(calls.length, 1)
})

test('connected but no longer focusable trigger also falls back to its stable list', () => {
  const calls = []
  restoreAdminRecordListFocus(target('hidden-trigger', calls), target('list', calls), false)
  assert.deepEqual(calls, [{ name: 'list', options: { preventScroll: true } }])
})
