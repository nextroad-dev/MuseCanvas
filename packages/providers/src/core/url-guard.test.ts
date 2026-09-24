import test from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateProviderHost, urlHostOf } from './index'

test('isPrivateProviderHost covers loopback, link-local and RFC1918 ranges', () => {
  for (const host of ['localhost', 'LOCALHOST', '0.0.0.0', '::1', '127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.1.1', '172.16.0.1', '172.31.255.254']) {
    assert.equal(isPrivateProviderHost(host), true, host)
  }
  for (const host of ['api.openai.com', '172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.1.1']) {
    assert.equal(isPrivateProviderHost(host), false, host)
  }
})

test('urlHostOf returns the hostname or null without throwing', () => {
  assert.equal(urlHostOf('https://api.openai.com/v1/chat/completions'), 'api.openai.com')
  assert.equal(urlHostOf('http://127.0.0.1:3000/x'), '127.0.0.1')
  assert.equal(urlHostOf('not-a-url'), null)
  assert.equal(urlHostOf(''), null)
  assert.equal(urlHostOf('ark.cn-beijing.volces.com'), null)
})
