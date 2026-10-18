import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const read = (name) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8')

// Transpile a dependency-free TS module (constants only) to CommonJS for the render harness.
function loadTs(relativePath) {
  const compiled = ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports)
  return module.exports
}

// Render the actual view branches, with inert UI/mutation seams and fixture query
// states. These prove cached-data visibility, not browser geometry or interaction.
function renderView(name, exportName, data, error = null, props = {}) {
  function Surface(props) {
    return React.createElement('div', null, props.title, props.description, props.summary,
      props.children, props.actions, props.filters, props.filterActions, props.action)
  }
  const ui = new Proxy({
    Dialog: () => null,
    useToast: () => ({ push() {} }),
    buttonVariants: () => '',
    iconSize: { sm: '', xs: '' },
    controlSquare: { sm: '' },
  }, { get: (target, key) => key in target ? target[key] : Surface })
  const actions = { errors: {}, isPending: () => false, isToggleBlocked: () => false }
  function load(moduleName) {
    const compiled = ts.transpileModule(read(moduleName), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const module = { exports: {} }
    function resolve(id) {
      if (id === 'react' || id === 'react/jsx-runtime') return require(id)
      if (id === '@tanstack/react-query') return {
        useQuery: () => ({ data, error, isError: !!error, isLoading: false, isFetching: false, refetch() {} }),
        useQueryClient: () => ({ invalidateQueries() {} }),
        useMutation: () => ({ isPending: false, mutate() {} }),
      }
      if (id === '@musecanvas/contracts') return { API_ENDPOINTS: { admin: {} } }
      if (id === '@phosphor-icons/react') return new Proxy({}, { get: () => () => React.createElement('svg') })
      if (id.startsWith('@/shared/components/ui')) return ui
      if (id === '@/shared/services/api') return { api: () => { throw new Error('Unexpected network call') } }
      if (id === '../lib/use-admin-actions') return { useAdminActions: () => actions }
      if (id === '../lib/admin-list-state') return { searchAdminPromptTemplates: (entries) => entries }
      if (id === '../lib/plugin-upload') return { humanFileSize: () => '1 KiB', resolveApiUrl: (value) => value, shortDigest: (value) => value }
      if (id === './admin-query-feedback') return load('admin-query-feedback')
      // Pure class-string constants: load the real module so className values are strings.
      if (id === '../lib/admin-layout') return loadTs('../lib/admin-layout.ts')
      if (id.startsWith('./') || id.startsWith('../lib/')) return new Proxy({}, { get: () => Surface })
      throw new Error(`Unexpected import ${id}`)
    }
    new Function('require', 'module', 'exports', compiled)(resolve, module, module.exports)
    return module.exports
  }
  return renderToStaticMarkup(React.createElement(load(name)[exportName], props))
}

const fixtures = [
  ['admin-oauth-view', 'AdminOAuthView', [{ provider: 'github', label: 'Cached GitHub', source: 'environment', enabled: true, redirectUri: 'https://example.test/callback' }], 'Cached GitHub', 'OAuth 提供商刷新失败'],
  ['admin-prompt-templates-view', 'AdminPromptTemplatesView', { id: 'set', name: 'Set', version: 2, entryCount: 1, entries: [{ id: 'entry', name: 'Cached template', description: 'Cached description', instruction: 'Cached instruction' }] }, 'Cached template', '提示词模板刷新失败'],
  ['admin-installed-plugins', 'AdminInstalledPlugins', [{ id: 'plugin', kind: 'media', displayName: 'Cached plugin', pluginId: 'sample', pluginVersion: '1', status: 'active', artifactSizeBytes: 1024, manifest: {} }], 'Cached plugin', '已安装插件刷新失败'],
]

for (const [name, exportName, data, marker, feedback] of fixtures) {
  const props = name === 'admin-installed-plugins' ? { kind: 'media' } : {}
  test(`${name}: refresh error keeps cached records and stale feedback`, () => {
    const html = renderView(name, exportName, data, new Error('Refresh fixture failed'), props)
    assert.ok(html.includes(marker), html)
    assert.ok(html.includes(feedback), html)
    assert.ok(html.includes('仍显示上次成功的数据'), html)
  })
  test(`${name}: first failure shows error, not first-use records`, () => {
    const html = renderView(name, exportName, undefined, new Error('Initial fixture failed'), props)
    assert.ok(html.includes('无法加载'), html)
    assert.equal(html.includes(marker), false)
  })
  test(`${name}: a cached empty result still has stale feedback on refresh failure`, () => {
    const empty = name === 'admin-prompt-templates-view' ? null : []
    const html = renderView(name, exportName, empty, new Error('Empty refresh fixture failed'), props)
    assert.ok(html.includes(feedback), html)
    assert.ok(html.includes('仍显示上次成功的数据'), html)
    assert.equal(html.includes(marker), false)
    assert.equal(html.includes('无法加载'), false)
  })
}

function source(name) {
  return ts.createSourceFile(name, read(name), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}
function matching(root, predicate) {
  const results = []
  function visit(node) { if (predicate(node)) results.push(node); ts.forEachChild(node, visit) }
  visit(root)
  return results
}
function tags(root, name) {
  return matching(root, (node) => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === name)
}
function attribute(tag, name) { return tag.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText() === name) }

test('admin-installed-plugins: only uncached errors replace records; all screens use summary/detail', () => {
  const text = read('admin-installed-plugins')
  assert.match(text, /error && pluginsData === undefined/)
  assert.match(text, /pluginsData !== undefined && <AdminQueryFeedback/)
  assert.doesNotMatch(text, /md:hidden|md:flex|md:block/)
  assert.equal(tags(source('admin-installed-plugins'), 'PluginRecordDetails').length, 1, 'full package content belongs only to its dialog')
})

test('settings panels persist, visible tabs replace the second rail, fields use their own container', () => {
  const text = read('admin-settings-view')
  assert.doesNotMatch(text, /w-settings-nav|md:hidden|sectionGroups/)
  assert.match(text, /lazy=\{false\}/)
  assert.match(text, /listClassName="max-w-full overflow-x-auto"/)
  assert.match(text, /@min-\[560px\]\/fields:grid-cols-2/)
  assert.match(text, /sticky bottom-0/)
  assert.match(text, /未保存/)
})

test('canvas agent settings mount as a settings tab and save through the real contract without a connectivity probe', () => {
  const section = read('admin-canvas-agent-settings')
  const settings = read('admin-settings-view')
  // Mounted into the settings view (no new admin route) and reported dirty state.
  assert.match(settings, /import \{ AdminCanvasAgentSettings \} from '\.\/admin-canvas-agent-settings'/)
  assert.match(settings, /id: 'canvasAgent'/)
  assert.match(settings, /<AdminCanvasAgentSettings onStateChange=\{reportCanvasAgentState\} \/>/)
  // Real endpoint, PATCH only, and the shared validation module drives bounds/errors.
  assert.match(section, /API_ENDPOINTS\.admin\.canvasAgentSettings/)
  assert.match(section, /method: 'PATCH'/)
  assert.match(section, /from '\.\.\/lib\/canvas-agent-settings-state'/)
  assert.match(section, /CANVAS_AGENT_SETTING_LIMITS\[field\]\.min/)
  assert.match(section, /CANVAS_AGENT_SETTING_LIMITS\[field\]\.max/)
  // Model identity comes from the admin language-model list, never a literal id.
  assert.match(section, /API_ENDPOINTS\.admin\.models/)
  assert.match(section, /modelKind === 'language'/)
  // Enabling is an explicit draft field; saving never runs a connection test.
  assert.match(section, /aria-label="启用 Canvas Agent"/)
  assert.doesNotMatch(section, /smtpTest|storageTest|providerCredential|baseUrl|apiKey/i)
})

test('shell frame has one gutter owner, 260px sidebar and 24px gap, main has no duplicate horizontal padding', () => {
  const root = source('admin-shell')
  assert.equal(tags(root, 'ContentFrame').length, 2)
  assert.equal(tags(root, 'BrandMark').length, 1)
  const main = tags(root, 'main')[0]
  const classes = attribute(main, 'className').initializer.text
  assert.match(classes, /@container\/admin/)
  assert.match(classes, /min-w-0/)
  assert.doesNotMatch(classes, /(?:^|\s)(?:p-|px-|sm:p-|md:p-)/)
  assert.match(read('admin-shell'), /w-sidebar/)
  assert.match(read('admin-shell'), /flex-1 gap-6/)
  assert.match(read('admin-shell'), /min-width: 960px/)
})

test('desktop user and invitation rows provide named detail actions; tabs can scroll', () => {
  const text = read('admin-users-view')
  assert.match(text, /查看用户 \$\{u.email\} 详情/)
  assert.match(text, /查看邀请码记录 \$\{inv.id\} 详情/)
  assert.match(text, /listClassName="max-w-full overflow-x-auto"/)
})

for (const [name, id] of [['admin-users-view', 'admin-create-invitation-form'], ['admin-prompt-templates-view', 'admin-create-template-form']]) {
  test(`${name}: create submit remains in fixed Dialog footer and targets its form`, () => {
    const root = source(name)
    const forms = tags(root, 'form')
    assert.ok(forms.some((form) => attribute(form, 'id')?.initializer.text === id))
    const owner = tags(root, 'Dialog').find((tag) => attribute(tag, 'footer'))
    const submits = tags(attribute(owner, 'footer'), 'Button').filter((tag) => attribute(tag, 'type')?.initializer.text === 'submit')
    assert.ok(submits.some((button) => attribute(button, 'form')?.initializer.text === id))
  })
}

test('media models surface existing descriptor validation without changing model enablement', () => {
  const text = read('admin-media-models-view')
  const root = source('admin-media-models-view')
  const validation = matching(root, (node) => ts.isCallExpression(node) && node.expression.getText() === 'validateModelCapabilities')
  assert.equal(validation.length, 1)
  const descriptor = validation[0].arguments[0]
  assert.ok(ts.isBinaryExpression(descriptor) && descriptor.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  assert.equal(descriptor.left.getText(), 'model.capabilities')
  assert.deepEqual(descriptor.right.properties.map((prop) => prop.name.getText()), [
    'modes', 'parameters', 'inputSlots', 'defaults', 'flags', 'crossFieldConstraints',
  ])
  assert.match(text, /参数契约异常/)
  assert.match(text, /此页不自动修复或停用模型/)
  assert.match(text, /finding.message/)
})

test('panel tables and card grids use the admin track, not sidebar viewport breakpoints', () => {
  for (const name of ['admin-dashboard-view', 'admin-jobs-view', 'admin-users-view', 'admin-language-models-view', 'admin-media-models-view', 'admin-credential-table']) {
    assert.ok(tags(source(name), 'AdminMobileRecords').length > 0, `${name} must keep a narrow-track presentation`)
    for (const table of tags(source(name), 'DataTable')) {
      assert.equal(attribute(table, 'cardClassName').initializer.text, 'hidden @min-[800px]/admin:block')
    }
  }
  assert.match(read('admin-prompt-templates-view'), /@min-\[1040px\]\/admin:grid-cols-3/)
  assert.match(read('admin-prompt-templates-view'), /variant=\{search.trim\(\) \? 'no-results' : 'first-use'\}/)
})
