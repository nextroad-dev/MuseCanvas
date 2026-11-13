import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activeOtpIndex,
  mergeOtpChunk,
  OTP_LENGTH,
  removeOtpDigit,
  sanitizeOtpChunk,
} from './otp.ts'

test('sanitizeOtpChunk 只留数字并截断到 6 位', () => {
  assert.equal(OTP_LENGTH, 6)
  assert.equal(sanitizeOtpChunk(' 48-1 2ab'), '4812')
  assert.equal(sanitizeOtpChunk('123456789'), '123456')
  assert.equal(sanitizeOtpChunk(''), '')
})

test('mergeOtpChunk 支持整串粘贴与格子内覆盖', () => {
  assert.equal(mergeOtpChunk('', '123456', 0), '123456')
  assert.equal(mergeOtpChunk('12', '3456', 2), '123456')
  assert.equal(mergeOtpChunk('123456', '9', 0), '923456')
  assert.equal(mergeOtpChunk('12345', '678', 4), '123467')
  assert.equal(mergeOtpChunk('123', '9', 5), '1239')
})

test('removeOtpDigit 删除指定格子并保持连续前缀', () => {
  assert.equal(removeOtpDigit('123456', 5), '12345')
  assert.equal(removeOtpDigit('123456', 2), '12456')
  assert.equal(removeOtpDigit('12', 5), '12')
  assert.equal(removeOtpDigit('123', -1), '123')
})

test('activeOtpIndex 指向第一个空位，输满停在最后一格', () => {
  assert.equal(activeOtpIndex(''), 0)
  assert.equal(activeOtpIndex('12'), 2)
  assert.equal(activeOtpIndex('123456'), OTP_LENGTH - 1)
})
