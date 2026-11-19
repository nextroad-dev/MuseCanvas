import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { checkDockerWorkspaceManifests, repositoryManifests } from './check-docker-workspace-manifests.mjs'

const manifests = new Map([
  ['package.json', { name: 'root' }],
  ['apps/a/package.json', { name: 'a', dependencies: { b: 'workspace:*' } }],
  ['packages/b/package.json', { name: 'b', dependencies: { c: 'workspace:*' } }],
  ['packages/c/package.json', { name: 'c' }],
])
const dockerfile = `FROM node AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/a/package.json apps/a/package.json
COPY packages/b/package.json packages/b/package.json
COPY packages/c/package.json packages/c/package.json
RUN pnpm install --frozen-lockfile
FROM node AS runner
COPY --from=build /app /app
`

test('accepts complete install stage and ignores unrelated runner COPY', () => {
  assert.doesNotThrow(() => checkDockerWorkspaceManifests(dockerfile, manifests))
})

test('detects missing direct and transitive workspace dependencies', () => {
  for (const folder of ['b', 'c']) {
    const broken = dockerfile.replace(`COPY packages/${folder}/package.json packages/${folder}/package.json\n`, '')
    assert.throws(() => checkDockerWorkspaceManifests(broken, manifests), new RegExp(`missing manifest packages/${folder}/package.json`))
  }
})

test('late COPY and wrong destination do not satisfy install inputs', () => {
  const copy = 'COPY packages/c/package.json packages/c/package.json'
  assert.throws(() => checkDockerWorkspaceManifests(dockerfile.replace(copy, '') + copy, manifests), /missing manifest/)
  assert.throws(() => checkDockerWorkspaceManifests(dockerfile.replace(copy, 'COPY packages/c/package.json /elsewhere/package.json'), manifests), /missing manifest/)
})

test('install workdir must contain every input at its final destination', () => {
  assert.throws(() => checkDockerWorkspaceManifests(dockerfile.replace('RUN pnpm install', 'WORKDIR /elsewhere\nRUN pnpm install'), manifests), /missing install input/)
  assert.throws(() => checkDockerWorkspaceManifests(dockerfile.replace('COPY packages/c/package.json packages/c/package.json', 'WORKDIR /elsewhere\nCOPY packages/c/package.json packages/c/package.json\nWORKDIR /app'), manifests), /missing manifest/)
  assert.doesNotThrow(() => checkDockerWorkspaceManifests(dockerfile.replace('COPY packages/c/package.json packages/c/package.json', 'WORKDIR /elsewhere\nCOPY packages/c/package.json /app/packages/c/package.json\nWORKDIR /app'), manifests))
})

test('redirected or repeated install instructions fail closed', () => {
  assert.throws(() => checkDockerWorkspaceManifests(dockerfile.replace('install --frozen-lockfile', 'install --frozen-lockfile --dir=/elsewhere'), manifests), /unsupported install/)
  assert.throws(() => checkDockerWorkspaceManifests(dockerfile.replace('RUN pnpm install --frozen-lockfile', 'RUN pnpm install --frozen-lockfile\nRUN pnpm install --frozen-lockfile'), manifests), /exactly one|multiple install/)
})

test('Docker ignore changes trigger both PR build checks and main image builds', () => {
  const workflow = readFileSync(new URL('../.github/workflows/docker-image.yml', import.meta.url), 'utf8')
  for (const event of ['push', 'pull_request']) {
    const section = workflow.match(new RegExp(`^  ${event}:\\r?\\n([\\s\\S]*?)(?=^  \\S)`, 'm'))?.[1]
    assert.ok(section?.split(/\r?\n/).includes('      - ".dockerignore"'), `${event} must include .dockerignore`)
  }
})

test('rejects unknown workspace names and unsupported alias syntax', () => {
  const unknown = new Map(manifests)
  unknown.set('packages/c/package.json', { name: 'c', dependencies: { missing: 'workspace:*' } })
  assert.throws(() => checkDockerWorkspaceManifests(dockerfile, unknown), /unknown workspace missing/)
  unknown.set('packages/c/package.json', { name: 'c', dependencies: { b: 'workspace:../b' } })
  assert.throws(() => checkDockerWorkspaceManifests(dockerfile, unknown), /unsupported workspace reference/)
})

test('requires root inputs and refuses ambiguous COPY syntax', () => {
  assert.throws(() => checkDockerWorkspaceManifests(dockerfile.replace('pnpm-lock.yaml ', ''), manifests), /pnpm-lock.yaml/)
  assert.throws(() => checkDockerWorkspaceManifests(dockerfile.replace('COPY apps/a', 'COPY --chown=node apps/a'), manifests), /unsupported COPY/)
})

test('all repository application images declare complete workspace install inputs', () => {
  const actual = repositoryManifests()
  for (const image of ['api', 'web', 'worker']) {
    checkDockerWorkspaceManifests(readFileSync(new URL(`../deploy/docker/${image}.Dockerfile`, import.meta.url), 'utf8'), actual, image)
  }
})
