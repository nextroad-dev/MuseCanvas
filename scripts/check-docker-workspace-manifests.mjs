import { readFileSync, readdirSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/** Narrow parser for this repository's install layers; unfamiliar COPY syntax fails closed. */
export function checkDockerWorkspaceManifests(dockerfile, manifests, label = 'Dockerfile') {
  const byName = new Map([...manifests].map(([file, manifest]) => [manifest.name, file]))
  let installs = 0
  for (const stage of dockerfile.split(/(?=^FROM\s)/m)) {
    const lines = stage.split(/\r?\n/)
    const installLines = lines.map((line, index) => /^RUN\s+pnpm\s+install\b/.test(line) ? index : -1).filter(index => index >= 0)
    if (installLines.length === 0) continue
    if (installLines.length !== 1) throw new Error(`${label}: multiple install instructions in a stage`)
    const install = installLines[0]
    if (!/^RUN\s+pnpm\s+install\s+--frozen-lockfile\s*$/.test(lines[install])) throw new Error(`${label}: unsupported install instruction`)
    installs += 1
    const destinations = new Map()
    let workdir = '/'
    for (const raw of lines.slice(0, install)) {
      const line = raw.trim()
      if (line.startsWith('WORKDIR ')) {
        const value = line.slice(8).trim()
        if (/[\s$\\]/.test(value)) throw new Error(`${label}: unsupported WORKDIR`)
        workdir = posix.resolve(workdir, value)
      }
      if (!line.startsWith('COPY ')) continue
      const parts = line.slice(5).trim().split(/\s+/)
      if (parts.length < 2 || parts.some(value => /[\[\]"'$*?\\]/.test(value) || value.startsWith('--')))
        throw new Error(`${label}: unsupported COPY before install: ${line}`)
      const destination = parts.pop()
      for (const source of parts) {
        const sourceFile = posix.normalize(source)
        if (!manifests.has(sourceFile) && !['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json'].includes(sourceFile))
          throw new Error(`${label}: unsupported source before install: ${source}`)
        const target = posix.resolve(workdir, destination.endsWith('/') || parts.length > 1 ? posix.join(destination, posix.basename(source)) : destination)
        destinations.set(target, sourceFile)
      }
    }
    const copied = new Set([...destinations].filter(([target, source]) => target === posix.resolve(workdir, source)).map(([, source]) => source))
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      if (!copied.has(file)) throw new Error(`${label}: missing install input ${file}`)
    }
    const visited = new Set()
    function visit(file, chain) {
      if (visited.has(file)) return
      visited.add(file)
      if (!copied.has(file)) throw new Error(`${label}: missing manifest ${file} (${chain.join(' -> ')})`)
      for (const field of dependencyFields) {
        for (const [name, version] of Object.entries(manifests.get(file)?.[field] ?? {})) {
          if (!version.startsWith('workspace:')) continue
          if (!/^workspace:(?:\*|\^|~|[~^]?\d[\d.x*<>=|~^ -]*)$/.test(version))
            throw new Error(`${label}: unsupported workspace reference ${name}: ${version}`)
          const dependency = byName.get(name)
          if (!dependency) throw new Error(`${label}: unknown workspace ${name} (${chain.join(' -> ')})`)
          visit(dependency, [...chain, name])
        }
      }
    }
    visit('package.json', ['root'])
    for (const file of copied) if (manifests.has(file)) visit(file, [manifests.get(file).name])
    // These images run a full-workspace install, so every lockfile importer needs its manifest.
    for (const file of manifests.keys()) if (!copied.has(file)) throw new Error(`${label}: missing workspace manifest ${file}`)
  }
  if (installs !== 1) throw new Error(`${label}: expected exactly one pnpm install layer, found ${installs}`)
}

export function repositoryManifests(directory = root) {
  const manifests = new Map([['package.json', JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))]])
  for (const folder of ['apps', 'packages']) {
    for (const entry of readdirSync(resolve(directory, folder), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = `${folder}/${entry.name}/package.json`
      manifests.set(file, JSON.parse(readFileSync(resolve(directory, file), 'utf8')))
    }
  }
  return manifests
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifests = repositoryManifests()
  for (const name of ['api', 'web', 'worker']) {
    const file = `deploy/docker/${name}.Dockerfile`
    checkDockerWorkspaceManifests(readFileSync(resolve(root, file), 'utf8'), manifests, file)
    console.log(`${file}: workspace install inputs complete`)
  }
}
