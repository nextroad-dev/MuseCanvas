import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

test('useAnimatedPresence: 退场阶段必须依赖 animationend 与 exitBackstopMs 双保险卸载', () => {
  const source = fs.readFileSync(path.join(HERE, 'useAnimatedPresence.ts'), 'utf8')
  assert.match(source, /exitBackstopMs\(/)
  assert.match(source, /event\.target !== event\.currentTarget/)
  assert.match(source, /mc-panel-out/)
  assert.match(source, /mc-slide-out-left/)
})
