import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { stepperState } from '../lib/stepper-state.ts'
import { isSetupStepComplete } from '../../features/setup/components/setup-state.ts'
import { createLoginRequestGate } from '../../features/auth/lib/login-request-state.ts'

const require = createRequire(import.meta.url)
const root = new URL('../../', import.meta.url)
function load(path, stubs = {}) {
  const file = new URL(path, root)
  const module = { exports: {} }
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  function dependencies(id) {
    if (id in stubs) return stubs[id]
    if (id === 'react' || id === 'react/jsx-runtime') return require(id)
    if (id === '@/shared/lib/cn') return { cn: (...args) => args.filter(Boolean).join(' ') }
    if (id === '@phosphor-icons/react') return { CheckIcon: () => React.createElement('svg', { 'data-icon': 'check' }) }
    if (id === '@/shared/lib/stepper-state') return { stepperState }
    if (id === './size') return { controlSquare: {}, iconSize: {} }
    throw new Error(`Unexpected import ${id} in ${path}`)
  }
  new Function('require', 'module', 'exports', compiled)(dependencies, module, module.exports)
  return module.exports
}

test('read-only setup completion requires every stored section, missing data is unknown', () => {
  const pending = { sections: { smtp: { status: 'complete' }, admin: { status: 'pending' }, providers: { status: 'complete' }, models: { status: 'pending' } } }
  assert.equal(isSetupStepComplete(['smtp', 'admin'], pending), false)
  assert.equal(isSetupStepComplete(['providers', 'models'], pending), false)
  assert.equal(isSetupStepComplete(['smtp'], pending), true)
  assert.equal(isSetupStepComplete(['site'], pending), false)
  assert.equal(isSetupStepComplete(['site'], null), false)
})

test('actual Stepper separates explicit completion, visited navigation and current', () => {
  assert.deepEqual(stepperState({ completed: false, visited: true }, 0, 4), { completed: false, current: false, navigable: true })
  assert.deepEqual(stepperState({ completed: false, visited: false }, 0, 4), { completed: false, current: false, navigable: false })
  assert.equal(stepperState({}, 0, 2).completed, true, 'legacy sequential consumers stay compatible')
  const { Stepper } = load('shared/components/ui/stepper.tsx')
  const html = renderToStaticMarkup(React.createElement(Stepper, {
    current: 2, onStepSelect() {}, steps: [
      { id: 'a', label: 'Visited, not complete', completed: false, visited: true },
      { id: 'b', label: 'Unvisited', completed: false, visited: false },
      { id: 'c', label: 'Current', completed: false, visited: true },
    ],
  }))
  assert.equal(html.includes('data-icon="check"'), false)
  assert.equal((html.match(/<button/g) ?? []).length, 1)
  assert.equal((html.match(/aria-current="step"/g) ?? []).length, 1)
})

test('login gate suppresses duplicate activation and rejects returned/edited/unmounted requests', () => {
  const gate = createLoginRequestGate()
  const first = gate.begin()
  assert.ok(first)
  assert.equal(gate.begin(), null, 'same-frame duplicate is blocked')
  gate.cancel()
  assert.equal(first.signal.aborted, true)
  assert.equal(gate.current(first.id), false)
  const second = gate.begin()
  assert.ok(second)
  gate.finish(first.id)
  assert.equal(gate.current(second.id), true, 'stale response cannot release current lock')
  gate.finish(second.id)
  assert.equal(gate.current(second.id), false)
  assert.ok(gate.begin(), 'new intentional request allowed after finish')
})

test('login response lost after input change cannot advance the new request', async () => {
  const gate = createLoginRequestGate()
  let resolveOld
  const old = gate.begin()
  const response = new Promise(resolve => { resolveOld = resolve })
  let applied = 0
  const oldResult = response.then(() => { if (gate.current(old.id)) applied++ })
  gate.cancel()
  const fresh = gate.begin()
  resolveOld()
  await oldResult
  assert.equal(applied, 0)
  assert.equal(gate.current(fresh.id), true)
  gate.cancel()
})

test('brand sizing inherits wrapper and only monochrome assets get dark filtering', () => {
  const { BrandMark } = load('shared/components/brand-mark.tsx')
  const html = renderToStaticMarkup(React.createElement(BrandMark, { variant: 'wordmark', className: 'h-6' }))
  assert.match(html, /h-6/)
  assert.match(html, /03_wordmark[^>]*class="h-full[^>]*dark:hidden/)
  assert.doesNotMatch(html, /03_wordmark[^>]*brightness/)
  assert.match(html, /04_monochrome[^>]*brightness-0 invert/)
  const primary = renderToStaticMarkup(React.createElement(BrandMark, { variant: 'primary' }))
  assert.doesNotMatch(primary, /brightness|invert/)
})

test('setup skeleton reserves the real title and seven-step track before its body', () => {
  const Surface = props => React.createElement('div', null, props.children)
  const { SetupWizardSkeleton } = load('features/setup/components/setup-wizard-skeleton.tsx', {
    '@/shared/components/ui': new Proxy({
      PageHeader: load('shared/components/ui/page-header.tsx').PageHeader,
      Skeleton: props => React.createElement('span', { 'data-skeleton': true, className: props.className }),
    }, { get: (object, key) => key in object ? object[key] : Surface }),
    '@/shared/components/content-frame': { ContentFrame: props => React.createElement('div', { className: props.className }, props.children) },
  })
  const html = renderToStaticMarkup(React.createElement(SetupWizardSkeleton))
  assert.match(html, /max-w-form flex-col gap-8/)
  assert.match(html, /<h1[^>]*><span class="invisible">系统初始化/)
  assert.equal((html.match(/<li/g) ?? []).length, 7, 'one placeholder per wizard step')
  assert.ok(html.indexOf('系统初始化') < html.indexOf('bg-tonal p-4'), 'title precedes the step body placeholder')
  assert.match(html, /h-\[var\(--control-md\)\] w-28/)
})

test('setup first read failure is visibly unknown, never fake pending/failed bootstrap', async () => {
  const stateModule = load('features/setup/lib/setup-wizard-state.ts')
  const { ApiError } = load('shared/services/client-api.ts')
  const queries = []
  const Surface = props => React.createElement('div', null, props.title, props.description, props.children, props.action)
  const requests = load('features/setup/lib/setup-requests.ts', {
    '@/shared/services/api': { api: async () => ({ success: false }), ApiError },
    '@musecanvas/contracts': { API_ENDPOINTS: { setup: { status: '/fixture-status', config: '/fixture-config', database: '/fixture-database', databaseTest: '/fixture-database/test' } } },
    './setup-wizard-state': stateModule,
  })
  const { SetupWizard } = load('features/setup/components/setup-wizard.tsx', {
    'next/link': { default: props => React.createElement('a', { href: props.href }, props.children) },
    'next/navigation': { useRouter: () => ({ replace() {} }), useSearchParams: () => new URLSearchParams('step=site') },
    '@tanstack/react-query': {
      useQueryClient: () => ({}),
      useQuery: options => {
        queries.push(options)
        const key = options.queryKey[1]
        if (key === 'status') return { data: undefined, error: new Error('fixture'), isError: true, isSuccess: false, isLoading: false, isFetching: false, refetch() {} }
        if (key === 'config') return { data: undefined, error: new ApiError('SETUP_SESSION_INVALID', '无初始化访问权限'), isError: true, isSuccess: false, isLoading: false, isFetching: false, refetch() {} }
        return { data: undefined, error: null, isError: false, isSuccess: false, isLoading: false, isFetching: false, refetch() {} }
      },
    },
    '@/shared/components/ui': new Proxy({ iconSize: { sm: '' }, buttonVariants: () => '' }, { get: (object, key) => key in object ? object[key] : Surface }),
    '@/shared/components/content-frame': { ContentFrame: Surface },
    '@/shared/components/brand-mark': { BrandMark: () => null },
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }),
    '../lib/setup-wizard-state': stateModule,
    '../lib/setup-requests': requests,
    './setup-wizard-skeleton': { SetupWizardSkeleton: () => null },
    './steps/claim-step': { ClaimStep: () => null },
    './steps/site-step': { SiteStep: () => null },
    './steps/smtp-step': { SmtpStep: () => null },
    './steps/admin-step': { AdminStep: () => null },
    './steps/database-step': { DatabaseStep: () => null },
    './steps/storage-step': { StorageStep: () => null },
    './steps/complete-step': { CompleteStep: () => null },
  })
  const html = renderToStaticMarkup(React.createElement(SetupWizard))
  assert.match(html, /无法读取初始化状态/)
  assert.match(html, /当前状态未知/)
  assert.doesNotMatch(html, /尚未完成|环境检查尚未通过|只读检查/, 'no pending badge, failed bootstrap or read-only label is rendered')
  const status = queries.find(query => query.queryKey[1] === 'status')
  assert.equal(status.retry, false)
  await assert.rejects(status.queryFn(), /无法读取初始化状态。请检查服务连接后重试。/)
})
