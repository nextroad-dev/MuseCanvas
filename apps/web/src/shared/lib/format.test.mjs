import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatBytes,
  formatCount,
  formatDate,
  formatDateTime,
  formatElapsed,
  formatRelativeTime,
  truncateText,
} from './format.ts'

test('formatDate / formatDateTime 使用设计系统的固定格式', () => {
  const value = new Date(2026, 9, 22, 9, 41, 3)
  assert.equal(formatDate(value), '2026-10-22')
  assert.equal(formatDateTime(value), '2026-10-22 09:41')
  assert.equal(formatDate('2026-01-05T00:00:00'), '2026-01-05')
})

test('缺失值显示占位、无法解析的输入原样返回', () => {
  assert.equal(formatDate(null), '—')
  assert.equal(formatDateTime(undefined), '—')
  assert.equal(formatDate('not-a-date'), 'not-a-date')
})

test('formatRelativeTime 覆盖刚刚/分钟/今天/昨天/月日/年月日', () => {
  const now = new Date(2026, 9, 22, 12, 0, 0).getTime()
  assert.equal(formatRelativeTime(new Date(now - 30_000), now), '刚刚')
  assert.equal(formatRelativeTime(new Date(now - 5 * 60_000), now), '5 分钟前')
  assert.equal(formatRelativeTime(new Date(2026, 9, 22, 9, 41), now), '今天 09:41')
  assert.equal(formatRelativeTime(new Date(2026, 9, 21, 18, 5), now), '昨天 18:05')
  assert.equal(formatRelativeTime(new Date(2026, 2, 5, 8, 0), now), '3 月 5 日')
  assert.equal(formatRelativeTime(new Date(2024, 11, 31, 8, 0), now), '2024 年 12 月 31 日')
  assert.equal(formatRelativeTime(null, now), '—')
})

test('formatCount 使用千分位与万/亿缩写', () => {
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(1234), '1,234')
  assert.equal(formatCount(12_000), '1.2 万')
  assert.equal(formatCount(100_000_000), '1 亿')
  assert.equal(formatCount(null), '—')
})

test('formatBytes 使用十进制单位', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(1500), '1.5 KB')
  assert.equal(formatBytes(15_000), '15 KB')
  assert.equal(formatBytes(10_000_000), '10 MB')
  assert.equal(formatBytes(1_500_000_000), '1.5 GB')
  assert.equal(formatBytes(-1), '—')
})

test('formatElapsed 输出 MM:SS 并处理缺失开始时间', () => {
  const now = Date.parse('2026-10-22T10:00:00Z')
  assert.equal(formatElapsed({ startedAt: '2026-10-22T09:58:30Z' }, now), '01:30')
  assert.equal(formatElapsed({ startedAt: null, createdAt: null }, now), '00:00')
})

test('truncateText 超长截断并追加省略号', () => {
  assert.equal(truncateText('abc', 5), 'abc')
  assert.equal(truncateText('abcdef', 3), 'abc…')
  assert.equal(truncateText(null), '')
})
