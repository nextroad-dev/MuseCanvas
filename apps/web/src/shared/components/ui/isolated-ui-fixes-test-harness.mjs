import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Execute the real TSX handlers with controlled hooks, without adding a DOM dependency.
// This harness does not simulate browser layout, event propagation, or modal effects.
export function componentHarness(url, name, mocks = {}) {
  const slots = []
  let cursor = 0
  let pendingEffects = []
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial) {
      const index = cursor++
      return slots[index] ??= { current: initial }
    },
    useEffect(effect, deps) {
      const index = cursor++
      if (!slots[index] || deps.some((value, i) => !Object.is(value, slots[index][i]))) {
        slots[index] = deps
        pendingEffects.push(effect)
      }
    },
    useCallback: (callback) => callback,
    useId: () => 'test-id',
    createContext: (defaultValue) => ({ Provider: 'ContextProvider', _defaultValue: defaultValue }),
    useContext: (ctx) => (ctx && '_defaultValue' in ctx ? ctx._defaultValue : undefined),
    Children: { only: (child) => child },
    isValidElement: (element) => Boolean(element?.props),
    cloneElement: (element, props) => ({ ...element, props: { ...element.props, ...props } }),
    Fragment: 'Fragment',
  }
  react.default = { ...react }
  const element = (type, props) => ({ type, props: props ?? {} })
  const fallback = new Proxy({ __esModule: true }, { get: (target, key) => target[key] ?? String(key) })
  const document = { activeElement: null }
  const module = { exports: {} }
  const output = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  runInNewContext(output, {
    module,
    exports: module.exports,
    document,
    require(id) {
      if (id in mocks) return mocks[id]
      if (id === 'react') return react
      if (id === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' }
      if (id === '@/shared/lib/cn') return { cn: (...values) => values.filter(Boolean).join(' ') }
      if (id === 'react-dom') return { createPortal: (node) => node }
      return fallback
    },
  })
  return {
    document,
    render(props) {
      cursor = 0
      pendingEffects = []
      return module.exports[name](props)
    },
    effects() {
      const effects = pendingEffects
      pendingEffects = []
      for (const effect of effects) effect()
    },
  }
}

export function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate))
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)]
}
