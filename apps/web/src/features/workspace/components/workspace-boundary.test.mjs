import assert from 'node:assert/strict'
import test from 'node:test'
import { APP_ROUTES } from '../../../shared/lib/app-routes.ts'
import { componentHarness, nodes } from '../../../shared/components/ui/isolated-ui-fixes-test-harness.mjs'

const layoutUrl = new URL('../../../app/(workspace)/(studio)/layout.tsx', import.meta.url)

function layoutHarness(mode, getSessionUser) {
  return componentHarness(layoutUrl, 'default', {
    '@/shared/lib/workspace-mode': { WORKSPACE_MODE: mode },
    '@/shared/services/server-api': { getSessionUser },
    '@/shared/lib/app-routes': { APP_ROUTES },
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
    'next/link': { __esModule: true, default: 'Link' },
    '@/shared/hooks/useAuth': {
      useAuth: () => ({ logout: async () => ({ loggedOut: true }) }),
    },
    '@/shared/lib/app-routes': { APP_ROUTES },
  })
}

test('explicit mock studio does not read or fabricate an authenticated session', async () => {
  const harness = layoutHarness('mock', () => assert.fail('mock preview must not query authentication'))
  const rendered = await harness.render({ children: 'studio-content' })
  assert.equal(rendered.props.mode, 'mock')
  assert.equal(rendered.props.user, null)
  assert.equal(rendered.props.children, 'studio-content')
})

test('live studio rejects anonymous users and preserves authenticated actors', async () => {
  await assert.rejects(layoutHarness('live', async () => null).render({ children: null }), /REDIRECT:\/login\?from=%2Fgenerate/)
  const user = { id: 'real-session-user', email: 'artist@example.invalid', role: 'user', status: 'active' }
  const rendered = await layoutHarness('live', async () => user).render({ children: null })
  assert.equal(rendered.props.mode, 'live')
  assert.equal(rendered.props.user, user)
})

test('live studio propagates upstream failures instead of silently falling back to mock', async () => {
  const unavailable = new Error('UPSTREAM_UNAVAILABLE')
  await assert.rejects(layoutHarness('live', async () => { throw unavailable }).render({ children: null }), (error) => error === unavailable)
})

test('headerless studio shell applies full-bleed h-dvh layout on /generate and /library while providing session context', () => {
  const adminUser = {
    id: 'admin-1',
    email: 'admin@example.invalid',
    role: 'admin',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const regularUser = { ...adminUser, id: 'user-1', role: 'user' }

  for (const pathname of [APP_ROUTES.generate, APP_ROUTES.library]) {
    const harness = shellHarness(pathname)
    for (const scenario of [
      { mode: 'live', user: adminUser },
      { mode: 'live', user: regularUser },
      { mode: 'mock', user: null },
    ]) {
      const rendered = harness.render({ ...scenario, children: 'studio-content' })
      assert.equal(nodes(rendered, (node) => node.type === 'header').length, 0)
      assert.equal(nodes(rendered, (node) => node.props.role === 'note').length, 0)
      assert.equal(nodes(rendered, (node) => node.props.role === 'alert').length, 0)
      assert.equal(nodes(rendered, (node) => node.props.id === 'workspace-mobile-nav').length, 0)
      assert.equal(nodes(rendered, (node) => node.type === 'WorkspaceJobObserver').length, 1)
      assert.equal(nodes(rendered, (node) => node.props.href === '#workspace-main').length, 1)
      assert.equal(nodes(rendered, (node) => node.props.href === APP_ROUTES.account).length, 0)
      assert.equal(nodes(rendered, (node) => node.props.href === APP_ROUTES.admin).length, 0)

      const providers = nodes(rendered, (node) => node.type === 'WorkspaceShellProvider')
      assert.equal(providers.length, 1)
      assert.equal(providers[0].props.value.mode, scenario.mode)
      assert.equal(providers[0].props.value.user, scenario.user)
      assert.equal(providers[0].props.value.loggingOut, false)
      assert.equal(providers[0].props.value.logoutError, null)
      assert.equal(typeof providers[0].props.value.onLogout, 'function')
      assert.equal(typeof providers[0].props.value.onDismissLogoutError, 'function')

      const containers = nodes(rendered, (node) => node.type === 'div' && (node.props.className ?? '').split(/\s+/).includes('h-dvh'))
      assert.equal(containers.length, 1)
      assert.match(containers[0].props.className, /\boverflow-hidden\b/)

      const mains = nodes(rendered, (node) => node.props.id === 'workspace-main')
      assert.equal(mains.length, 1)
      assert.match(mains[0].props.className, /\boverflow-hidden\b/)
      assert.equal(mains[0].props.children, 'studio-content')
    }
  }
})

test('headerless account shell uses min-h-dvh and boxed content padding when not full-bleed', () => {
  const user = {
    id: 'user-1',
    email: 'artist@example.invalid',
    role: 'user',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
  }

  for (const config of [
    { pathname: APP_ROUTES.account, fullBleed: undefined },
    { pathname: APP_ROUTES.library, fullBleed: false },
  ]) {
    const harness = shellHarness(config.pathname)
    const rendered = harness.render({ mode: 'live', user, fullBleed: config.fullBleed, children: 'account-content' })
    assert.equal(nodes(rendered, (node) => node.type === 'header').length, 0)
    assert.equal(nodes(rendered, (node) => node.props.role === 'note').length, 0)
    assert.equal(nodes(rendered, (node) => node.props.role === 'alert').length, 0)
    assert.equal(nodes(rendered, (node) => node.type === 'WorkspaceJobObserver').length, 1)
    assert.equal(nodes(rendered, (node) => node.props.href === '#workspace-main').length, 1)

    const providers = nodes(rendered, (node) => node.type === 'WorkspaceShellProvider')
    assert.equal(providers.length, 1)
    assert.equal(providers[0].props.value.mode, 'live')
    assert.equal(providers[0].props.value.user, user)
    assert.equal(typeof providers[0].props.value.onLogout, 'function')

    const containers = nodes(rendered, (node) => node.type === 'div' && (node.props.className ?? '').split(/\s+/).includes('min-h-dvh'))
    assert.equal(containers.length, 1)
    assert.equal(containers[0].props.className.split(/\s+/).includes('h-dvh'), false)

    const mains = nodes(rendered, (node) => node.props.id === 'workspace-main')
    assert.equal(mains.length, 1)
    assert.match(mains[0].props.className, /max-w-\[var\(--container-content\)\]/)
    assert.equal(/\boverflow-hidden\b/.test(mains[0].props.className), false)
    assert.equal(mains[0].props.children, 'account-content')
  }
})
