import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const sourceIndex = process.env.PROMPT_TEMPLATE_INDEX_PATH || ''
const runtimeRoot = path.resolve('.runtime/prompt-templates')
const runtimeIndex = path.join(runtimeRoot, 'index.json')

function fail(message) {
  throw new Error(`prepare-prompt-templates: ${message}`)
}

async function main() {
  if (!sourceIndex) fail('PROMPT_TEMPLATE_INDEX_PATH is required')
  if (!path.isAbsolute(sourceIndex)) fail('PROMPT_TEMPLATE_INDEX_PATH must be an absolute path to index.json')
  if (path.basename(sourceIndex).toLowerCase() !== 'index.json') fail('PROMPT_TEMPLATE_INDEX_PATH must point to index.json')

  const indexReal = await realpath(sourceIndex)
  const indexInfo = await stat(indexReal)
  if (!indexInfo.isFile()) fail('PROMPT_TEMPLATE_INDEX_PATH must point to a file')

  const rootReal = await realpath(path.dirname(indexReal))
  const parsed = JSON.parse(await readFile(indexReal, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.templates)) {
    fail('index.json must be an object with a templates array')
  }

  await rm(runtimeRoot, { recursive: true, force: true })
  await mkdir(runtimeRoot, { recursive: true })

  for (const entry of parsed.templates) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('template entries must be objects')
    if (typeof entry.path !== 'string' || !entry.path) fail('template entry path is required')
    const relative = entry.path.replaceAll('\\', '/')
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) fail(`template path is invalid: ${relative}`)
    const sourceFile = await realpath(path.resolve(rootReal, relative))
    if (sourceFile !== rootReal && !sourceFile.startsWith(`${rootReal}${path.sep}`)) fail(`template path escapes root: ${relative}`)
    const targetFile = path.join(runtimeRoot, relative)
    await mkdir(path.dirname(targetFile), { recursive: true })
    await cp(sourceFile, targetFile, { force: true })
  }

  await writeFile(runtimeIndex, JSON.stringify(parsed, null, 2))
  process.stdout.write(`Prepared prompt templates at ${runtimeRoot}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
