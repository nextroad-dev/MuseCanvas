import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeSetupError, isSetupSessionError, SESSION_LOST_MESSAGE } from './setup-errors.ts'

test('会话类错误统一给出重新领取的提示', () => {
  assert.equal(isSetupSessionError({ code: 'SETUP_SESSION_INVALID', status: 401 }), true)
  assert.equal(isSetupSessionError({ code: 'SETUP_SESSION_EXPIRED' }), true)
  assert.equal(isSetupSessionError({ status: 401 }), true)
  assert.equal(isSetupSessionError({ code: 'INVALID_OTP', status: 400 }), false)
  // setup/admin/verify 的验证码错误也是 401，但不是会话失效。
  assert.equal(isSetupSessionError({ code: 'INVALID_OTP', status: 401 }), false)
  assert.equal(isSetupSessionError(new Error('boom')), false)

  assert.equal(describeSetupError({ code: 'SETUP_SESSION_CONSUMED' }, '兜底'), SESSION_LOST_MESSAGE)
})

test('SetupErrorCode 全部翻成中文可执行文案', () => {
  assert.match(describeSetupError({ code: 'SETUP_ALREADY_COMPLETE', status: 409 }, '兜底'), /已完成初始化/)
  assert.match(describeSetupError({ code: 'SETUP_INCOMPLETE', status: 409 }, '兜底'), /必填步骤/)
  assert.match(describeSetupError({ code: 'EMAIL_DELIVERY_FAILED', status: 503 }, '兜底'), /SMTP 连接/)
  assert.match(describeSetupError({ code: 'PUBLIC_ORIGIN_INVALID' }, '兜底'), /HTTPS/)
  assert.match(describeSetupError({ code: 'SMTP_TEST_FAILED' }, '兜底'), /SMTP 连接验证未通过/)
  assert.match(describeSetupError({ code: 'STORAGE_TEST_FAILED' }, '兜底'), /对象存储连接验证未通过/)
  assert.match(describeSetupError({ code: 'STORAGE_SECRET_REENTER_REQUIRED' }, '兜底'), /重新输入访问密钥/)
  assert.match(describeSetupError({ code: 'DATABASE_UNREACHABLE' }, '兜底'), /DATABASE_URL/)
  assert.match(describeSetupError({ code: 'RATE_LIMITED' }, '兜底'), /频繁/)
  assert.match(describeSetupError({ code: 'INVALID_OTP', status: 401 }, '兜底'), /验证码错误或已过期/)
})

test('未命中错误码时按状态兜底；普通 JS 异常不展示英文原文', () => {
  assert.match(describeSetupError({ status: 429 }, '兜底'), /频繁/)
  assert.match(describeSetupError({ status: 0 }, '兜底'), /无法连接服务/)
  assert.equal(describeSetupError({ code: 'HTTP_500', message: '上游炸了' }, '兜底'), '上游炸了')
  assert.equal(describeSetupError(new Error('Failed to fetch'), '兜底文案'), '兜底文案')
  assert.equal(describeSetupError(null, '兜底文案'), '兜底文案')
})

test('INVALID_INPUT 优先展示后端的具体字段说明', () => {
  assert.equal(
    describeSetupError({ code: 'INVALID_INPUT', message: '对象存储服务端点不能指向内网或回环地址' }, '兜底'),
    '对象存储服务端点不能指向内网或回环地址',
  )
  assert.match(describeSetupError({ code: 'INVALID_INPUT' }, '兜底'), /填写内容不符合要求/)
})
