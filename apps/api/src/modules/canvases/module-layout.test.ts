import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import test from 'node:test'
import * as agent from './agent'

// Protect module ownership without preventing additional Agent files later.
test('canvases owns CRUD and the complete Agent module, without a separate legacy module', async () => {
  const required = [
    'canvas-agent.test.ts', 'config.ts', 'handlers.ts', 'history.ts', 'index.ts',
    'loop.ts', 'normalization.test.ts', 'normalization.ts', 'persistence.test.ts',
    'sse.ts', 'store.test.ts', 'store.ts', 'submit.ts', 'tools.ts',
  ]
  await Promise.all(required.map(name => access(new URL(`./agent/${name}`, import.meta.url))))
  await access(new URL('./handlers.ts', import.meta.url))
  await access(new URL('./handlers.test.ts', import.meta.url))
  await assert.rejects(access(new URL('../canvas-agent', import.meta.url)), { code: 'ENOENT' })
  for (const name of [
    'postCanvasAgentMessages', 'getCanvasAgentHistory', 'getCanvasAgentTurn',
    'postCanvasAgentConfirm', 'postCanvasAgentApply', 'getCanvasAgentStatus',
  ] as const) {
    assert.equal(typeof agent[name], 'function', `${name} remains exported`)
  }
})
