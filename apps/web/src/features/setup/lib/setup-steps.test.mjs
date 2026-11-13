import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildCompletionChecklist,
  canCompleteSetup,
  incompleteChecklistLabels,
  isSetupClaimRequired,
  parseSetupStepId,
  resolveActiveStepIndex,
  resolveResumeIndex,
  resolveSetupSteps,
  setupIntroDescription,
  setupStepPosition,
} from './setup-steps.ts'

const sections = (done) => {
  const keys = ['bootstrap', 'site', 'smtp', 'admin', 'storage', 'providers', 'models', 'oauth', 'templates', 'runtime']
  return Object.fromEntries(keys.map((key) => [key, { status: done.includes(key) ? 'complete' : 'pending', updatedAt: '' }]))
}

const base = {
  hasAccess: false,
  claimRequired: true,
  setupComplete: false,
  sections: sections([]),
  bootstrapReady: false,
}

test('claim 步骤只在服务端要求领取码时出现', () => {
  assert.equal(isSetupClaimRequired(undefined), true)
  assert.equal(isSetupClaimRequired(true), true)
  assert.equal(isSetupClaimRequired(false), false)

  const required = resolveSetupSteps(base)
  assert.equal(required[0].id, 'claim')
  assert.equal(required.length, 9)

  const optional = resolveSetupSteps({ ...base, claimRequired: false })
  assert.equal(optional.some((step) => step.id === 'claim'), false)
  assert.equal(optional[0].id, 'bootstrap')
  assert.equal(optional.length, 8)
})

test('claim 完成来自「已获得初始化访问」而不是本地猜测', () => {
  const noAccess = resolveSetupSteps(base)
  assert.equal(noAccess[0].complete, false)
  assert.equal(resolveResumeIndex(noAccess), 0)

  const withAccess = resolveSetupSteps({ ...base, hasAccess: true })
  assert.equal(withAccess[0].complete, true)
  assert.equal(resolveResumeIndex(withAccess), 1)

  const optional = resolveSetupSteps({ ...base, claimRequired: false, hasAccess: true })
  assert.equal(optional[0].id, 'bootstrap')
})

test('各步骤完成度只读服务端 sections，bootstrap 另认 ready', () => {
  const steps = resolveSetupSteps({
    ...base,
    hasAccess: true,
    bootstrapReady: true,
    sections: sections(['site']),
  })
  const byId = Object.fromEntries(steps.map((step) => [step.id, step.complete]))
  assert.equal(byId.claim, true)
  assert.equal(byId.bootstrap, true)
  assert.equal(byId.site, true)
  assert.equal(byId.smtp, false)
  assert.equal(byId.admin, false)
  assert.equal(byId.storage, false)
  assert.equal(byId.runtime, false)
  assert.equal(byId.templates, false)
  assert.equal(byId.complete, false)
  // claim 已完成、bootstrap 已完成、site 已完成 → 恢复在 smtp
  assert.equal(resolveResumeIndex(steps), 3)
})

test('可选的模板步骤被跳过后算完成，但不影响完成门槛', () => {
  const skipped = resolveSetupSteps({ ...base, claimRequired: false, hasAccess: true, templatesSkipped: true })
  assert.equal(skipped.find((step) => step.id === 'templates')?.complete, true)

  const checklist = buildCompletionChecklist(sections(['bootstrap', 'site', 'smtp', 'admin', 'storage', 'runtime']))
  assert.deepEqual(checklist.map((item) => item.complete), [true, true, true, true, true, true])
  assert.equal(canCompleteSetup(checklist), true)

  const incomplete = buildCompletionChecklist(sections(['bootstrap', 'site']))
  assert.equal(canCompleteSetup(incomplete), false)
  assert.deepEqual(incompleteChecklistLabels(incomplete), [
    'SMTP 邮件（连接已验证）',
    '管理员账号',
    '对象存储（连接已验证）',
    '运行时限制',
  ])
})

test('深链解析：未知或不属于本部署的步骤回落到恢复位置', () => {
  const optional = resolveSetupSteps({ ...base, claimRequired: false, hasAccess: true, sections: sections(['bootstrap', 'site']) })
  assert.equal(resolveActiveStepIndex(optional, null), 2)
  assert.equal(resolveActiveStepIndex(optional, 'site'), 1)
  assert.equal(resolveActiveStepIndex(optional, 'claim'), 2)
  assert.equal(resolveActiveStepIndex(optional, 'storage'), 4)

  assert.equal(parseSetupStepId('smtp'), 'smtp')
  assert.equal(parseSetupStepId('claim'), 'claim')
  assert.equal(parseSetupStepId('unknown'), null)
  assert.equal(parseSetupStepId(null), null)
})

test('进度与说明文案按实际步骤列表计算', () => {
  assert.equal(setupStepPosition([0, 1, 2], 1), '第 2 / 3 步')
  assert.match(setupIntroDescription(true), /领取、环境诊断/)
  assert.match(setupIntroDescription(false), /^按顺序完成环境诊断/)
})
