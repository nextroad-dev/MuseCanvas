import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInThisContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'
import { loadTs } from '../../../shared/services/mock-workspace-test-loader.mjs'

const anchors = loadTs(new URL('../lib/artifact-anchors.ts', import.meta.url))
const status = loadTs(new URL('../lib/agent-status.ts', import.meta.url))
const { queryKeys } = loadTs(new URL('../../../shared/hooks/query-keys.ts', import.meta.url))
const artifact = { id: 'text:00000000-0000-4000-8000-000000000001', kind: 'text', content: '😀 same\n same <script>literal</script>', sessionId: 'session-a', turnId: 'turn-a', sourceItemId: 'item-a', version: 1, createdAt: '2026-11-19T01:00:00Z' }
const thread = { id: 'thread-a', artifactId: artifact.id, version: 1, anchor: { kind: 'whole' }, resolved: false, resolvedAt: null, messages: [{ id: 'message-a', body: '<b>private</b>', createdAt: artifact.createdAt }], createdAt: artifact.createdAt }

function setup({ mode = 'live', fixture = artifact } = {}) {
  let activeRunner
  const calls = [], invalidated = [], queries = [], mutations = []
  const data = { pages: [{ items: [fixture], nextCursor: null }] }
  const threadData = { pages: [{ items: [], nextCursor: null }] }
  let detail = fixture
  let nextPages = 0
  const client = { invalidateQueries: async ({ queryKey }) => { invalidated.push(queryKey) } }
  const baseQuery = { isPending: false, isError: false, error: null, dataUpdatedAt: 1, isFetching: false, isFetchingNextPage: false, refetch: async () => {} }
  const api = {
    listArtifacts: async (...args) => { calls.push(['list', ...args]); return data.pages[0] },
    getArtifact: async (...args) => { calls.push(['detail', ...args]); return detail },
    listArtifactThreads: async (...args) => { calls.push(['threads', ...args]); return threadData.pages[0] },
    createArtifactThread: async (...args) => { calls.push(['create', ...args]); return { ...thread, anchor: args[2].anchor, messages: [{ ...thread.messages[0], body: args[2].body }] } },
    replyArtifactThread: async (...args) => { calls.push(['reply', ...args]); return { ...thread, messages: [...thread.messages, { id: 'reply-a', body: args[3].body, createdAt: artifact.createdAt }] } },
    resolveArtifactThread: async (...args) => { calls.push(['resolve', ...args]); return { ...thread, resolved: args[3].resolved } },
  }
  const imports = {
    react: {
      useState: (initial) => activeRunner.state(initial),
      useRef: (initial) => activeRunner.ref(initial),
      useEffect: (callback, deps) => activeRunner.effect(callback, deps),
    },
    'react/jsx-runtime': jsxRuntime,
    '@tanstack/react-query': {
      useQueryClient: () => client,
      useInfiniteQuery: (options) => {
        queries.push(options)
        const isList = options.queryKey[1] === 'artifacts'
        const pages = isList ? data : threadData
        return { ...baseQuery, data: pages, hasNextPage: Boolean(pages.pages.at(-1).nextCursor), fetchNextPage: async () => { nextPages += 1 } }
      },
      useQuery: (options) => {
        queries.push(options)
        return { ...baseQuery, data: options.queryKey[1] === 'artifact' ? detail : { id: fixture.assetId, url: '/authorized-media', imageUrl: '/authorized-image' } }
      },
      useMutation: (options) => ({ isPending: false, isError: false, mutate: (action) => {
        const promise = options.mutationFn(action).then((result) => options.onSuccess(result, action))
        mutations.push(promise)
      } }),
    },
    '@/shared/components/ui': { Button: 'Button', Alert: 'Alert' },
    '@/shared/hooks/query-keys': { queryKeys },
    '@/shared/services/client-api': { agentApi: api, libraryApi: { detail: async (id) => { calls.push(['asset', id]); return { id, url: '/authorized-media' } } } },
    '../lib/agent-status': status,
    '../lib/artifact-anchors': anchors,
  }
  const source = readFileSync(new URL('./artifact-pane.tsx', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } })
  const exports = {}
  runInThisContext(`(function(require, exports) { ${outputText}\n})`)((name) => {
    if (name in imports) return imports[name]
    throw new Error(`Unexpected import: ${name}`)
  }, exports)
  function runner(Component, props) {
    const slots = [], effects = []
    let cursor = 0, pending = []
    const instance = {
      props,
      state(initial) {
        const index = cursor++
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
        return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
      },
      ref(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
      effect(callback, deps) {
        const index = cursor++
        const old = effects[index]
        if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: callback() } })
      },
      render() {
        cursor = 0; activeRunner = instance
        const tree = Component(instance.props)
        const work = pending; pending = []
        for (const effect of work) effect()
        return tree
      },
    }
    return instance
  }
  const drafts = new Map()
  const controller = { mode, actorId: 'owner-a', sessionId: fixture.sessionId, serviceStatus: 'ready', items: [], snapshotQuery: { dataUpdatedAt: 1 }, turnActive: false }
  const pane = runner(exports.ArtifactPane, { console: controller, drafts, onJumpToMessage() {} })
  return {
    pane, runner, drafts, calls, queries, invalidated, mutations, data, threadData,
    setDetail: (value) => { detail = value },
    get nextPages() { return nextPages },
    content() {
      pane.render()
      const detailElement = find(pane.render(), (node) => typeof node.type === 'function' && node.type.name === 'ArtifactDetail')
      const detailTree = runner(detailElement.type, detailElement.props).render()
      return runner(detailTree.type, detailTree.props)
    },
  }
}

function all(tree, predicate, result = []) {
  if (!tree || typeof tree !== 'object') return result
  if (predicate(tree)) result.push(tree)
  for (const child of [tree.props?.children].flat(Infinity)) all(child, predicate, result)
  return result
}
function find(tree, predicate) { return all(tree, predicate)[0] }
function text(tree) {
  if (tree == null || typeof tree === 'boolean') return ''
  if (typeof tree !== 'object') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join('')
  return text(tree.props?.children)
}
const button = (tree, label) => find(tree, (node) => node.type === 'Button' && text(node) === label)

test('pane pins its selection when new outputs arrive, pages source lookup, and keeps mock calls local', async () => {
  const app = setup()
  app.pane.render()
  let tree = app.pane.render()
  assert.equal(find(tree, (node) => node.type === 'select').props.value, artifact.id)
  app.data.pages = [{ items: [{ ...artifact, id: 'text:new' }, artifact], nextCursor: null }]
  tree = app.pane.render()
  assert.equal(find(tree, (node) => node.type === 'select').props.value, artifact.id)
  app.data.pages = [{ items: [artifact], nextCursor: 'opaque' }]
  app.pane.props = { ...app.pane.props, request: { sourceItemId: 'older-source', nonce: 1 } }
  app.pane.render(); app.pane.render()
  assert.equal(app.nextPages, 1)
  app.data.pages.push({ items: [{ ...artifact, id: 'media:older', sourceItemId: 'older-source' }], nextCursor: null })
  app.pane.render()
  tree = app.pane.render()
  assert.equal(find(tree, (node) => node.type === 'select').props.value, 'media:older')
  const mocked = setup({ mode: 'mock' })
  assert.match(text(mocked.pane.render()), /本地演示/)
  await mocked.queries[0].queryFn({ pageParam: undefined })
  assert.deepEqual(mocked.calls, [])
})

test('private comment create/reply/resolve/reopen sends correct immutable anchors and preserves a draft across remounts', async () => {
  const app = setup()
  let content = app.content()
  let tree = content.render()
  const body = '  private <script>literal</script>  '
  const form = find(tree, (node) => node.type === 'form' && node.props['aria-label'] === '新建私密评论')
  find(form, (node) => node.type === 'textarea').props.onChange({ target: { value: body } })
  tree = content.render()
  const savedId = app.drafts.values().next().value.requestId
  assert.ok(savedId)
  content = app.content()
  tree = content.render()
  assert.equal(find(tree, (node) => node.type === 'textarea').props.value, body)
  find(tree, (node) => node.type === 'form' && node.props['aria-label'] === '新建私密评论').props.onSubmit({ preventDefault() {} })
  await Promise.all(app.mutations)
  assert.deepEqual(app.calls.find((call) => call[0] === 'create').slice(1), [artifact.sessionId, artifact.id, { version: 1, clientRequestId: savedId, body, anchor: { kind: 'whole' } }])
  tree = content.render()
  assert.ok(text(tree).includes(body))
  assert.equal(find(tree, (node) => node.type === 'textarea').props.value, '')
  assert.equal(all(tree, (node) => node.props?.dangerouslySetInnerHTML).length, 0)
  button(tree, '标为已解决').props.onClick()
  await Promise.all(app.mutations)
  tree = content.render()
  assert.ok(button(tree, '重新打开'))
  button(tree, '重新打开').props.onClick()
  await Promise.all(app.mutations)
  tree = content.render()
  const replyForm = find(tree, (node) => node.type === 'form' && node.props['aria-label'] === '回复私密讨论')
  find(replyForm, (node) => node.type === 'textarea').props.onChange({ target: { value: 'reply' } })
  tree = content.render()
  find(tree, (node) => node.type === 'form' && node.props['aria-label'] === '回复私密讨论').props.onSubmit({ preventDefault() {} })
  await Promise.all(app.mutations)
  assert.equal(app.calls.find((call) => call[0] === 'reply')[4].body, 'reply')
  assert.deepEqual(app.calls.filter((call) => call[0] === 'resolve').map((call) => call[4]), [{ resolved: true }, { resolved: false }])
  assert.ok(app.invalidated.some((key) => key[1] === 'artifact-threads' && key[2] === 'owner-a' && key[3] === artifact.sessionId))
})

test('media rendering obtains URLs only through owner-scoped library detail, and stale media does not fetch', async () => {
  for (const kind of ['image', 'video']) {
    const fixture = { ...artifact, id: 'media:asset-a', kind, assetId: 'asset-a', available: true, width: 800, height: 400, durationMs: 8000 }
    const app = setup({ fixture })
    const content = app.content()
    const tree = content.render()
    const query = app.queries.find((options) => options.queryKey[1] === 'artifact-asset')
    assert.equal(query.enabled, true)
    assert.deepEqual(query.queryKey, queryKeys.agent.artifactAsset('owner-a', artifact.sessionId, 'asset-a'))
    assert.equal(query.gcTime, 0)
    await query.queryFn()
    assert.deepEqual(app.calls, [['asset', 'asset-a']])
    const media = find(tree, (node) => node.type === kind.replace('image', 'img'))
    assert.equal(media.props.src, kind === 'image' ? '/authorized-image' : '/authorized-media')
    if (kind === 'video') assert.equal(media.props.controls, true)
    const stale = setup({ fixture: { ...fixture, available: false } })
    assert.match(text(stale.content().render()), /媒体已删除或不可用/)
    assert.equal(stale.queries.find((options) => options.queryKey[1] === 'artifact-asset').enabled, false)
    assert.deepEqual(stale.calls, [])
  }
})

test('private thread pagination keeps its independent cursor and provides a load-more action', async () => {
  const app = setup()
  app.threadData.pages = [{ items: [thread], nextCursor: 'thread_cursor' }]
  const tree = app.content().render()
  const threadQuery = app.queries.find((query) => query.queryKey[1] === 'artifact-threads')
  assert.equal(threadQuery.getNextPageParam(app.threadData.pages[0]), 'thread_cursor')
  await threadQuery.queryFn({ pageParam: 'thread_cursor' })
  assert.deepEqual(app.calls.at(-1), ['threads', artifact.sessionId, artifact.id, { limit: 30, cursor: 'thread_cursor' }])
  button(tree, '加载更多讨论').props.onClick()
  assert.equal(app.nextPages, 1)
})
