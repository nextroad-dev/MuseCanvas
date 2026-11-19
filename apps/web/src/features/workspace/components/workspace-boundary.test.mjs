import assert from 'node:assert/strict'
import test from 'node:test'
import { APP_ROUTES, isOnGenerate, loginHref } from '../../../shared/lib/app-routes.ts'
import { componentHarness, nodes } from '../../../shared/components/ui/isolated-ui-fixes-test-harness.mjs'

const layoutUrl = new URL('../../../app/(workspace)/(studio)/layout.tsx', import.meta.url)

function layoutHarness(mode, getSessionUser) {
  return componentHarness(layoutUrl, 'default', {
    '@/shared/lib/workspace-mode': { WORKSPACE_MODE: mode },
    '@/shared/services/server-api': { getSessionUser },
    '@/shared/lib/app-routes': { APP_ROUTES, loginHref },
    '@/features/workspace/components/workspace-shell': { WorkspaceShell: 'WorkspaceShell' },
    'next/navigation': { redirect: (location) => { throw new Error(`REDIRECT:${location}`) } },
  })
}

function shellHarness(pathname = APP_ROUTES.library, router = { push() {}, replace() {}, refresh() {} }) {
  return componentHarness(new URL('./workspace-shell.tsx', import.meta.url), 'WorkspaceShell', {
    'next/navigation': {
      usePathname: () => pathname,
      useRouter: () => router,
    },
    '@/shared/components/shells': { AppShell: 'AppShell' },
    '@/shared/hooks/useAuth': {
      useAuth: () => ({ logout: async () => ({ loggedOut: true }) }),
    },
    '@/shared/lib/app-routes': { APP_ROUTES, isOnGenerate },
  })
}

test('explicit mock studio does not read or fabricate an authenticated session', async () => {
  const harness = layoutHarness('mock', () => assert.fail('mock preview must not query authentication'))
  const rendered = await harness.render({ children: 'studio-content' })
  assert.equal(rendered.props.mode, 'mock')
  assert.equal(rendered.props.user, null)
  assert.equal(rendered.props.children, 'studio-content')
})

test('live studio rejects anonymous users with loginHref(?next=) and preserves authenticated actors', async () => {
  await assert.rejects(layoutHarness('live', async () => null).render({ children: null }), /REDIRECT:\/login\?next=%2Fgenerate/)
  const user = { id: 'real-session-user', email: 'artist@example.invalid', role: 'user', status: 'active' }
  const rendered = await layoutHarness('live', async () => user).render({ children: null })
  assert.equal(rendered.props.mode, 'live')
  assert.equal(rendered.props.user, user)
})

test('live studio propagates upstream failures instead of silently falling back to mock', async () => {
  const unavailable = new Error('UPSTREAM_UNAVAILABLE')
  await assert.rejects(layoutHarness('live', async () => { throw unavailable }).render({ children: null }), (error) => error === unavailable)
})

test('WorkspaceShell wraps /generate in fullBleed AppShell with sidebarSlot support and mounts WorkspaceJobObserver', () => {
  const adminUser = {
    id: 'admin-1',
    email: 'admin@example.invalid',
    role: 'admin',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const regularUser = { ...adminUser, id: 'user-1', role: 'user' }

  for (const pathname of [APP_ROUTES.generate, '/agent/sessions/session-1']) {
    const harness = shellHarness(pathname)
    for (const scenario of [
      { mode: 'live', user: adminUser },
      { mode: 'live', user: regularUser },
      { mode: 'mock', user: null },
    ]) {
      const rendered = harness.render({ ...scenario, children: 'studio-content' })
      assert.equal(nodes(rendered, (node) => node.type === 'WorkspaceJobObserver').length, 1)

      const providers = nodes(rendered, (node) => node.type === 'WorkspaceShellProvider')
      assert.equal(providers.length, 1)
      assert.equal(providers[0].props.value.mode, scenario.mode)
      assert.equal(providers[0].props.value.user, scenario.user)
      assert.equal(providers[0].props.value.loggingOut, false)
      assert.equal(providers[0].props.value.logoutError, null)
      assert.equal(typeof providers[0].props.value.onLogout, 'function')
      assert.equal(typeof providers[0].props.value.onDismissLogoutError, 'function')
      assert.equal(typeof providers[0].props.value.setSidebarSlot, 'function')
      assert.equal(typeof providers[0].props.value.setHeaderSlot, 'function')

      const shells = nodes(rendered, (node) => node.type === 'AppShell')
      assert.equal(shells.length, 1)
      assert.equal(shells[0].props.mode, scenario.mode)
      assert.equal(shells[0].props.user, scenario.user)
      assert.equal(shells[0].props.fullBleed, true)
      assert.equal(shells[0].props.headerTitle, '创作台')
      assert.equal(shells[0].props.children, 'studio-content')
    }
  }
})

test('WorkspaceShell wraps /library and non-generate routes in boxed AppShell matching /account chrome', () => {
  const user = {
    id: 'user-1',
    email: 'artist@example.invalid',
    role: 'user',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
  }

  for (const config of [
    { pathname: APP_ROUTES.library, fullBleed: undefined, expectedTitle: '作品图库' },
    { pathname: APP_ROUTES.account, fullBleed: undefined, expectedTitle: undefined },
    { pathname: APP_ROUTES.generate, fullBleed: false, expectedTitle: '创作台' },
  ]) {
    const harness = shellHarness(config.pathname)
    const rendered = harness.render({ mode: 'live', user, fullBleed: config.fullBleed, children: 'workspace-content' })
    assert.equal(nodes(rendered, (node) => node.type === 'WorkspaceJobObserver').length, 1)

    const providers = nodes(rendered, (node) => node.type === 'WorkspaceShellProvider')
    assert.equal(providers.length, 1)
    assert.equal(providers[0].props.value.mode, 'live')
    assert.equal(providers[0].props.value.user, user)

    const shells = nodes(rendered, (node) => node.type === 'AppShell')
    assert.equal(shells.length, 1)
    assert.equal(shells[0].props.fullBleed, false)
    assert.equal(shells[0].props.headerTitle, config.expectedTitle)
    assert.equal(shells[0].props.children, 'workspace-content')
  }
})
