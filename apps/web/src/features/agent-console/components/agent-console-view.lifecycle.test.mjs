import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'
import { createStore } from 'zustand/vanilla'
import * as reuse from '../lib/agent-console-reuse.ts'
import * as agentStatus from '../lib/agent-status.ts'

const MOCK_SEED_SESSION_ID = '00000000-0000-4000-8000-000000000401'
const MOCK_AGENT_DEFINITION_ID = '00000000-0000-4000-8000-000000000201'

function loadModule(file, dependencies) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  })
  const exports = {}
  runInThisContext(`(function(require, exports) { ${outputText}\n})`)((name) => {
    if (name in dependencies) return dependencies[name]
    throw new Error(`Unexpected import: ${name}`)
  }, exports)
  return exports
}

function createMockWindow(width) {
  const listeners = new Map()
  return {
    matchMedia(query) {
      const match = /min-width:\s*(\d+)px/.exec(query)
      const min = match ? Number(match[1]) : 0
      return { matches: width >= min }
    },
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event)
      }
      return true
    },
  }
}

function setup({
  query = '',
  mode = 'mock',
  sessions = [],
  actorId = 'mock-preview',
  connectionState,
  turnActive = false,
  activeTurn = null,
  pendingApprovals = [],
  models = [],
  viewportWidth,
} = {}) {
  const hasPreviousWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window')
  const previousWindow = globalThis.window
  if (viewportWidth !== undefined) {
    globalThis.window = createMockWindow(viewportWidth)
  }

  let hydrating = false
  let search = query
  let currentMode = mode
  let currentSessions = sessions
  let currentActorId = actorId
  let currentConnectionState = connectionState
  let currentTurnActive = turnActive
  let currentActiveTurn = activeTurn
  let currentPendingApprovals = pendingApprovals
  let currentModels = models
  let effects = []
  let pending = []
  let effectIndex = 0
  let stateCursor = 0
  const stateSlots = []
  let refCursor = 0
  const refSlots = []
  const capturedUseAgentConsoleArgs = []
  const capturedCreateCalls = []
  let store

  const { useAgentConsoleStore } = loadModule('../stores/agent-console-store.ts', {
    zustand: {
      create: (initializer) => {
        store = createStore(initializer)
        const hook = (selector) => selector(store.getState())
        hook.getState = () => store.getState()
        return hook
      },
    },
    '../lib/agent-console-reuse': reuse,
  })

  const { AgentConsoleView } = loadModule('./agent-console-view.tsx', {
    react: {
      useSyncExternalStore: (_subscribe, clientSnapshot, serverSnapshot) =>
        hydrating ? serverSnapshot() : clientSnapshot(),
      useState: (initial) => {
        const idx = stateCursor++
        if (!(idx in stateSlots)) {
          stateSlots[idx] = typeof initial === 'function' ? initial() : initial
        }
        return [
          stateSlots[idx],
          (next) => {
            stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next
          },
        ]
      },
      useMemo: (factory) => factory(),
      useRef: (initial) => {
        const idx = refCursor++
        if (!(idx in refSlots)) {
          refSlots[idx] = { current: initial }
        }
        return refSlots[idx]
      },
      useEffect: (callback, deps) => {
        const index = effectIndex++
        const previous = effects[index]
        const changed =
          !previous ||
          deps === undefined ||
          deps.some((value, i) => !Object.is(value, previous.deps[i]))
        if (changed) {
          pending.push(() => {
            previous?.cleanup?.()
            effects[index] = { deps, cleanup: callback() }
          })
        }
      },
    },
    'react/jsx-runtime': jsxRuntime,
    'next/link': { __esModule: true, default: 'Link' },
    'next/navigation': { useSearchParams: () => new URLSearchParams(search) },
    '@phosphor-icons/react': new Proxy({}, { get: (_target, name) => String(name) }),
    '@/shared/components/ui': new Proxy(
      {
        useToast: () => ({ toast: { success() {}, error() {}, info() {}, warning() {}, dismiss() {} } }),
        iconSize: { xs: 'xs', sm: 'sm', md: 'md', lg: 'lg' },
      },
      { get: (target, name) => (name in target ? target[name] : String(name)) },
    ),
    '@/shared/hooks/useAgentConsole': {
      useAgentConsole: (sessionId, opts) => {
        capturedUseAgentConsoleArgs.push({ sessionId, mode: opts?.mode })
        const selectedSession = currentSessions.find((s) => s.id === sessionId) ?? null
        return {
          mode: currentMode,
          actorId: currentActorId,
          sessionId,
          sessions: currentSessions,
          sessionsQuery: { isPending: false, isFetchingNextPage: false, refetch: async () => {} },
          hasMoreSessions: false,
          loadMoreSessions() {},
          snapshotQuery: { isPending: false, isError: false },
          timeline: {
            session: selectedSession,
            activeTurn: currentActiveTurn,
            items: [],
            tools: {},
            approvals: {},
            eventCursor: '0',
            lastItemSequence: '0',
            itemsHasMore: false,
            nextItemsCursor: '0',
            resyncRequired: null,
          },
          session: selectedSession,
          activeTurn: currentActiveTurn,
          turnActive: currentTurnActive,
          items: [],
          tools: [],
          approvals: currentPendingApprovals,
          pendingApprovals: currentPendingApprovals,
          serviceStatus: 'ready',
          connectionState: currentConnectionState ?? (sessionId ? 'connected' : 'idle'),
          error: null,
          hasOlderItems: false,
          loadingOlderItems: false,
          loadOlderError: null,
          loadOlderItems: async () => {},
          reconnect() {},
          resync: async () => {},
          createSession: async (input) => {
            capturedCreateCalls.push(input)
            return {
              id: '00000000-0000-4000-8000-000000000888',
              ownerId: 'owner',
              agentDefinitionId: input.agentDefinitionId,
              definitionVersion: input.definitionVersion,
              defaultCanvasId: input.defaultCanvasId ?? null,
              activeTurnId: null,
              inputRevision: '0',
              nextItemSequence: '0',
              nextEventCursor: '0',
              createdAt: '2026-01-06T00:00:00.000Z',
              updatedAt: '2026-01-06T00:00:00.000Z',
              archivedAt: null,
            }
          },
          sendMessage: async () => ({}),
          steerTurn: async () => ({}),
          cancelTurn: async () => ({}),
          resolveApproval: async () => ({}),
          mutations: {
            createSession: { isPending: false },
            sendMessage: { isPending: false },
            steerTurn: { isPending: false },
            cancelTurn: { isPending: false },
            resolveApproval: { isPending: false },
          },
        }
      },
    },
    // 局部修改入口只在存在声明了 mask 输入的图片模型时可用；默认空目录即不可用。
    '@/shared/hooks/useModels': { useModels: () => ({ data: currentModels, isLoading: false }) },
    '@/shared/hooks/useAnimatedPresence': {
      useAnimatedPresence: (open) => ({
        mounted: open,
        phase: open ? 'idle' : 'exit',
        closing: false,
        onAnimationEnd: () => {},
      }),
    },
    '@/features/workspace/components/workspace-shell-context': {
      useWorkspaceShell: () => null,
    },
    '@/shared/lib/app-routes': loadModule('../../../shared/lib/app-routes.ts', {}),
    '@/shared/lib/cn': { cn: (...values) => values.filter(Boolean).join(' ') },
    '@/shared/services/api': { isApiError: () => false },
    '@/shared/services/mock-agent-api': {
      MOCK_AGENT_DEFINITION_ID,
      MOCK_SEED_SESSION_ID,
      mockAgentApi: {
        deleteSession: async () => ({ deleted: true }),
        clearSessions: async () => ({ cleared: true }),
      },
    },
    '../lib/agent-console-reuse': reuse,
    '../lib/agent-status': agentStatus,
    '../stores/agent-console-store': { useAgentConsoleStore },
    './agent-composer': { AgentComposer: 'AgentComposer' },
    './execution-timeline': { ExecutionTimeline: 'ExecutionTimeline' },
    './inspector-panel': { InspectorPanel: 'InspectorPanel' },
    './session-sidebar': { SessionSidebar: 'SessionSidebar' },
  })

  return {
    store,
    setHydrating(value) {
      hydrating = value
    },
    setQuery(value) {
      search = value
    },
    setActorId(value) {
      currentActorId = value
    },
    setSessions(value) {
      currentSessions = value
    },
    setRuntimeStatus({ connectionState: nextConn, turnActive: nextTurnActive, activeTurn: nextTurn, pendingApprovals: nextApprovals } = {}) {
      if (nextConn !== undefined) currentConnectionState = nextConn
      if (nextTurnActive !== undefined) currentTurnActive = nextTurnActive
      if (nextTurn !== undefined) currentActiveTurn = nextTurn
      if (nextApprovals !== undefined) currentPendingApprovals = nextApprovals
    },
    render() {
      effectIndex = 0
      stateCursor = 0
      refCursor = 0
      pending = []
      const tree = AgentConsoleView({ mode: currentMode })
      pending.forEach((commit) => commit())
      return tree
    },
    unmount() {
      effects.forEach((effect) => effect.cleanup?.())
      effects = []
      if (viewportWidth !== undefined) {
        if (hasPreviousWindow) {
          globalThis.window = previousWindow
        } else {
          delete globalThis.window
        }
      }
    },
    get capturedUseAgentConsoleArgs() {
      return capturedUseAgentConsoleArgs
    },
    get capturedCreateCalls() {
      return capturedCreateCalls
    },
  }
}

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null
  if (Array.isArray(tree)) {
    for (const item of tree) {
      const match = find(item, predicate)
      if (match) return match
    }
    return null
  }
  if (predicate(tree)) return tree
  if (typeof tree.type === 'function') {
    const rendered = tree.type(tree.props)
    const nested = find(rendered, predicate)
    if (nested) return nested
  }
  for (const child of [tree.props?.children].flat(Infinity)) {
    const match = find(child, predicate)
    if (match) return match
  }
  return null
}

function findAll(tree, predicate, results = []) {
  if (!tree || typeof tree !== 'object') return results
  if (Array.isArray(tree)) {
    for (const item of tree) {
      findAll(item, predicate, results)
    }
    return results
  }
  if (predicate(tree)) results.push(tree)
  if (typeof tree.type === 'function') {
    const rendered = tree.type(tree.props)
    findAll(rendered, predicate, results)
    return results
  }
  for (const child of [tree.props?.children].flat(Infinity)) {
    findAll(child, predicate, results)
  }
  return results
}

function textContent(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (typeof node === 'object' && node.props) return textContent(node.props.children)
  return ''
}

test('hydrating state renders skeleton without activating session, and ready tree drops canvas & metadata pills', () => {
  const app = setup({ query: '' })
  app.setHydrating(true)
  const skeletonTree = app.render()
  assert.equal(find(skeletonTree, (el) => el.type === 'header'), null)
  assert.ok(find(skeletonTree, (el) => el.props['aria-label'] === '正在加载工作区'))
  assert.equal(find(skeletonTree, (el) => el.type === 'ExecutionTimeline'), null)
  assert.equal(app.capturedUseAgentConsoleArgs.at(-1)?.sessionId, null)

  app.setHydrating(false)
  const readyTree = app.render()
  assert.equal(find(readyTree, (el) => el.props['aria-label'] === '正在加载工作区'), null)
  assert.equal(find(readyTree, (el) => el.type === 'header'), null)

  const sidebar = find(readyTree, (el) => el.type === 'SessionSidebar')
  const timeline = find(readyTree, (el) => el.type === 'ExecutionTimeline')
  const composer = find(readyTree, (el) => el.type === 'AgentComposer')
  const inspector = find(readyTree, (el) => el.type === 'InspectorPanel')
  assert.ok(sidebar)
  assert.ok(timeline)
  assert.ok(composer)
  assert.equal(inspector, null)

  assert.equal(typeof sidebar.props.onToggleSidebar, 'function')
  assert.equal(typeof sidebar.props.onReuseImage, 'function')
  assert.equal('canvases' in sidebar.props, false)
  assert.equal('onOpenCanvasInspector' in timeline.props, false)
  assert.equal(app.store.getState().leftSidebarOpen, true)
  assert.equal(find(readyTree, (el) => el.type === 'Badge'), null)

  const consoleSection = find(readyTree, (el) => el.type === 'section')
  const consoleText = textContent(consoleSection)
  assert.equal(consoleText.includes('Agent v'), false)
  assert.equal(consoleText.includes('rev '), false)
  assert.equal(consoleText.includes('实时同步'), false)
  assert.equal(consoleText.includes('未连接'), false)
  assert.equal(consoleText.includes('刷新'), false)
  assert.equal(consoleText.includes('检查器'), false)
  app.unmount()
})

test('floating corner controls show subtle status text only for active turns or degraded connection, and inline console dock renders pending approvals', () => {
  const app = setup({
    mode: 'live',
    sessions: [
      {
        id: 'session-1',
        ownerId: 'owner',
        agentDefinitionId: 'def-1',
        definitionVersion: 2,
        defaultCanvasId: null,
        activeTurnId: 'turn-1',
        inputRevision: '4',
        nextItemSequence: '3',
        nextEventCursor: '3',
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
        archivedAt: null,
      },
    ],
    connectionState: 'connected',
    turnActive: true,
    activeTurn: {
      id: 'turn-1',
      sessionId: 'session-1',
      status: 'running',
      engineVersion: 'agent-core-v1',
      revision: '1',
      inputRevision: '4',
      cancelRequestedAt: null,
      terminalAt: null,
      deadlineAt: '2026-01-05T00:05:00.000Z',
      error: null,
    },
    pendingApprovals: [{ id: 'approval-1', toolCallId: 'tool-1', status: 'pending', argumentsHash: 'hash' }],
  })
  app.store.getState().setActiveSessionId('session-1')
  const activeTree = app.render()
  assert.equal(find(activeTree, (el) => el.type === 'Badge'), null)
  assert.equal(find(activeTree, (el) => el.type === 'header'), null)
  const activeSectionText = textContent(find(activeTree, (el) => el.type === 'section'))
  assert.ok(activeSectionText.includes('推理中'))
  assert.equal(activeSectionText.includes('检查器'), false)
  assert.ok(activeSectionText.includes('待审批工具'))
  assert.ok(find(activeTree, (el) => el.props?.['aria-label'] === '待审批工具控制栏'))

  app.setRuntimeStatus({ connectionState: 'reconnecting', turnActive: true })
  const reconnectingSectionText = textContent(find(app.render(), (el) => el.type === 'section'))
  assert.ok(reconnectingSectionText.includes('重连中'))

  app.setRuntimeStatus({ connectionState: 'connected', turnActive: false, activeTurn: null, pendingApprovals: [] })
  const idleSectionText = textContent(find(app.render(), (el) => el.type === 'section'))
  assert.equal(idleSectionText.includes('推理中'), false)
  assert.equal(idleSectionText.includes('重连中'), false)
  assert.equal(idleSectionText.includes('实时同步'), false)
  assert.equal(idleSectionText.includes('检查器'), false)
  app.unmount()
})

test('unmount expires lastReuseQuery while keeping draftPrompt so revisiting same reuse link re-imports', () => {
  const app = setup({ query: 'prompt=素材A&kind=image' })
  app.render()
  assert.equal(app.store.getState().draftPrompt, '素材A')
  assert.notEqual(app.store.getState().lastReuseQuery, '')

  app.store.getState().setDraftPrompt('用户手工修改的草稿B')
  app.render()
  assert.equal(app.store.getState().draftPrompt, '用户手工修改的草稿B')

  app.unmount()
  assert.equal(app.store.getState().draftPrompt, '用户手工修改的草稿B')
  assert.equal(app.store.getState().lastReuseQuery, '')

  // Revisiting the exact same library reuse link imports 素材A again
  app.render()
  assert.equal(app.store.getState().draftPrompt, '素材A')

  // Image reuse query attaches reference image into draftAttachments
  app.setQuery('image=%2Fshowcase%2Fart-1.svg&assetId=asset-1&label=%E6%B0%B4%E4%B9%A1%E6%A0%B7%E7%89%87&kind=image')
  app.render()
  assert.equal(app.store.getState().draftAttachments.length, 1)
  assert.equal(app.store.getState().draftAttachments[0].url, '/showcase/art-1.svg')
  assert.equal(app.store.getState().draftAttachments[0].name, '水乡样片')
  assert.equal(app.store.getState().draftAttachments[0].source, 'library')
  app.unmount()
})

test('mock mode auto-selects MOCK_SEED_SESSION_ID when activeSessionId is null', () => {
  const otherId = '00000000-0000-4000-8000-000000000999'
  const sessions = [
    {
      id: otherId,
      ownerId: 'owner',
      agentDefinitionId: 'def-1',
      definitionVersion: 1,
      defaultCanvasId: null,
      activeTurnId: null,
      inputRevision: '0',
      nextItemSequence: '1',
      nextEventCursor: '1',
      createdAt: '2026-01-06T00:00:00.000Z',
      updatedAt: '2026-01-06T00:00:00.000Z',
      archivedAt: null,
    },
    {
      id: MOCK_SEED_SESSION_ID,
      ownerId: 'owner',
      agentDefinitionId: 'def-1',
      definitionVersion: 1,
      defaultCanvasId: null,
      activeTurnId: null,
      inputRevision: '1',
      nextItemSequence: '8',
      nextEventCursor: '8',
      createdAt: '2026-01-05T00:00:00.000Z',
      updatedAt: '2026-01-05T00:00:00.000Z',
      archivedAt: null,
    },
  ]
  const app = setup({ mode: 'mock', sessions })
  assert.equal(app.store.getState().activeSessionId, null)

  app.render()
  assert.equal(app.store.getState().activeSessionId, MOCK_SEED_SESSION_ID)

  // Explicit user selection is preserved across subsequent renders
  app.store.getState().setActiveSessionId(otherId)
  app.render()
  assert.equal(app.store.getState().activeSessionId, otherId)
  app.unmount()
})

test('actor switch resets transient console store state', () => {
  const app = setup({ mode: 'live', actorId: 'user-a' })
  app.render()
  app.store.getState().setActiveSessionId('session-a')
  app.store.getState().setDraftPrompt('用户A草稿')

  app.setActorId('user-b')
  app.render()
  assert.equal(app.store.getState().activeSessionId, null)
  assert.equal(app.store.getState().draftPrompt, '')
  app.unmount()
})

test('1090px keeps left sidebar inline without overlay blur', () => {
  const app = setup({ viewportWidth: 1090 })
  try {
    const tree = app.render()
    assert.equal(app.store.getState().leftSidebarOpen, true)

    // With left sidebar open, backdrop must be hidden at md (>=960px) so it never blurs inline content.
    const idleBackdrop = find(
      tree,
      (el) => el.type === 'div' && el.props['aria-hidden'] === 'true',
    )
    assert.ok(idleBackdrop)
    assert.ok(idleBackdrop.props.className.includes('md:hidden'))

    // Session selection at 1090px keeps the inline left sidebar docked.
    const sidebar = find(tree, (el) => el.type === 'SessionSidebar')
    sidebar.props.onCloseMobile()
    assert.equal(app.store.getState().leftSidebarOpen, true)
  } finally {
    app.unmount()
  }
})

test('mobile viewport (<960px) collapses left drawer on mount and closes via backdrop', () => {
  const app = setup({ viewportWidth: 375 })
  try {
    app.render()
    let tree = app.render()
    assert.equal(app.store.getState().leftSidebarOpen, false)
    assert.equal(
      find(tree, (el) => el.type === 'div' && el.props['aria-hidden'] === 'true'),
      null,
    )

    const leftToggle = find(
      tree,
      (el) => typeof el.props?.['aria-label'] === 'string' && el.props['aria-label'].includes('会话列表'),
    )
    leftToggle.props.onClick()
    tree = app.render()
    assert.equal(app.store.getState().leftSidebarOpen, true)

    const backdrop = find(
      tree,
      (el) => el.type === 'div' && el.props['aria-hidden'] === 'true',
    )
    backdrop.props.onClick()
    assert.equal(app.store.getState().leftSidebarOpen, false)
  } finally {
    app.unmount()
  }
})

test('onCreateSession creates and activates a new session directly without ID/version dialog', async () => {
  const app = setup({ mode: 'mock' })
  try {
    const tree = app.render()
    const sidebar = find(tree, (el) => el.type === 'SessionSidebar')
    const timeline = find(tree, (el) => el.type === 'ExecutionTimeline')
    const composer = find(tree, (el) => el.type === 'AgentComposer')

    assert.equal('definitionDraft' in sidebar.props, false)
    assert.equal('newSessionOpen' in sidebar.props, false)
    assert.equal('onOpenNewSession' in sidebar.props, false)
    assert.equal('onOpenNewSession' in timeline.props, false)
    assert.equal('onOpenNewSession' in composer.props, false)
    assert.equal(typeof sidebar.props.onCreateSession, 'function')
    assert.equal(typeof timeline.props.onCreateSession, 'function')
    assert.equal(typeof composer.props.onCreateSession, 'function')

    sidebar.props.onCreateSession()
    await Promise.resolve()
    await Promise.resolve()

    assert.deepEqual(app.capturedCreateCalls, [
      { agentDefinitionId: MOCK_AGENT_DEFINITION_ID, definitionVersion: 1 },
    ])
    assert.equal(
      app.store.getState().activeSessionId,
      '00000000-0000-4000-8000-000000000888',
    )
  } finally {
    app.unmount()
  }
})

function setupSidebar({ shell = null, sessions = [], serviceStatus = 'ready' } = {}) {
  const pushedRoutes = []
  let stateCursor = 0
  const stateSlots = []
  const appRoutes = loadModule('../../../shared/lib/app-routes.ts', {})
  const { SessionSidebar } = loadModule('./session-sidebar.tsx', {
    react: {
      useRef: (initial) => ({ current: initial }),
      useState: (initial) => {
        const idx = stateCursor++
        if (!(idx in stateSlots)) {
          stateSlots[idx] = typeof initial === 'function' ? initial() : initial
        }
        return [
          stateSlots[idx],
          (next) => {
            stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next
          },
        ]
      },
    },
    'react/jsx-runtime': jsxRuntime,
    'next/link': { __esModule: true, default: 'Link' },
    'next/navigation': {
      useRouter: () => ({
        push: (href) => pushedRoutes.push(href),
      }),
    },
    '@phosphor-icons/react': new Proxy({}, { get: (_target, name) => String(name) }),
    '@/features/workspace/components/workspace-shell-context': {
      useWorkspaceShell: () => shell,
    },
    '@/shared/components/brand-mark': { BrandMark: 'BrandMark' },
    '@/shared/components/ui': new Proxy(
      { iconSize: { xs: 'xs', sm: 'sm', md: 'md', lg: 'lg' } },
      { get: (target, name) => (name in target ? target[name] : String(name)) },
    ),
    '@/shared/hooks/useFlipList': { useFlipList: () => {} },
    '@/shared/lib/app-routes': appRoutes,
    '@/shared/lib/cn': { cn: (...values) => values.filter(Boolean).join(' ') },
    '@/shared/lib/format': { formatRelativeTime: () => '刚刚' },
    '../lib/agent-status': agentStatus,
  })

  return {
    pushedRoutes,
    render(props = {}) {
      stateCursor = 0
      return SessionSidebar({
        console: {
          sessions,
          sessionsQuery: { isPending: false, isFetchingNextPage: false, refetch: async () => {} },
          hasMoreSessions: false,
          loadMoreSessions() {},
          serviceStatus,
          error: null,
          reconnect() {},
          mutations: { createSession: { isPending: false } },
        },
        activeSessionId: null,
        onSelectSession() {},
        onCreateSession() {},
        ...props,
      })
    },
  }
}

test('SessionSidebar integrates navigation, theme toggle, and mock indicator without /account or /admin', () => {
  const sidebar = setupSidebar({ shell: null })
  let toggleCalls = 0
  const tree = sidebar.render({ onToggleSidebar: () => { toggleCalls += 1 } })

  assert.equal(find(tree, (el) => el.type === 'header'), null)
  assert.ok(find(tree, (el) => el.type === 'Link' && el.props.href === '/'))
  assert.ok(find(tree, (el) => el.type === 'Link' && el.props.href === '/generate'))
  assert.ok(find(tree, (el) => el.type === 'Link' && el.props.href === '/library'))
  assert.ok(find(tree, (el) => el.type === 'ThemeToggle'))

  const mockNote = find(tree, (el) => el.props?.role === 'note')
  assert.ok(mockNote)
  assert.ok(textContent(mockNote).includes('Mock 本地演示'))

  assert.equal(find(tree, (el) => el.props?.href === '/account'), null)
  assert.equal(find(tree, (el) => el.props?.href === '/admin'), null)
  assert.equal(find(tree, (el) => el.type === 'DropdownMenu'), null)

  const collapseBtn = find(tree, (el) => el.props?.['aria-label'] === '收起会话列表')
  assert.ok(collapseBtn)
  collapseBtn.props.onClick()
  assert.equal(toggleCalls, 1)
})

test('SessionSidebar renders account menu with /admin for admin and omits /admin for standard user in live mode', () => {
  let logoutCalls = 0
  let dismissCalls = 0
  const adminSidebar = setupSidebar({
    shell: {
      mode: 'live',
      user: { id: 'u-1', email: 'admin@muse.dev', role: 'admin' },
      loggingOut: false,
      logoutError: '退出失败',
      onLogout: () => { logoutCalls += 1 },
      onDismissLogoutError: () => { dismissCalls += 1 },
    },
  })

  const adminTree = adminSidebar.render()
  assert.equal(find(adminTree, (el) => el.props?.role === 'note'), null)
  assert.ok(find(adminTree, (el) => el.type === 'ThemeToggle'))

  const errorAlert = find(adminTree, (el) => el.props?.role === 'alert')
  assert.ok(errorAlert)
  assert.ok(textContent(errorAlert).includes('退出失败'))
  const dismissBtn = find(errorAlert, (el) => el.type === 'button')
  dismissBtn.props.onClick()
  assert.equal(dismissCalls, 1)

  const adminMenu = find(adminTree, (el) => el.type === 'DropdownMenu')
  assert.ok(adminMenu)
  const adminItems = adminMenu.props.items
  assert.deepEqual(adminItems.map((item) => item.id), ['account', 'admin', 'logout'])

  adminItems.find((item) => item.id === 'account').onSelect()
  adminItems.find((item) => item.id === 'admin').onSelect()
  adminItems.find((item) => item.id === 'logout').onSelect()
  assert.deepEqual(adminSidebar.pushedRoutes, ['/account', '/admin'])
  assert.equal(logoutCalls, 1)

  const userSidebar = setupSidebar({
    shell: {
      mode: 'live',
      user: { id: 'u-2', email: 'creator@muse.dev', role: 'user' },
      loggingOut: false,
      logoutError: null,
      onLogout() {},
      onDismissLogoutError() {},
    },
  })
  const userMenu = find(userSidebar.render(), (el) => el.type === 'DropdownMenu')
  assert.ok(userMenu)
  assert.deepEqual(userMenu.props.items.map((item) => item.id), ['account', 'logout'])
})

test('SessionSidebar supports activeRoute="library" with custom children and links 新建对话 to /generate while preserving mock/live boundaries', () => {
  const customChildren = { type: 'div', props: { 'data-testid': 'library-filters', children: '图库筛选控件' } }

  // Mock mode on /library
  const mockSidebar = setupSidebar({ shell: null })
  const mockTree = mockSidebar.render({
    console: undefined,
    activeSessionId: undefined,
    onSelectSession: undefined,
    onCreateSession: undefined,
    activeRoute: 'library',
    children: customChildren,
  })

  const generateNavLink = find(
    mockTree,
    (el) => el.type === 'Link' && el.props?.href === '/generate' && textContent(el).includes('操作台'),
  )
  const libraryNavLink = find(
    mockTree,
    (el) => el.type === 'Link' && el.props?.href === '/library' && textContent(el).includes('作品图库'),
  )
  assert.ok(generateNavLink)
  assert.equal(generateNavLink.props['aria-current'], undefined)
  assert.ok(libraryNavLink)
  assert.equal(libraryNavLink.props['aria-current'], 'page')

  const newSessionLink = find(
    mockTree,
    (el) => el.type === 'Link' && el.props?.href === '/generate' && textContent(el).includes('新建对话'),
  )
  assert.ok(newSessionLink)

  const renderedFilters = find(mockTree, (el) => el.props?.['data-testid'] === 'library-filters')
  assert.ok(renderedFilters)
  assert.equal(find(mockTree, (el) => textContent(el) === '最近对话'), null)
  assert.ok(find(mockTree, (el) => el.props?.role === 'note'))
  assert.equal(find(mockTree, (el) => el.type === 'DropdownMenu'), null)
  assert.equal(find(mockTree, (el) => el.props?.href === '/account'), null)
  assert.equal(find(mockTree, (el) => el.props?.href === '/admin'), null)

  // Live admin and live standard user on /library preserve account menu boundaries
  const liveAdminSidebar = setupSidebar({
    shell: {
      mode: 'live',
      user: { id: 'u-admin', email: 'admin@muse.dev', role: 'admin' },
      loggingOut: false,
      logoutError: null,
      onLogout() {},
      onDismissLogoutError() {},
    },
  })
  const liveAdminTree = liveAdminSidebar.render({
    console: undefined,
    onCreateSession: undefined,
    onSelectSession: undefined,
    activeRoute: 'library',
    children: customChildren,
  })
  assert.equal(find(liveAdminTree, (el) => el.props?.role === 'note'), null)
  const adminMenu = find(liveAdminTree, (el) => el.type === 'DropdownMenu')
  assert.ok(adminMenu)
  assert.deepEqual(adminMenu.props.items.map((item) => item.id), ['account', 'admin', 'logout'])

  const liveUserSidebar = setupSidebar({
    shell: {
      mode: 'live',
      user: { id: 'u-user', email: 'creator@muse.dev', role: 'user' },
      loggingOut: false,
      logoutError: null,
      onLogout() {},
      onDismissLogoutError() {},
    },
  })
  const liveUserTree = liveUserSidebar.render({
    console: undefined,
    onCreateSession: undefined,
    onSelectSession: undefined,
    activeRoute: 'library',
    children: customChildren,
  })
  const userMenu = find(liveUserTree, (el) => el.type === 'DropdownMenu')
  assert.ok(userMenu)
  assert.deepEqual(userMenu.props.items.map((item) => item.id), ['account', 'logout'])
})

test('SessionSidebar supports deleting, clearing, pinning, and inline renaming recent sessions', () => {
  const s1 = {
    id: MOCK_SEED_SESSION_ID,
    ownerId: 'u1',
    agentDefinitionId: MOCK_AGENT_DEFINITION_ID,
    definitionVersion: 1,
    defaultCanvasId: null,
    activeTurnId: null,
    inputRevision: '0',
    nextItemSequence: '1',
    nextEventCursor: '1',
    createdAt: '2026-01-05T00:00:00.000Z',
    updatedAt: '2026-01-05T00:00:00.000Z',
    archivedAt: null,
  }
  const s2 = {
    ...s1,
    id: '00000000-0000-4000-8000-000000004002',
    createdAt: '2026-01-06T00:00:00.000Z',
    updatedAt: '2026-01-06T00:00:00.000Z',
  }

  const sidebar = setupSidebar({ sessions: [s1, s2] })
  const deleted = []
  const pinned = []
  const renamed = []
  let cleared = 0

  // 1. Pinned s2 moves to top; seeded s1 gets smart title, s2 gets tail suffix #4002
  let tree = sidebar.render({
    activeSessionId: s1.id,
    pinnedSessionIds: [s2.id],
    sessionTitles: {},
    onDeleteSession: (id) => deleted.push(id),
    onClearSessions: () => { cleared += 1 },
    onTogglePinSession: (id) => pinned.push(id),
    onRenameSession: (id, title) => renamed.push([id, title]),
  })

  const items = findAll(tree, (el) => el.type === 'li')
  assert.equal(items.length, 2)
  assert.equal(items[0].props['data-flip-key'], s2.id)
  assert.ok(textContent(items[0]).includes('对话 #4002'))
  assert.equal(items[1].props['data-flip-key'], s1.id)
  assert.ok(textContent(items[1]).includes('晨雾水乡乌篷船写意参考样片'))

  // 2. Click hide, pin, and device-local clear buttons
  const deleteButtons = findAll(tree, (el) => el.props?.['aria-label'] === '在此设备隐藏对话')
  assert.equal(deleteButtons.length, 2)
  deleteButtons[1].props.onClick({ stopPropagation() {} })
  assert.deepEqual(deleted, [s1.id])

  const unpinBtn = find(tree, (el) => el.props?.['aria-label'] === '取消置顶对话')
  assert.ok(unpinBtn)
  unpinBtn.props.onClick({ stopPropagation() {} })
  assert.deepEqual(pinned, [s2.id])

  const clearBtn = find(tree, (el) => el.props?.['aria-label'] === '清空此设备上的对话')
  assert.ok(clearBtn)
  clearBtn.props.onClick()
  assert.equal(cleared, 0)

  tree = sidebar.render({
    activeSessionId: s1.id,
    pinnedSessionIds: [s2.id],
    sessionTitles: {},
    onDeleteSession: (id) => deleted.push(id),
    onClearSessions: () => { cleared += 1 },
    onTogglePinSession: (id) => pinned.push(id),
    onRenameSession: (id, title) => renamed.push([id, title]),
  })
  const confirmDialog = find(tree, (el) => el.type === 'Dialog' && el.props?.open === true && el.props?.title === '清空此设备上的对话')
  assert.ok(confirmDialog)
  const confirmClearBtn = find(confirmDialog.props.footer, (el) => el.type === 'Button' && textContent(el).includes('确认清空'))
  assert.ok(confirmClearBtn)
  confirmClearBtn.props.onClick()
  assert.equal(cleared, 1)

  // 3. Inline rename flow
  const renameBtns = findAll(tree, (el) => el.props?.['aria-label'] === '重命名对话')
  assert.equal(renameBtns.length, 2)
  renameBtns[0].props.onClick({ stopPropagation() {} })

  tree = sidebar.render({
    activeSessionId: s1.id,
    pinnedSessionIds: [s2.id],
    sessionTitles: {},
    onRenameSession: (id, title) => renamed.push([id, title]),
  })
  const editInput = find(tree, (el) => el.props?.['aria-label'] === '编辑对话名称')
  assert.ok(editInput)
  editInput.props.onChange({ target: { value: '江南煙雨专题构图' } })

  tree = sidebar.render({
    activeSessionId: s1.id,
    pinnedSessionIds: [s2.id],
    sessionTitles: {},
    onRenameSession: (id, title) => renamed.push([id, title]),
  })
  const saveBtn = find(tree, (el) => el.props?.['aria-label'] === '保存对话名称')
  assert.ok(saveBtn)
  saveBtn.props.onClick()
  assert.deepEqual(renamed, [[s2.id, '江南煙雨专题构图']])
})

test('right inspector panel toggles, shows pending approval badge when closed, and closes via Escape/backdrop on <1280px', () => {
  const app = setup({
    mode: 'live',
    viewportWidth: 1090,
    sessions: [
      {
        id: 'session-1',
        ownerId: 'owner',
        agentDefinitionId: 'def-1',
        definitionVersion: 1,
        defaultCanvasId: null,
        activeTurnId: null,
        inputRevision: '0',
        nextItemSequence: '0',
        nextEventCursor: '0',
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
        archivedAt: null,
      },
    ],
    pendingApprovals: [{ id: 'approval-1', toolCallId: 'tool-1', status: 'pending', argumentsHash: 'hash' }],
  })
  try {
    app.store.getState().setActiveSessionId('session-1')
    let tree = app.render()

    const toggleBtn = find(tree, (el) => el.props?.['aria-label'] === '展开检查器')
    assert.ok(toggleBtn)
    assert.equal(toggleBtn.props['aria-expanded'], false)
    const badge = find(tree, (el) => el.props?.['aria-label'] === '有 1 条待审批工具')
    assert.ok(badge)
    assert.equal(textContent(badge), '1')
    assert.equal(find(tree, (el) => el.type === 'InspectorPanel'), null)

    toggleBtn.props.onClick()
    assert.equal(app.store.getState().rightPanelOpen, true)

    tree = app.render()
    assert.equal(find(tree, (el) => el.props?.['aria-label'] === '展开检查器'), null)
    assert.equal(find(tree, (el) => el.props?.['aria-label'] === '有 1 条待审批工具'), null)

    const inspectorAside = find(tree, (el) => el.props?.['aria-label'] === 'Agent 检查器面板')
    assert.ok(inspectorAside)
    const inspector = find(inspectorAside, (el) => el.type === 'InspectorPanel')
    assert.ok(inspector)
    assert.equal(typeof inspector.props.onClose, 'function')

    let prevented = false
    globalThis.window.dispatchEvent({
      type: 'keydown',
      key: 'Escape',
      defaultPrevented: false,
      preventDefault() {
        prevented = true
      },
    })
    assert.equal(prevented, false)
    assert.equal(app.store.getState().rightPanelOpen, false)

    // Reopen and close via floating card backdrop click
    app.store.getState().setRightPanelOpen(true)
    tree = app.render()
    const rightBackdrop = find(
      tree,
      (el) => el.type === 'div' && el.props['data-inspector-backdrop'] === 'true',
    )
    assert.ok(rightBackdrop)
    rightBackdrop.props.onClick()
    assert.equal(app.store.getState().rightPanelOpen, false)
  } finally {
    app.unmount()
  }
})

test('empty composer renders inspiration starters and clicking fills draftPrompt, while Ctrl/Cmd+K opens left sidebar', () => {
  const app = setup({
    mode: 'live',
    viewportWidth: 1360,
    sessions: [
      {
        id: 'session-empty',
        ownerId: 'owner',
        agentDefinitionId: 'def-1',
        definitionVersion: 1,
        defaultCanvasId: null,
        activeTurnId: null,
        inputRevision: '0',
        nextItemSequence: '0',
        nextEventCursor: '0',
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
        archivedAt: null,
      },
    ],
  })
  try {
    app.store.getState().setActiveSessionId('session-empty')
    app.store.getState().setLeftSidebarOpen(false)
    const tree = app.render()

    const starterBtn = find(tree, (el) => el.type === 'button' && textContent(el) === '东方水墨意境')
    assert.ok(starterBtn)
    starterBtn.props.onClick()
    assert.equal(
      app.store.getState().draftPrompt,
      '晨雾笼罩的江南水乡古镇，一叶乌篷船缓缓划过平静水面，东方水墨写意风格，留白构图',
    )

    let prevented = false
    globalThis.window.dispatchEvent({
      type: 'keydown',
      key: 'k',
      ctrlKey: true,
      metaKey: false,
      defaultPrevented: false,
      preventDefault() {
        prevented = true
      },
    })
    assert.equal(prevented, true)
    assert.equal(app.store.getState().leftSidebarOpen, true)
  } finally {
    app.unmount()
  }
})

test('chat opens a scoped Artifact request, preserves local drafts while closed, and drops requests across sessions', () => {
  const app = setup({ mode: 'live', actorId: 'owner-a' })
  try {
    app.store.getState().setActiveSessionId('session-a')
    let tree = app.render()
    const timeline = find(tree, (el) => el.type === 'ExecutionTimeline')
    assert.equal(typeof timeline.props.onOpenArtifact, 'function')
    timeline.props.onOpenArtifact({ artifactId: 'text:item-a' })
    tree = app.render()
    let inspector = find(tree, (el) => el.type === 'InspectorPanel')
    assert.equal(inspector.props.artifactRequest.artifactId, 'text:item-a')
    const drafts = inspector.props.artifactDrafts
    drafts.set('owner-a:session-a:text:item-a', { body: 'private draft', anchor: { kind: 'whole' } })
    inspector.props.onClose()
    app.render()
    app.store.getState().setRightPanelOpen(true)
    tree = app.render()
    inspector = find(tree, (el) => el.type === 'InspectorPanel')
    assert.equal(inspector.props.artifactDrafts, drafts)
    assert.equal(inspector.props.artifactDrafts.get('owner-a:session-a:text:item-a').body, 'private draft')
    app.store.getState().setActiveSessionId('session-b')
    tree = app.render()
    assert.equal(find(tree, (el) => el.type === 'InspectorPanel').props.artifactRequest, undefined)
    app.setActorId('owner-b')
    app.render()
    assert.equal(drafts.size, 0)
  } finally {
    app.unmount()
  }
})
