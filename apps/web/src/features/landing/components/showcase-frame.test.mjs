import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('./showcase-frame.tsx', import.meta.url), 'utf8')

test('showcase images keep below-the-fold work at low fetch priority', () => {
  assert.match(source, /priority = false/)
  assert.match(source, /fetchPriority=\{priority \? 'high' : 'low'\}/)
  assert.match(source, /priority=\{priority\}/)
})
