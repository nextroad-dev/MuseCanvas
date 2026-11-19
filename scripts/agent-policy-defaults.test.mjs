import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Structural checks only: no Compose interpolation, credentials or running services.
for (const file of ['compose.yaml', 'compose.dev.yaml', 'compose.prod.yaml', 'compose.images.yaml']) {
  test(`${file} shares opt-in Agent admission and retention defaults with API and Worker`, () => {
    const source = readFileSync(new URL(`../deploy/${file}`, import.meta.url), 'utf8')
    const backend = source.match(/^    environment: &backend-env\r?\n([\s\S]*?)(?=^    \S|^  \S)/m)?.[1]
    assert.ok(backend, 'shared backend environment must exist')
    const defaults = {
      AGENT_CORE_ENABLED: 'false', AGENT_CORE_ADMISSION_READY: 'false',
      AGENT_ADMISSION_PERCENT: '0', AGENT_ADMISSION_ACTORS: '',
      AGENT_STREAM_RETENTION_ENABLED: 'false', AGENT_STREAM_RETENTION_SECONDS: '0', AGENT_STREAM_TRIM_BATCH_SIZE: '0',
    }
    for (const [key, value] of Object.entries(defaults)) {
      const definition = `      ${key}: \${${key}:-${value}}`
      assert.ok(backend.split(/\r?\n/).includes(definition), `${key} must default to ${JSON.stringify(value)}`)
      assert.equal([...source.matchAll(new RegExp(`^\\s+${key}:`, 'gm'))].length, 1, `${key} must have a single shared definition`)
    }
    const worker = source.match(/^  worker:\r?\n([\s\S]*?)(?=^  \S|$(?![\s\S]))/m)?.[1]
    assert.match(worker ?? '', /^    environment: \*backend-env\s*$/m)
  })
}
