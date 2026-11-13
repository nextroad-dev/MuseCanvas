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

test('mock shell names the preview honestly and never exposes an account link', () => {
  const harness = componentHarness(new URL('./workspace-shell.tsx', import.meta.url), 'WorkspaceShell', {
    'next/navigation': { usePathname: () => APP_ROUTES.library },
    'next/link': { __esModule: true, default: 'Link' },
    '@/shared/lib/app-routes': { APP_ROUTES },
  })
  const rendered = harness.render({ mode: 'mock', user: null, children: 'gallery' })
  assert.equal(nodes(rendered, (node) => node.props.href === APP_ROUTES.account).length, 0)
  assert.equal(nodes(rendered, (node) => node.props['aria-current'] === 'page' && node.props.href === APP_ROUTES.library).length, 1)
  assert.equal(nodes(rendered, (node) => node.props.role === 'note').length, 1)
  assert.equal(nodes(rendered, (node) => node.props.id === 'workspace-main').length, 1)
})
