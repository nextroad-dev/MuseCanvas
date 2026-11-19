import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'

export function loadTs(url, imports = {}, globals = {}) {
  const source = readFileSync(url, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const exports = {}
  runInThisContext(`(function(require, exports, process) { ${outputText}\n})`, {
    filename: url instanceof URL ? fileURLToPath(url) : String(url),
  })((name) => {
    if (name in imports) return imports[name]
    throw new Error(`Unexpected runtime import: ${name}`)
  }, exports, globals.process ?? process)
  return exports
}

export function loadMock() {
  const prompts = JSON.parse(readFileSync(new URL('../../../public/showcase/showcase.json', import.meta.url), 'utf8'))
  const showcase = loadTs(new URL('../lib/showcase.ts', import.meta.url), { '../../../public/showcase/showcase.json': { default: prompts } })
  const data = loadTs(new URL('./mock-workspace-data.ts', import.meta.url), { '../lib/showcase': showcase })
  const api = loadTs(new URL('./api.ts', import.meta.url), { '@musecanvas/contracts': {} })
  return { ...loadTs(new URL('./mock-workspace-api.ts', import.meta.url), { './api': api, './mock-workspace-data': data }), ...data, ...showcase }
}
