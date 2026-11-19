import assert from 'node:assert/strict'
import { test } from 'node:test'
import { componentHarness, nodes } from './isolated-ui-fixes-test-harness.mjs'

test('storage clear sends only the secret patch despite invalid drafts and preserves unrelated edits', () => {
  let mutations = []
  const sent = []
  let validations = 0
  let settings = {
    driver: 's3', status: 'configured', hasSecret: true, revision: 1,
    endpoint: 'https://saved.example', bucket: 'saved', signedUrlTtlSeconds: 600,
  }
  const harness = componentHarness(
    new URL('../../../features/admin/components/admin-settings-storage.tsx', import.meta.url),
    'AdminSettingsStorage',
    {
      '@tanstack/react-query': { useMutation: (options) => {
        mutations.push(options)
        return { isPending: false, mutate: (input) => { sent.push(input) } }
      } },
      '@/shared/components/ui/toast': { useToast: () => ({ toast: { success() {}, error() {} } }) },
      '@/shared/lib/format': { formatDateTime: () => '' },
      '@/features/admin/lib/admin-settings-forms': {
        STORAGE_DRIVER_OPTIONS: [{ value: 's3', label: 'S3' }],
        validateStorageForm: () => { validations++; return { endpoint: 'invalid draft' } },
      },
    },
  )
  const render = () => {
    mutations = []
    return harness.render({ settings, onSaved: (saved) => { settings = saved } })
  }
  let tree = render()
  harness.effects()
  tree = render()
  const endpoint = nodes(tree, (node) => node.props.placeholder === 'https://minio.example.com')[0]
  endpoint.props.onChange({ target: { value: 'invalid unsaved endpoint' } })
  tree = render()
  nodes(tree, (node) => node.props.confirmLabel === '清空密钥')[0].props.onConfirm()
  assert.equal(validations, 0)
  assert.equal(JSON.stringify(sent), JSON.stringify([{ secretAccessKey: '' }]))
  mutations[2].onSuccess({ ...settings, hasSecret: false, revision: 2 })
  tree = render()
  harness.effects()
  tree = render()
  assert.equal(nodes(tree, (node) => node.props.placeholder === 'https://minio.example.com')[0].props.value, 'invalid unsaved endpoint')
  // Normal save/test validation remains in force.
  nodes(tree, (node) => node.props.children === '保存存储设置')[0].props.onClick()
  assert.equal(validations, 1)
  assert.equal(sent.length, 1)
  // An unrelated settings refresh should still synchronize the form normally.
  settings = { ...settings, endpoint: 'https://external.example', revision: 3 }
  render()
  harness.effects()
  tree = render()
  assert.equal(nodes(tree, (node) => node.props.placeholder === 'https://minio.example.com')[0].props.value, 'https://external.example')
})

test('dropdown arrows traverse enabled positions and wrap; Home/End skip disabled edges', () => {
  for (const disabled of [[true, false, true, false, false, true], [false, true, false, true, false]]) {
    const harness = componentHarness(new URL('./dropdown-menu.tsx', import.meta.url), 'DropdownMenu')
    const tree = harness.render({ trigger: { type: 'button', props: {} }, open: true,
      items: disabled.map((value, i) => ({ label: String(i), disabled: value })) })
    const menu = nodes(tree, (node) => node.props.role === 'menu')[0]
    const items = nodes(tree, (node) => node.props.role === 'menuitem')
    const elements = items.map((item, i) => {
      const element = { index: i, focus() { harness.document.activeElement = element } }
      item.props.ref(element)
      return element
    })
    const enabled = elements.filter((_, index) => !disabled[index])
    const key = (value) => menu.props.onKeyDown({ key: value, preventDefault() {} })
    for (let i = 0; i < enabled.length; i++) {
      enabled[i].focus()
      key('ArrowDown')
      assert.equal(harness.document.activeElement, enabled[(i + 1) % enabled.length])
      enabled[i].focus()
      key('ArrowUp')
      assert.equal(harness.document.activeElement, enabled[(i - 1 + enabled.length) % enabled.length])
    }
    key('Home')
    assert.equal(harness.document.activeElement, enabled[0])
    key('End')
    assert.equal(harness.document.activeElement, enabled.at(-1))
  }
})

test('tabs keep every tab rendered in a width-constrained scrolling strip and keyboard reachable', () => {
  for (const variant of ['segment', 'underline']) {
    const changes = []
    const harness = componentHarness(new URL('./tabs.tsx', import.meta.url), 'Tabs')
    const tree = harness.render({ variant, value: '0', onChange: (id) => changes.push(id),
      tabs: Array.from({ length: 8 }, (_, i) => ({ id: String(i), label: `Settings ${i}` })) })
    assert.match(tree.props.className, /\bmin-w-0\b/)
    const list = nodes(tree, (node) => node.props.role === 'tablist')[0]
    for (const token of ['min-w-0', 'max-w-full', 'overflow-x-auto']) assert.ok(list.props.className.split(' ').includes(token))
    const tabs = nodes(tree, (node) => node.props.role === 'tab')
    assert.equal(tabs.length, 8)
    let focused
    tabs.forEach((tab, i) => tab.props.ref({ focus() { focused = i } }))
    tabs[0].props.onKeyDown({ key: 'End', preventDefault() {} })
    assert.equal(focused, 7)
    assert.equal(changes.at(-1), '7')
    tabs[7].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
    assert.equal(focused, 0)
  }
})

test('mobile nav backdrop closes explicitly while panel clicks retain overlay target guard', () => {
  let dialogOptions
  const harness = componentHarness(new URL('../public-mobile-nav.tsx', import.meta.url), 'PublicMobileNav', {
    'next/link': { __esModule: true, default: 'Link' },
    '@/shared/hooks/useDialog': { useDialog(options) {
      dialogOptions = options
      return { mounted: true, portalTarget: {}, phase: 'idle', labelId: 'label', closeButtonRef: {},
        overlayProps: { onClick: (event) => { if (event.target === event.currentTarget) options.onClose() } },
        dialogProps: { role: 'dialog' } }
    } },
    '@/shared/components/ui/button-variants': { buttonVariants: () => '' },
    '@/shared/lib/app-routes': { APP_ROUTES: { terms: '/terms', privacy: '/privacy', login: '/login', generate: '/generate' } },
  })
  let tree = harness.render()
  nodes(tree, (node) => node.props['aria-label'] === '打开导航菜单')[0].props.onClick()
  tree = harness.render()
  assert.equal(dialogOptions.open, true)
  const overlay = nodes(tree, (node) => node.props.className?.includes('fixed inset-0'))[0]
  const panel = nodes(tree, (node) => node.props.role === 'dialog')[0]
  overlay.props.onClick({ target: panel, currentTarget: overlay })
  tree = harness.render()
  assert.equal(dialogOptions.open, true)
  const backdrop = nodes(tree, (node) => node.props['aria-hidden'] === 'true' && node.props.className?.includes('bg-overlay/40'))[0]
  backdrop.props.onClick()
  harness.render()
  assert.equal(dialogOptions.open, false)
})

test('Capabilities renders CSS grid accordion with accessible open state toggles', () => {
  const harness = componentHarness(
    new URL('../../../features/landing/components/capabilities.tsx', import.meta.url),
    'Capabilities',
    {
      '@/shared/components/reveal': { Reveal: ({ children }) => children },
      '@/features/landing/components/landing-frame': { LandingFrame: ({ children }) => children },
      './landing-frame': { LandingFrame: ({ children }) => children },
    },
  )
  let tree = harness.render()
  const buttons = nodes(tree, (node) => node.type === 'button' && 'aria-expanded' in node.props)
  assert.equal(buttons.length, 6)
  assert.equal(buttons[0].props['aria-expanded'], true)
  assert.equal(buttons[1].props['aria-expanded'], false)

  const accordions = nodes(tree, (node) => node.props.className?.includes('motion-accordion') && !node.props.className?.includes('motion-accordion-inner'))
  assert.equal(accordions.length, 6)
  assert.equal(accordions[0].props['data-open'], 'true')
  assert.equal(accordions[1].props['data-open'], 'false')

  buttons[1].props.onClick()
  tree = harness.render()
  const updated = nodes(tree, (node) => node.props.className?.includes('motion-accordion') && !node.props.className?.includes('motion-accordion-inner'))
  assert.equal(updated[0].props['data-open'], 'false')
  assert.equal(updated[1].props['data-open'], 'true')
})

test('interaction pressable never overrides motion-press transform transition with transition-colors', async () => {
  const { pressable, motionPress } = await import('./interaction.ts')
  assert.equal(pressable, motionPress)
  assert.doesNotMatch(pressable, /\btransition-colors\b/)
})
