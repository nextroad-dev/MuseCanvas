import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTs } from '../services/mock-workspace-test-loader.mjs'

test('workspace mock is exact build-time opt-in and always disabled in production', () => {
  for (const env of ['production', 'development', 'test']) {
    for (const flag of [undefined, 'false', 'TRUE', '1', 'true']) {
      const { WORKSPACE_MODE } = loadTs(new URL('./workspace-mode.ts', import.meta.url), {}, {
        process: { env: { NODE_ENV: env, NEXT_PUBLIC_WORKSPACE_MOCK: flag } },
      })
      assert.equal(WORKSPACE_MODE, env !== 'production' && flag === 'true' ? 'mock' : 'live')
    }
  }
})
