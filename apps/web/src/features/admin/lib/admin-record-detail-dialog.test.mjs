import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

function source(name) {
  const text = readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), 'utf8')
  return ts.createSourceFile(`${name}.tsx`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}
function matching(root, predicate) {
  const results = []
  function visit(node) {
    if (predicate(node)) results.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return results
}
function tags(root, name) {
  return matching(root, (node) => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === name)
}
function attribute(node, name) {
  return node.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText() === name)
}
function calls(root, name) {
  return matching(root, (node) => ts.isCallExpression(node) && node.expression.getText() === name)
}
function clears(root, setter) {
  return calls(root, setter).some((call) => call.arguments[0]?.kind === ts.SyntaxKind.NullKeyword)
}

// Structural regression evidence, not a simulated browser/React runtime harness.
const flows = [
  ['admin-media-models-view', 'currentDetailModel', 'setDetailModel'],
  ['admin-language-models-view', 'currentDetailModel', 'setDetailModel'],
  ['admin-credential-table', 'currentDetailCredential', 'setDetailCredential'],
  ['admin-installed-plugins', 'currentDetailPlugin', 'setDetailPlugin'],
  ['admin-prompt-templates-view', 'detailTemplate', 'setDetailTemplate'],
]
for (const [name, detail, setter] of flows) {
  test(`${name}: one persistent detail/confirmation owner, back without closing, success closes its session`, () => {
    const root = source(name)
    const owners = tags(root, 'AdminRecordDetailDialog')
    assert.equal(owners.length, 1)
    assert.equal(tags(root, 'AdminConfirmDialog').length, 0)
    const owner = owners[0]
    assert.equal(attribute(owner, 'key'), undefined)
    assert.equal(attribute(owner, 'open').initializer.expression.getText(), `${detail} !== null || deleteTarget !== null`)
    assert.equal(attribute(owner, 'listFocusRef').initializer.expression.getText(), 'recordListRef')
    assert.ok(matching(root, (node) => ts.isJsxAttribute(node) && node.name.getText() === 'ref' && node.initializer?.expression?.getText() === 'recordListRef').length)
    const request = matching(root, (node) => ts.isFunctionDeclaration(node) && node.name?.getText().startsWith('requestDelete'))[0]
    assert.ok(request)
    assert.equal(clears(request, setter), false, 'entering confirmation must not close the detail mode')
    const confirmation = attribute(owner, 'confirmation').initializer.expression.whenTrue
    const props = Object.fromEntries(confirmation.properties.map((prop) => [prop.name.getText(), prop.initializer]))
    assert.ok(props.pending && props.error)
    assert.equal(props.cancelLabel.getText(), `${detail} ? '返回详情' : '取消'`)
    assert.equal(clears(props.onCancel, 'setDeleteTarget'), true)
    assert.equal(clears(props.onCancel, setter), false)
    for (const stateSetter of ['setDeleteTarget', setter]) {
      const updates = calls(props.onConfirm, stateSetter)
      assert.equal(updates.length, 1)
      assert.equal(updates[0].arguments[0].body.getText(), 'current?.id === target.id ? null : current', 'completion must not close another record session')
    }
    assert.equal(calls(props.onConfirm, 'actions.run')[0].arguments.at(-1).text, 'delete')
  })
}

test('admin-record-detail-dialog: both modes share exactly one unkeyed Dialog and retained hidden details', () => {
  const root = source('admin-record-detail-dialog')
  const owners = tags(root, 'Dialog')
  assert.equal(owners.length, 1)
  assert.equal(attribute(owners[0], 'key'), undefined)
  assert.equal(tags(source('admin-confirm-dialog'), 'Dialog').length, 0)
  const details = tags(root, 'div').find((node) => attribute(node, 'hidden'))
  assert.equal(attribute(details, 'hidden').initializer.expression.getText(), 'confirming')
  assert.match(attribute(details, 'className').initializer.expression.getText(), /confirming \? 'hidden'/)
  assert.equal(tags(root, 'AdminRecordDialogContent').length, 1)
  assert.equal(calls(root, 'setTimeout').length, 0)
  assert.equal(calls(root, 'queueMicrotask').length, 1)
})

for (const name of [...flows.slice(0, 4).map(([name]) => name), 'admin-oauth-view']) {
  test(`${name}: Switch delegates own pending to its internal guard instead of native disable`, () => {
    const root = source(name)
    const switches = tags(root, 'Switch')
    assert.ok(switches.length)
    for (const control of switches) {
      const disabled = attribute(control, 'disabled').initializer.expression
      assert.equal(disabled.expression.getText(), 'actions.isToggleBlocked')
    }
    assert.ok(calls(root, 'actions.run').some((call) => call.arguments.at(-1)?.text === 'toggle'))
    if (name === 'admin-credential-table') {
      assert.ok(calls(root, 'actions.run').some((call) => call.arguments.at(-1)?.text === 'test'))
    }
  })
}
