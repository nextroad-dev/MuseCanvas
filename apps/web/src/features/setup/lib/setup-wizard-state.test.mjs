import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  adminRequestErrorMessage,
  adminVerifyErrorMessage,
  canCompleteSetup,
  claimErrorMessage,
  databaseDriverCards,
  isSetupSessionError,
  isSetupStepDone,
  maskConnectionValue,
  parseSetupStepId,
  resendCooldownRemaining,
  resolveCompletionChecklist,
  resolveResumeIndex,
  resolveSetupSteps,
  SETUP_STEPS,
  stepDefinition,
} from './setup-wizard-state.ts'

const complete = { status: 'complete', updatedAt: '2026-01-01T00:00:00.000Z' }
const pending = { status: 'pending', updatedAt: '2026-01-01T00:00:00.000Z' }

function progress(overrides = {}) {
  return {
    claimed: false,
    setupComplete: false,
    sections: {},
    databaseReachable: false,
    ...overrides,
  }
}

test('step order is claim, site, SMTP, admin, database, storage, complete', () => {
  assert.deepEqual(SETUP_STEPS.map((step) => step.id), ['claim', 'site', 'smtp', 'admin', 'database', 'storage', 'complete'])
  for (const step of SETUP_STEPS) assert.ok(step.label.length <= 4, `${step.id} label fits a 360px stepper`)
  assert.equal(stepDefinition('smtp').title, 'SMTP 邮件')
})

test('a step is complete only from its stored fact; missing section data is unknown, not done', () => {
  const sections = { site: complete, smtp: pending }
  assert.equal(isSetupStepDone('site', progress({ sections })), true)
  assert.equal(isSetupStepDone('smtp', progress({ sections })), false)
  assert.equal(isSetupStepDone('admin', progress({ sections })), false, 'absent section is not complete')
  assert.equal(isSetupStepDone('site', progress({ sections: null })), false)
  assert.equal(isSetupStepDone('claim', progress({ claimed: true })), true)
  assert.equal(isSetupStepDone('database', progress({ databaseReachable: true })), true)
  assert.equal(isSetupStepDone('complete', progress({ setupComplete: true })), true)
})

test('resume lands on the first incomplete step, not the first step', () => {
  const steps = resolveSetupSteps(progress({
    claimed: true,
    sections: { site: complete, smtp: pending },
  }))
  assert.equal(resolveResumeIndex(steps), 2)
  assert.equal(steps[2].id, 'smtp')
  assert.equal(steps[0].complete, true)
  assert.equal(steps[1].complete, true)
})

test('unclaimed installs resume at the claim step even when stored sections look finished', () => {
  const sections = { site: complete, smtp: complete, admin: complete, storage: complete }
  const steps = resolveSetupSteps(progress({ claimed: false, sections, databaseReachable: true }))
  assert.equal(steps[0].id, 'claim')
  assert.equal(resolveResumeIndex(steps), 0)
})

test('resume stops at the database step when the server reports it unreachable', () => {
  const sections = { site: complete, smtp: complete, admin: complete }
  const steps = resolveSetupSteps(progress({ claimed: true, sections, databaseReachable: false }))
  assert.equal(steps[resolveResumeIndex(steps)].id, 'database')
})

test('when every step is complete, resume returns the last step; an empty list resolves to 0', () => {
  const steps = resolveSetupSteps(progress({
    claimed: true,
    setupComplete: true,
    sections: { site: complete, smtp: complete, admin: complete, storage: complete },
    databaseReachable: true,
  }))
  assert.equal(resolveResumeIndex(steps), steps.length - 1)
  assert.equal(resolveResumeIndex([]), 0)
})

test('step ids from the URL are accepted only when they name a real step', () => {
  assert.equal(parseSetupStepId('smtp'), 'smtp')
  assert.equal(parseSetupStepId('providers'), null, 'retired section step is not reachable')
  assert.equal(parseSetupStepId(''), null)
  assert.equal(parseSetupStepId(null), null)
})

test('claim errors map each server code to a specific instruction, never a generic failure for known cases', () => {
  for (const code of ['SETUP_SESSION_INVALID', 'SETUP_SESSION_EXPIRED', 'SETUP_SESSION_CONSUMED', 'UNAUTHORIZED']) {
    const message = claimErrorMessage(code)
    assert.match(message, /无效|过期|已被使用/, code)
    assert.match(message, /\[MUSECANVAS SETUP CLAIM\]/, `${code} points at the log line`)
    assert.match(message, /15 分钟/, `${code} states the validity window`)
  }
  assert.match(claimErrorMessage('RATE_LIMITED'), /10 分钟/)
  assert.match(claimErrorMessage('INVALID_INPUT'), /请输入领取码/)
  assert.match(claimErrorMessage('SETUP_ALREADY_COMPLETE'), /已完成初始化/)
  assert.match(claimErrorMessage('NETWORK_ERROR'), /网络/)
  assert.equal(claimErrorMessage('SOMETHING_NEW'), '领取失败，请稍后重试。')
  assert.equal(claimErrorMessage(undefined), '领取失败，请稍后重试。')
})

test('session-scoped codes are recognised so a later step can send the operator back to claim', () => {
  assert.equal(isSetupSessionError('SETUP_SESSION_INVALID'), true)
  assert.equal(isSetupSessionError('SETUP_SESSION_EXPIRED'), true)
  assert.equal(isSetupSessionError('RATE_LIMITED'), false)
  assert.equal(isSetupSessionError(undefined), false)
})

test('administrator OTP errors name the cause: SMTP delivery, rate limit, wrong or expired code', () => {
  assert.match(adminRequestErrorMessage('EMAIL_DELIVERY_FAILED'), /SMTP/)
  assert.match(adminRequestErrorMessage('RATE_LIMITED'), /过于频繁/)
  assert.match(adminRequestErrorMessage('SETUP_ALREADY_COMPLETE'), /已存在/)
  assert.match(adminVerifyErrorMessage('INVALID_OTP'), /错误或已过期/)
  assert.match(adminVerifyErrorMessage('RATE_LIMITED'), /尝试过多/)
  assert.match(adminVerifyErrorMessage('SETUP_SESSION_EXPIRED'), /重新领取/)
})

test('resend countdown is 60 seconds, whole-second granular, and never negative', () => {
  const sent = 1_000_000
  assert.equal(resendCooldownRemaining(null, sent), 0, 'nothing sent yet')
  assert.equal(resendCooldownRemaining(sent, sent), 60)
  assert.equal(resendCooldownRemaining(sent, sent + 1_000), 59)
  assert.equal(resendCooldownRemaining(sent, sent + 59_999), 1)
  assert.equal(resendCooldownRemaining(sent, sent + 60_000), 0)
  assert.equal(resendCooldownRemaining(sent, sent + 600_000), 0)
})

test('database driver cards follow the server list: availability and reason come from the DTO only', () => {
  const status = {
    driver: 'postgres',
    availableDrivers: [
      { id: 'postgres', label: 'PostgreSQL', available: true },
      { id: 'sqlite', label: 'SQLite', available: false, reason: '后端尚未支持' },
    ],
  }
  const cards = databaseDriverCards(status)
  assert.deepEqual(cards, [
    { id: 'postgres', label: 'PostgreSQL', selected: true, enabled: true, reason: null },
    { id: 'sqlite', label: 'SQLite', selected: false, enabled: false, reason: '后端尚未支持' },
  ])
})

test('a disabled driver without a server reason still explains itself, and an available one never carries a reason', () => {
  const cards = databaseDriverCards({
    driver: 'postgres',
    availableDrivers: [
      { id: 'postgres', label: 'PostgreSQL', available: true, reason: '应被忽略' },
      { id: 'sqlite', label: 'SQLite', available: false, reason: '   ' },
    ],
  })
  assert.equal(cards[0].reason, null)
  assert.equal(cards[1].reason, '当前版本暂不支持此驱动')
  assert.deepEqual(databaseDriverCards(undefined), [])
  assert.deepEqual(databaseDriverCards(null), [])
})

test('connection values are masked; the port and database name are not part of this mask', () => {
  assert.equal(maskConnectionValue(null), '未提供')
  assert.equal(maskConnectionValue(''), '未提供')
  assert.equal(maskConnectionValue('db'), 'd•••')
  assert.equal(maskConnectionValue('db.internal.example'), 'db•••le')
  assert.doesNotMatch(maskConnectionValue('museadmin'), /museadmin/)
})

test('completion checklist mirrors the server gate: every required section must be complete', () => {
  const all = { bootstrap: complete, site: complete, smtp: complete, admin: complete, storage: complete, runtime: complete }
  const items = resolveCompletionChecklist(all)
  assert.equal(items.length, 6)
  assert.equal(canCompleteSetup(items), true)
  assert.equal(canCompleteSetup(resolveCompletionChecklist({ ...all, runtime: pending })), false)
  assert.equal(canCompleteSetup(resolveCompletionChecklist({ ...all, bootstrap: undefined })), false, 'missing bootstrap is not done')
  assert.equal(canCompleteSetup(resolveCompletionChecklist(undefined)), false)
  assert.equal(canCompleteSetup([]), false, 'an empty checklist never allows completion')
})
