import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('./showcase-frame.tsx', import.meta.url), 'utf8')

test('showcase frame renders via StaticImage without next/image', () => {
  assert.doesNotMatch(source, /from\s+['"]next\/image['"]/)
  assert.doesNotMatch(source, /next\/image/)
  assert.match(source, /import\s+\{\s*StaticImage\s*\}\s+from\s+'@\/shared\/components\/static-image'/)
  assert.match(source, /<StaticImage\b/)
})

test('showcase images keep below-the-fold work at low fetch priority and lazy loading', () => {
  assert.match(source, /priority = false/)
  assert.match(source, /loading=\{priority \? 'eager' : 'lazy'\}/)
  assert.match(source, /fetchPriority=\{priority \? 'high' : 'low'\}/)
})
