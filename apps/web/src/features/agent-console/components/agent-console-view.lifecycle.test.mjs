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
  let effects = []
  let pending = []
  let effectIndex = 0
  let stateCursor = 0
  const stateSlots = []
  let refCursor = 0
  const refSlots = []
  const capturedUseAgentConsoleArgs = []
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
          createSession: async () => selectedSession,
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
    '@/shared/lib/cn': { cn: (...values) => values.filter(Boolean).join(' ') },
    '@/shared/services/api': { isApiError: () => false },
    '@/shared/services/mock-agent-api': { MOCK_SEED_SESSION_ID },
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
  assert.ok(find(skeletonTree, (el) => el.props['aria-label'] === '正在加载工作区'))
  assert.equal(find(skeletonTree, (el) => el.type === 'ExecutionTimeline'), null)
  assert.equal(app.capturedUseAgentConsoleArgs.at(-1)?.sessionId, null)

  app.setHydrating(false)
  const readyTree = app.render()
  assert.equal(find(readyTree, (el) => el.props['aria-label'] === '正在加载工作区'), null)

  const sidebar = find(readyTree, (el) => el.type === 'SessionSidebar')
  const timeline = find(readyTree, (el) => el.type === 'ExecutionTimeline')
  const composer = find(readyTree, (el) => el.type === 'AgentComposer')
  const inspector = find(readyTree, (el) => el.type === 'InspectorPanel')
  assert.ok(sidebar)
  assert.ok(timeline)
  assert.ok(composer)
  assert.ok(inspector)

  assert.equal('canvases' in sidebar.props, false)
  assert.equal('onOpenCanvasInspector' in timeline.props, false)
  assert.equal('canvases' in inspector.props, false)
  assert.equal('selectedCanvasId' in inspector.props, false)
  assert.equal('onSelectCanvasId' in inspector.props, false)
  assert.equal(app.store.getState().leftSidebarOpen, true)
  assert.equal(app.store.getState().rightPanelOpen, false)
  assert.equal(app.store.getState().rightPanelTab, 'artifacts')
  assert.equal(find(readyTree, (el) => el.type === 'Badge'), null)

  const header = find(readyTree, (el) => el.type === 'header')
  const headerText = textContent(header)
  assert.equal(headerText.includes('Agent v'), false)
  assert.equal(headerText.includes('rev '), false)
  assert.equal(headerText.includes('实时同步'), false)
  assert.equal(headerText.includes('未连接'), false)
  assert.ok(headerText.includes('刷新'))
  assert.ok(headerText.includes('检查器'))
  app.unmount()
})

test('center toolbar shows subtle status text only for active turns or degraded connection, and plain approval count', () => {
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
    pendingApprovals: [{ id: 'approval-1', status: 'pending', argumentsHash: 'hash' }],
  })
  app.store.getState().setActiveSessionId('session-1')
  const activeTree = app.render()
  assert.equal(find(activeTree, (el) => el.type === 'Badge'), null)
  const activeHeaderText = textContent(find(activeTree, (el) => el.type === 'header'))
  assert.ok(activeHeaderText.includes('当前会话'))
  assert.ok(activeHeaderText.includes('推理中'))
  assert.ok(activeHeaderText.includes('检查器 (1)'))

  app.setRuntimeStatus({ connectionState: 'reconnecting', turnActive: true })
  const reconnectingHeaderText = textContent(find(app.render(), (el) => el.type === 'header'))
  assert.ok(reconnectingHeaderText.includes('重连中'))

  app.setRuntimeStatus({ connectionState: 'connected', turnActive: false, activeTurn: null, pendingApprovals: [] })
  const idleHeaderText = textContent(find(app.render(), (el) => el.type === 'header'))
  assert.equal(idleHeaderText.includes('推理中'), false)
  assert.equal(idleHeaderText.includes('重连中'), false)
  assert.equal(idleHeaderText.includes('实时同步'), false)
  assert.equal(idleHeaderText.includes('检查器 ('), false)
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
  app.unmount()
})

test('navigating with ?panel=artifacts or ?panel=tools opens inspector, while ?panel=canvas is ignored', () => {
  const app = setup({ query: 'panel=artifacts' })
  app.store.getState().setRightPanelOpen(false)
  app.store.getState().setRightPanelTab('tools')

  app.render()
  assert.equal(app.store.getState().rightPanelTab, 'artifacts')
  assert.equal(app.store.getState().rightPanelOpen, true)

  app.store.getState().setRightPanelOpen(false)
  app.setQuery('panel=tools')
  app.render()
  assert.equal(app.store.getState().rightPanelTab, 'tools')
  assert.equal(app.store.getState().rightPanelOpen, true)

  app.store.getState().setRightPanelOpen(false)
  app.setQuery('panel=canvas')
  app.render()
  assert.equal(app.store.getState().rightPanelTab, 'tools')
  assert.equal(app.store.getState().rightPanelOpen, false)
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

test('1090px keeps left sidebar inline without overlay blur, while right inspector overlays gracefully', () => {
  const app = setup({ viewportWidth: 1090 })
  try {
    let tree = app.render()
    assert.equal(app.store.getState().leftSidebarOpen, true)
    assert.equal(app.store.getState().rightPanelOpen, false)

    // With only left sidebar open, backdrop must be hidden at md (>=960px) so it never blurs inline content.
    const idleBackdrop = find(
      tree,
      (el) => el.type === 'div' && el.props['aria-hidden'] === 'true',
    )
    assert.ok(idleBackdrop)
    assert.ok(idleBackdrop.props.className.includes('md:hidden'))
    assert.equal(idleBackdrop.props.className.includes('lg:hidden'), false)

    // Session selection at 1090px keeps the inline left sidebar docked.
    const sidebar = find(tree, (el) => el.type === 'SessionSidebar')
    sidebar.props.onCloseMobile()
    assert.equal(app.store.getState().leftSidebarOpen, true)

    // Opening inspector overlays on the right edge without closing the inline left sidebar.
    const inspectorToggle = find(
      tree,
      (el) => typeof el.props?.['aria-label'] === 'string' && el.props['aria-label'].includes('检查器面板'),
    )
    inspectorToggle.props.onClick()
    tree = app.render()
    assert.equal(app.store.getState().leftSidebarOpen, true)
    assert.equal(app.store.getState().rightPanelOpen, true)

    const overlayBackdrop = find(
      tree,
      (el) => el.type === 'div' && el.props['aria-hidden'] === 'true',
    )
    assert.ok(overlayBackdrop)
    assert.ok(overlayBackdrop.props.className.includes('lg:hidden'))
    assert.equal(overlayBackdrop.props.className.includes('md:hidden'), false)

    // Clicking the backdrop closes only the right drawer, leaving inline left sidebar intact.
    overlayBackdrop.props.onClick()
    assert.equal(app.store.getState().rightPanelOpen, false)
    assert.equal(app.store.getState().leftSidebarOpen, true)
  } finally {
    app.unmount()
  }
})

test('mobile viewport (<960px) collapses drawers on mount and enforces mutual exclusion', () => {
  const app = setup({ viewportWidth: 375 })
  try {
    app.render()
    let tree = app.render()
    assert.equal(app.store.getState().leftSidebarOpen, false)
    assert.equal(app.store.getState().rightPanelOpen, false)
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
    assert.equal(app.store.getState().rightPanelOpen, false)

    const rightToggle = find(
      tree,
      (el) => typeof el.props?.['aria-label'] === 'string' && el.props['aria-label'].includes('检查器面板'),
    )
    rightToggle.props.onClick()
    tree = app.render()
    assert.equal(app.store.getState().leftSidebarOpen, false)
    assert.equal(app.store.getState().rightPanelOpen, true)

    const backdrop = find(
      tree,
      (el) => el.type === 'div' && el.props['aria-hidden'] === 'true',
    )
    backdrop.props.onClick()
    assert.equal(app.store.getState().leftSidebarOpen, false)
    assert.equal(app.store.getState().rightPanelOpen, false)
  } finally {
    app.unmount()
  }
})
