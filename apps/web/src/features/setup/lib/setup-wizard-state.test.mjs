import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  adminRequestErrorMessage,
  adminVerifyErrorMessage,
  canCompleteSetup,
  claimErrorMessage,
  claimFailureOutcome,
  databaseDriverCards,
  isSetupClaimRequired,
  isSetupSessionError,
  isSetupStepDone,
  maskConnectionValue,
  OPEN_SETUP_NOTICE,
  parseSetupStepId,
  resendCooldownRemaining,
  resolveActiveStepIndex,
  resolveCompletionChecklist,
  resolveResumeIndex,
  resolveSetupSteps,
  setupIntroDescription,
  setupStepDefinitions,
  setupStepPosition,
  SETUP_STEPS,
  shouldShowOpenSetupNotice,
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

test('step list: undefined and true keep the claim step first; false starts at site with six steps', () => {
  const ids = (claimRequired) => setupStepDefinitions(claimRequired).map((step) => step.id)
  assert.deepEqual(ids(undefined), ['claim', 'site', 'smtp', 'admin', 'database', 'storage', 'complete'], 'absent means required')
  assert.deepEqual(ids(true), ids(undefined))
  assert.deepEqual(ids(false), ['site', 'smtp', 'admin', 'database', 'storage', 'complete'])
  assert.equal(isSetupClaimRequired(undefined), true)
  assert.equal(isSetupClaimRequired(null), true, 'a null from a sloppy payload is not an opt-out')
  assert.equal(isSetupClaimRequired(false), false)
})

test('resolved steps follow the claim mode; without a required claim the claim step is neither listed nor pending', () => {
  const open = resolveSetupSteps(progress({ claimRequired: false, claimed: false }))
  assert.equal(open.length, 6)
  assert.equal(open.some((step) => step.id === 'claim'), false)
  assert.equal(open[0].id, 'site')
  assert.equal(isSetupStepDone('claim', progress({ claimRequired: false, claimed: false })), true, 'satisfied without a claim')
  assert.equal(isSetupStepDone('claim', progress({ claimRequired: true, claimed: false })), false)
  assert.equal(isSetupStepDone('claim', progress({ claimRequired: undefined, claimed: true })), true)
})

test('resume without a required claim starts at site and lands on the first incomplete step after it', () => {
  const sections = { site: complete }
  const steps = resolveSetupSteps(progress({ claimRequired: false, claimed: false, sections }))
  assert.equal(steps[resolveResumeIndex(steps)].id, 'smtp')
  const fresh = resolveSetupSteps(progress({ claimRequired: false }))
  assert.equal(resolveResumeIndex(fresh), 0, 'a fresh open install starts at site')
})

test('resume in required mode is unchanged: the claim step is first until the session is claimed', () => {
  const stored = { site: complete, smtp: complete, admin: complete, storage: complete }
  const unclaimed = resolveSetupSteps(progress({ claimRequired: true, claimed: false, sections: stored, databaseReachable: true }))
  assert.equal(unclaimed[resolveResumeIndex(unclaimed)].id, 'claim')
  const claimed = resolveSetupSteps(progress({ claimRequired: true, claimed: true, sections: stored, databaseReachable: true }))
  assert.equal(claimed[resolveResumeIndex(claimed)].id, 'complete')
})

test('every step in every mode resumes at itself when it is the first incomplete one', () => {
  const sections = {}
  for (const claimRequired of [undefined, false]) {
    const base = setupStepDefinitions(claimRequired)
    const steps = resolveSetupSteps(progress({ claimRequired, claimed: false, sections, databaseReachable: false }))
    assert.equal(steps.length, base.length)
    assert.equal(steps[resolveResumeIndex(steps)].id, steps[0].id)
  }
  // Walk each mode step by step: completing every earlier step must resume at the next one.
  const walk = [
    ['smtp', { site: complete }],
    ['admin', { site: complete, smtp: complete }],
    ['database', { site: complete, smtp: complete, admin: complete }],
    ['storage', { site: complete, smtp: complete, admin: complete }],
  ]
  for (const [expected, stored] of walk) {
    const steps = resolveSetupSteps(progress({ claimRequired: false, claimed: false, sections: stored, databaseReachable: expected !== 'database' }))
    assert.equal(steps[resolveResumeIndex(steps)].id, expected, expected)
  }
})

test('a deep link to claim while no claim is required falls back to the first incomplete step', () => {
  const steps = resolveSetupSteps(progress({ claimRequired: false, claimed: false, sections: { site: complete } }))
  const resume = resolveResumeIndex(steps)
  assert.equal(resolveActiveStepIndex(steps, 'claim'), resume)
  assert.equal(steps[resolveActiveStepIndex(steps, 'claim')].id, 'smtp', 'not site, which is merely the first step')
})

test('deep links name a step that is in the resolved list; null resumes; unknown ids cannot reach a missing step', () => {
  const open = resolveSetupSteps(progress({ claimRequired: false, claimed: false }))
  assert.equal(resolveActiveStepIndex(open, 'admin'), 2)
  assert.equal(resolveActiveStepIndex(open, null), resolveResumeIndex(open))
  const required = resolveSetupSteps(progress({ claimRequired: true, claimed: false }))
  assert.equal(resolveActiveStepIndex(required, 'claim'), 0)
  assert.equal(resolveActiveStepIndex(required, 'site'), 1)
})

test('numbering and progress copy count the resolved list, never a fixed seven', () => {
  assert.equal(setupStepPosition(setupStepDefinitions(false), 0), '第 1 / 6 步')
  assert.equal(setupStepPosition(setupStepDefinitions(false), 5), '第 6 / 6 步')
  assert.equal(setupStepPosition(setupStepDefinitions(true), 0), '第 1 / 7 步')
  assert.equal(setupStepPosition(setupStepDefinitions(undefined), 6), '第 7 / 7 步')
})

test('the open-setup notice shows only on the first visible step and only when no claim is required', () => {
  assert.equal(shouldShowOpenSetupNotice(false, 0), true)
  assert.equal(shouldShowOpenSetupNotice(false, 1), false)
  assert.equal(shouldShowOpenSetupNotice(true, 0), false)
  assert.equal(shouldShowOpenSetupNotice(undefined, 0), false, 'absent means required')
  assert.match(OPEN_SETUP_NOTICE, /任何能访问此地址的人/)
  assert.match(OPEN_SETUP_NOTICE, /仅对管理员开放/)
})

test('intro copy names only the steps this server shows', () => {
  assert.match(setupIntroDescription(true), /^按顺序完成领取、站点、/)
  assert.match(setupIntroDescription(undefined), /领取/)
  assert.doesNotMatch(setupIntroDescription(false), /领取/)
  assert.match(setupIntroDescription(false), /^按顺序完成站点、邮件、管理员/)
})

test('the claim step never appears in the completion checklist, in either mode', () => {
  const sections = { bootstrap: complete, site: complete, smtp: complete, admin: complete, storage: complete, runtime: complete }
  assert.equal(resolveCompletionChecklist(sections).some((item) => item.key === 'claim'), false)
  assert.equal(canCompleteSetup(resolveCompletionChecklist(sections)), true, 'the gate is the same without a claim')
})

test('SETUP_CLAIM_NOT_REQUIRED from the claim endpoint refetches status and shows no error', () => {
  assert.deepEqual(claimFailureOutcome('SETUP_CLAIM_NOT_REQUIRED'), { kind: 'refetch-status' })
  for (const code of ['SETUP_SESSION_INVALID', 'INVALID_INPUT', 'RATE_LIMITED', undefined]) {
    const outcome = claimFailureOutcome(code)
    assert.equal(outcome.kind, 'message', String(code))
    assert.equal(outcome.message, claimErrorMessage(code))
  }
})
