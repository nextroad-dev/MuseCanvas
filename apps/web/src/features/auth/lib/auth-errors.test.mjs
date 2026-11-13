import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeAuthError,
  describeOAuthError,
  formatCountdown,
  normalizeEmail,
  validateEmail,
} from './auth-errors.ts'

test('describeAuthError 命中后端错误码时给可执行文案', () => {
  assert.match(describeAuthError({ code: 'RATE_LIMITED', status: 429 }, '兜底'), /10 分钟/)
  assert.match(describeAuthError({ code: 'INVALID_OTP', status: 401 }, '兜底'), /验证码错误或已过期/)
  assert.match(describeAuthError({ code: 'EMAIL_DELIVERY_FAILED', status: 503 }, '兜底'), /邮件服务/)
  assert.match(describeAuthError({ code: 'INVALID_INVITATION', status: 400 }, '兜底'), /邀请码无效/)
})

test('describeAuthError 未命中错误码时按状态兜底，再退回 message / fallback', () => {
  assert.match(describeAuthError({ code: 'WHATEVER', status: 429 }, '兜底'), /10 分钟/)
  assert.match(describeAuthError({ status: 0 }, '兜底'), /网络连接失败/)
  assert.equal(describeAuthError({ code: 'HTTP_500', message: '上游炸了' }, '兜底'), '上游炸了')
  assert.equal(describeAuthError(new Error('boom'), '兜底文案'), '兜底文案')
  assert.equal(describeAuthError(null, '兜底文案'), '兜底文案')
})

test('describeOAuthError 只映射回调 query 里的错误码', () => {
  assert.equal(describeOAuthError(null), null)
  assert.equal(describeOAuthError(''), null)
  assert.match(describeOAuthError('OAUTH_EMAIL_MISMATCH') ?? '', /邮箱与当前登录邮箱不一致/)
  assert.match(describeOAuthError('OAUTH_DENIED') ?? '', /取消/)
  assert.match(describeOAuthError('OAUTH_SOMETHING_NEW') ?? '', /第三方登录未完成/)
})

test('normalizeEmail / validateEmail 只做形状校验', () => {
  assert.equal(normalizeEmail('  forrest@example.com  '), 'forrest@example.com')
  assert.equal(validateEmail('  '), '请填写用于接收验证码的邮箱地址。')
  assert.match(validateEmail('forrest@example') ?? '', /邮箱格式不正确/)
  assert.equal(validateEmail(' forrest@example.com '), null)
})

test('formatCountdown 输出 MM:SS 并夹住负数', () => {
  assert.equal(formatCountdown(0), '00:00')
  assert.equal(formatCountdown(42), '00:42')
  assert.equal(formatCountdown(60), '01:00')
  assert.equal(formatCountdown(75.9), '01:15')
  assert.equal(formatCountdown(-3), '00:00')
})
