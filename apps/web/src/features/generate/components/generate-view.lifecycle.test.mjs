import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'
import { createStore } from 'zustand/vanilla'
import * as reuse from '../lib/generate-reuse.ts'
import * as form from '../lib/generate-form.ts'

function loadModule(file, dependencies) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  })
  const exports = {}
  runInThisContext(`(function(require, exports) { ${outputText}\n})`)((name) => {
    if (name in dependencies) return dependencies[name]
    throw new Error(`Unexpected import: ${name}`)
  }, exports)
  return exports
}

// Execute the actual component and store with an effect-lifecycle scheduler.
// No DOM dependencies: this tests committed effects/cleanup, not browser layout.
function setup(query) {
  let hydrating = false
  let search = query
  let effects = []
  let pending = []
  let effectIndex = 0
  let submissions = 0
  let store
  const { useComposerStore } = loadModule('../stores/composer-store.ts', {
    zustand: { create: (initializer) => {
      store = createStore(initializer)
      return (selector) => selector(store.getState())
    } },
    '../lib/generate-reuse': reuse,
  })
  const model = { id: 'image-model', displayName: 'Image', enabled: true, modelKind: 'image', modes: ['text_to_image'], inputSlots: [], parameters: [], maxCount: 1 }
  const generateState = {
    selectedModelIdByKind: { image: null }, paramsByKind: { image: {} },
    setSelectedModel() {}, setParam() {}, replaceParams() {},
  }
  const { GenerateView } = loadModule('./generate-view.tsx', {
    react: {
      useSyncExternalStore: (_subscribe, clientSnapshot, serverSnapshot) => hydrating ? serverSnapshot() : clientSnapshot(),
      useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
      useRef: (value) => ({ current: value }),
      useEffect: (callback, deps) => {
        const index = effectIndex++
        const previous = effects[index]
        if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) pending.push(() => {
          previous?.cleanup?.()
          effects[index] = { deps, cleanup: callback() }
        })
      },
    },
    'react/jsx-runtime': jsxRuntime,
    'next/navigation': { useSearchParams: () => new URLSearchParams(search) },
    '@tanstack/react-query': {
      useQueryClient: () => ({ invalidateQueries() {} }),
      useMutation: () => ({ isPending: false, reset() {}, mutateAsync: async () => { submissions++ } }),
    },
    '@phosphor-icons/react': new Proxy({}, { get: (_target, name) => String(name) }),
    '@/shared/components/ui': new Proxy({}, { get: (_target, name) => String(name) }),
    '@/shared/hooks/useModels': { useModels: () => ({ data: [model] }) },
    '@/shared/hooks/useJobs': { useJobs: () => ({ data: { items: [] }, isFetching: true, refetch: async () => {} }), useSeedCreatedJob: () => () => {} },
    '@/shared/hooks/query-keys': { queryKeys: { jobs: { root: [] }, library: { root: [] } } },
    '@/shared/services/client-api': { clientApi: { generations: { create() {} } } },
    '@/shared/lib/model-capabilities': { resolveActiveModel: () => model },
    '@/shared/lib/media-parameters': { buildMediaParameters: () => ({}), parameterIssues: () => [], resolveDescriptor: () => undefined, mediaControlDescriptors: () => [] },
    '@/shared/lib/generation-params': { newIdempotencyKey: () => 'key', toGenerationRequest: (value) => value },
    '@/shared/stores/generate-ui-store': { useGenerateUiStore: (selector) => selector(generateState) },
    '../stores/composer-store': { useComposerStore },
    '../lib/generate-form': form,
    '../lib/generate-reuse': reuse,
    './generation-task': { GenerationTask: 'GenerationTask' },
  })
  return {
    store,
    setHydrating(value) { hydrating = value },
    render() { effectIndex = 0; pending = []; const tree = GenerateView({ mode: 'mock' }); pending.forEach((commit) => commit()); return tree },
    unmount() { effects.forEach((effect) => effect.cleanup?.()); effects = [] },
    get submissions() { return submissions },
  }
}

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null
  if (predicate(tree)) return tree
  for (const child of [tree.props?.children].flat(Infinity)) {
    const match = find(child, predicate)
    if (match) return match
  }
  return null
}

test('GenerateView unmount expires reuse identity without clearing draft; same asset imports again on remount', () => {
  const app = setup('prompt=素材A&kind=image')
  app.render()
  assert.equal(app.store.getState().prompt, '素材A')
  app.store.getState().setPrompt('编辑后的B')
  app.render()
  assert.equal(app.store.getState().prompt, '编辑后的B')
  app.unmount() // Navigate to library; GenerateView never sees an empty query.
  assert.equal(app.store.getState().prompt, '编辑后的B')
  assert.equal(app.store.getState().lastReuseQuery, '')
  app.render() // Same library reuse link A, same long-lived Zustand store.
  assert.equal(app.store.getState().prompt, '素材A')
  app.unmount()
})

test('revisiting identical video reuse restores its block after a prior explicit image choice', async () => {
  const app = setup('prompt=视频A&kind=video')
  app.render()
  app.store.getState().setRequestedKind('image')
  app.store.getState().setPrompt('图片草稿B')
  app.render()
  app.unmount()
  assert.equal(app.store.getState().requestedKind, 'image')
  assert.equal(app.store.getState().prompt, '图片草稿B')
  let tree = app.render()
  assert.equal(app.store.getState().prompt, '视频A')
  assert.equal(app.store.getState().requestedKind, 'video')
  tree = app.render()
  const submit = find(tree, (element) => element.type === 'Button' && element.props.type === 'submit')
  assert.equal(submit.props.disabled, true)
  await find(tree, (element) => element.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(app.submissions, 0)
  app.unmount()
  assert.equal(app.store.getState().requestedKind, 'video')
})

test('background job fetching does not set the manual refresh button initial loading state', async () => {
  const app = setup('')
  const tree = app.render()
  const refresh = find(tree, (element) => element.type === 'Button' && element.props.children === '刷新列表')
  assert.equal(refresh.props.loading, false)
  await refresh.props.onClick()
  app.unmount()
})

test('hydrating page keeps server skeleton even when shell has already populated jobs cache', () => {
  const app = setup('')
  app.setHydrating(true)
  let tree = app.render()
  assert.ok(find(tree, (element) => element.props['aria-label'] === '加载创作记录'))
  assert.equal(find(tree, (element) => element.type === 'h3' && element.props.children === '留一块空白，给新灵感。'), null)
  app.setHydrating(false)
  tree = app.render()
  assert.equal(find(tree, (element) => element.props['aria-label'] === '加载创作记录'), null)
  assert.ok(find(tree, (element) => element.type === 'h3' && element.props.children === '留一块空白，给新灵感。'))
  app.unmount()
})
