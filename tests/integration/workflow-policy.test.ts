import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

// These guards inspect sources only: never build images, run maintenance, or
// connect to services just to verify packaging and CI trigger policy.
test('worker image includes maintenance script sources before assigning runtime ownership', () => {
  const dockerfile = source('deploy/docker/worker.Dockerfile')
  const copy = /^COPY scripts scripts\s*$/m.exec(dockerfile)
  assert.ok(copy, 'worker must package the scripts directory')
  const chown = dockerfile.indexOf('chown -R app:app /app')
  const runtimeUser = dockerfile.indexOf('USER app')
  assert.ok(chown > copy.index, 'script sources must be copied before /app ownership is assigned')
  assert.ok(runtimeUser > chown, 'ownership must be assigned before switching to the runtime user')

  for (const name of ['backfill-asset-thumbnails.ts', 'reencrypt-provider-credentials.ts', 'prune-outbox.ts']) {
    assert.ok(
      statSync(new URL(`../../scripts/${name}`, import.meta.url)).isFile(),
      `packaged maintenance source scripts/${name} must exist`,
    )
  }
})

const workflows = [
  { name: 'docker-image', events: ['push', 'pull_request'] },
  { name: 'media-quality', events: ['push', 'pull_request'] },
  { name: 'backend-reliability', events: ['pull_request'] },
]

for (const { name, events } of workflows) {
  for (const event of events) {
    test(`${name} ${event} covers changes to packaged or tested scripts`, () => {
      const workflow = source(`.github/workflows/${name}.yml`)
      // Isolate the event stanza so coverage on push cannot hide a missing PR
      // filter (and vice versa). Accept both block and inline path sequences.
      const stanza = new RegExp(`^  ${event}:\\r?\\n([\\s\\S]*?)(?=^  \\S|^\\S|$(?![\\s\\S]))`, 'm').exec(workflow)?.[1]
      assert.ok(stanza, `${name} must declare ${event}`)
      const paths = /^    paths:\s*(\[[^\r\n]*\]|\r?\n(?:[ \t]+-[^\r\n]*\r?\n?)*)/m.exec(stanza)?.[1]
      assert.ok(paths, `${name} ${event} must have a paths filter`)
      assert.match(paths, /['"]scripts\/\*\*['"]/, `${name} ${event} must cover scripts/**`)
    })
  }
}
