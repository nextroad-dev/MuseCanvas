import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import * as timeline from '../lib/agent-timeline.ts'
import * as keys from './query-keys.ts'

// Execute the actual hook with deterministic React/query adapters: no DOM or new dependencies.
const source = ts.transpileModule(readFileSync(new URL('./useCanvasAgent.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function harness() {
  const slots = []
  const effects = []
  const requests = []
  const invalidations = []
  const tasks = []
  let cursor = 0
  let actor = 'user-A'
  let canvas = 'A'
  let streamCallbacks
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
    useCallback(callback) { return callback },
    useEffect(callback, deps) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
        effects.push(() => {
          previous?.cleanup?.()
          slots[index] = { deps, cleanup: callback() }
        })
      }
    },
  }
  const queryClient = {
    invalidateQueries: ({ queryKey }) => { invalidations.push(queryKey); return Promise.resolve() },
    removeQueries() {},
  }
  const query = {
    useQueryClient: () => queryClient,
    useQuery: () => ({}),
    useInfiniteQuery: () => ({}),
    useMutation: (options) => ({
      mutate(input) {
        // Defer mutationFn as TanStack does; switching before it starts must not retarget it.
        tasks.push(Promise.resolve().then(() => options.mutationFn(input)).then(
          (result) => { options.onSuccess?.(result, input); options.onSettled?.(result, null, input) },
          (error) => { options.onError?.(error, input); options.onSettled?.(undefined, error, input) },
        ))
      },
    }),
  }
  const request = (kind, args) => new Promise((resolve, reject) => requests.push({ kind, args, resolve, reject }))
  const imports = {
    react,
    '@tanstack/react-query': query,
    '@musecanvas/contracts': { API_ENDPOINTS: {} },
    '@/shared/services/client-api': {
      clientApi: { canvasAgent: {
        apply: (...args) => request('apply', args),
        confirm: (...args) => request('confirm', args),
      } },
    },
    '@/shared/lib/agent-timeline': timeline,
    '@/shared/lib/agent-stream': { createAgentSubmitLock: () => ({}) },
    '@/shared/lib/agent-composer': {
      createComposerSender(callbacks) {
        streamCallbacks = callbacks
        return { stop() {}, sendUserMessage: () => true }
      },
    },
    './query-keys': keys,
    './useSession': { useSession: () => ({ data: { user: { id: actor } } }) },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)((name) => {
    assert.ok(name in imports, `unexpected import ${name}`)
    return imports[name]
  }, module, module.exports)
  function render(nextCanvas = canvas, nextActor = actor) {
    canvas = nextCanvas
    actor = nextActor
    cursor = 0
    const controller = module.exports.useCanvasAgent(canvas)
    while (effects.length) effects.shift()()
    return controller
  }
  return {
    render, requests, invalidations,
    start: async () => { await Promise.resolve() },
    settle: async () => { await Promise.all(tasks) },
    ops(turnId) {
      streamCallbacks.onEvent({ type: 'canvas_ops', eventId: turnId, turnId, ops: [{ type: 'remove_node', nodeId: 'n' }], baseRevision: 1 }, canvas)
    },
  }
}

const applied = { applied: true, revision: 2, ops: [] }
const confirmed = { pending: { id: 'pending', turnId: 'turn', status: 'confirmed', jobId: 'job' } }

for (const outcome of ['resolve', 'reject']) {
  for (const switchKind of ['canvas', 'actor', 'round-trip']) {
    test(`confirmation ${outcome}: ignores stale ${switchKind} callbacks and invalidates origin`, async () => {
      const h = harness()
      h.render().confirmPending('pending', true)
      if (switchKind === 'actor') h.render('A', 'user-B')
      else h.render('B')
      if (switchKind === 'round-trip') h.render('A')
      await h.start()
      assert.deepEqual(h.requests[0].args, ['A', 'pending', true])
      h.requests[0][outcome](outcome === 'resolve' ? confirmed : new Error('failed'))
      await h.settle()
      const current = h.render()
      assert.equal(current.items.length, 0)
      assert.equal(current.confirmationFor('pending').phase, 'idle')
      assert.equal(h.requests.length, 1, 'stale confirmation must not trigger apply')
      assert.ok(h.invalidations.some((key) => JSON.stringify(key) === JSON.stringify(keys.queryKeys.canvasAgent.history('A'))))
      assert.ok(!h.invalidations.some((key) => JSON.stringify(key) === JSON.stringify(keys.queryKeys.canvasAgent.history('B'))))
    })

    test(`apply ${outcome}: ignores stale ${switchKind} feedback`, async () => {
      const h = harness()
      h.render().applyTurn('turn')
      if (switchKind === 'actor') h.render('A', 'user-B')
      else h.render('B')
      if (switchKind === 'round-trip') h.render('A')
      await h.start()
      assert.deepEqual(h.requests[0].args, ['A', 'turn'])
      h.requests[0][outcome](outcome === 'resolve' ? applied : new Error('failed'))
      await h.settle()
      assert.equal(h.render().applyFeedback, null)
      if (outcome === 'resolve') {
        assert.ok(h.invalidations.some((key) => JSON.stringify(key) === JSON.stringify(keys.queryKeys.canvases.detail('A'))))
        assert.ok(!h.invalidations.some((key) => JSON.stringify(key) === JSON.stringify(keys.queryKeys.canvases.detail('B'))))
      }
    })
  }
}

test('manual retry bypasses automatic attempted dedupe, but never an in-flight request', async () => {
  const h = harness()
  let controller = h.render()
  controller.send({ text: 'test' }, 1)
  h.ops('turn')
  controller.confirmPending('pending', true)
  await h.start()
  h.requests[0].resolve(confirmed)
  await Promise.resolve()
  await Promise.resolve()
  await h.start()
  assert.equal(h.requests[1].kind, 'apply', 'confirmation automatically applies its ops')
  h.render().applyTurn('turn')
  await h.start()
  assert.equal(h.requests.length, 2)
  h.requests[1].reject(new Error('temporary failure'))
  await h.settle()
  controller = h.render()
  assert.match(controller.applyFeedback.message, /temporary failure/)
  controller.applyTurn('turn')
  controller.applyTurn('turn')
  await h.start()
  assert.equal(h.requests.length, 3, 'retry starts exactly one new request')
  h.requests[2].resolve(applied)
  await h.settle()
  assert.equal(h.render().applyFeedback.applied, true)
})

test('returning to A cannot duplicate an older A apply still in flight', async () => {
  const h = harness()
  h.render().applyTurn('turn')
  h.render('B')
  h.render('A').applyTurn('turn')
  await h.start()
  assert.equal(h.requests.length, 1)
  h.requests[0].reject(new Error('old failure'))
  await h.settle()
  assert.equal(h.render().applyFeedback, null)
  h.render().applyTurn('turn')
  await h.start()
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve(applied)
  await h.settle()
  assert.equal(h.render().applyFeedback.applied, true)
})

test('stale confirmation cannot apply ops from the new conversation', async () => {
  const h = harness()
  h.render().confirmPending('pending', true)
  h.render('B').send({ text: 'new conversation' }, 1)
  h.ops('turn')
  const before = h.render().items
  await h.start()
  h.requests[0].resolve(confirmed)
  await h.settle()
  assert.deepEqual(h.render().items, before)
  assert.equal(h.requests.length, 1, 'B ops must not be applied by A confirmation')
})
