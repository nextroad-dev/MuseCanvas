import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeAccountCallback } from './account-callback.ts'

test('没有回跳参数时不提示', () => {
  assert.equal(describeAccountCallback({}), null)
  assert.equal(describeAccountCallback({ linked: null, error: null }), null)
})

test('绑定成功给 success 提示', () => {
  assert.deepEqual(describeAccountCallback({ linked: '1' }), {
    tone: 'success',
    title: '已绑定第三方账号，下次可直接用它登录。',
  })
})

test('已知错误码翻译成可执行文案，未知错误码有兜底', () => {
  assert.match(describeAccountCallback({ error: 'OAUTH_EMAIL_MISMATCH' })?.title ?? '', /邮箱与当前登录邮箱不一致/)
  assert.match(describeAccountCallback({ error: 'OAUTH_DENIED' })?.title ?? '', /取消/)
  assert.match(describeAccountCallback({ error: 'OAUTH_UNKNOWN' })?.title ?? '', /未完成/)
})
