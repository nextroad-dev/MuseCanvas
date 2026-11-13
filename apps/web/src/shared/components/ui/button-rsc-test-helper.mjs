import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

export function loadButtonModules(react, interactionReference) {
  function load(file, mocks) {
    const module = { exports: {} }
    const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    }).outputText
    runInNewContext(compiled, { module, exports: module.exports, React: react, require: (id) => {
      if (id === 'react') return react
      if (id in mocks) return mocks[id]
      throw new Error(`Unexpected dependency: ${id}`)
    } })
    return module.exports
  }
  const { ButtonInteraction } = load('./button-interaction.tsx', {})
  const { Button, IconButton } = load('./button.tsx', {
    './button-interaction': { ButtonInteraction: interactionReference ?? ButtonInteraction },
    './button-variants': { buttonVariants: () => 'button-recipe', ghostIconButtonVariants: () => '' },
    '@/shared/lib/cn': { cn: (...values) => values.filter(Boolean).join(' ') },
    './spinner': { Spinner: () => react.createElement('span', { 'aria-hidden': true }) },
  })
  return { Button, IconButton, ButtonInteraction }
}
