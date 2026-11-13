#!/usr/bin/env node
/**
 * Isolated mock-workspace acceptance (Node 24, installed Next + Chrome; no installs).
 * Run: node tests/e2e/workspace-mock.mjs
 * Optional: WORKSPACE_MOCK_CHROME, WORKSPACE_MOCK_TIMEOUT_MS.
 * Starts Next DEV with the dev-only mock switch, an isolated Chrome profile, and a
 * fail-closed API sink. Never signs in, visits admin/auth, or calls a real provider.
 * Artifacts are retained in the approved OpenCode temp directory; only owned child
 * process trees are stopped. This does not test the production mock hard-off guard.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '../..')
const WEB = path.join(ROOT, 'apps/web')
const TEMP = 'C:/Users/judej/AppData/Local/Temp/opencode'
fs.mkdirSync(TEMP, { recursive: true })
const OUT = fs.mkdtempSync(path.join(TEMP, 'workspace-mock-'))
const CHROME = process.env.WORKSPACE_MOCK_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const started = Date.now()
const children = []
const checks = []
const screenshots = []
const apiCalls = []
const runtimeErrors = []
const pending = new Map()
let ws, origin, sequence = 0, cleaned = false, sink, completion = 'running'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function launch(command, args, name, env = process.env) {
  const log = fs.openSync(path.join(OUT, `${name}.log`), 'w')
  const child = spawn(command, args, { cwd: WEB, env, windowsHide: true, stdio: ['ignore', log, log] })
  fs.closeSync(log)
  child.on('error', (error) => { child.launchError = error })
  children.push({ name, child })
  return child
}

function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) })
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`)
}

async function eventually(operation, label, timeout = 45_000) {
  const until = Date.now() + timeout
  let last
  while (Date.now() < until) {
    for (const { child, name } of children) {
      if (child.launchError) throw child.launchError
      if (child.exitCode !== null) throw new Error(`${name} exited ${child.exitCode}; see ${OUT}`)
    }
    try { const value = await operation(); if (value) return value } catch (error) { last = error.message }
    await delay(150)
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last})` : ''}`)
}

function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 45_000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  return response.result.value
}
const wait = (expression, label = expression) => eventually(() => evaluate(expression), label)
const visible = `(el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }`

async function click(selector) {
  const point = await eventually(() => evaluate(`(() => { const control = [...document.querySelectorAll(${JSON.stringify(selector)})].find(${visible}); if (!control || control.disabled || control.closest('[inert]')) return null; const el = control.matches('input[type="checkbox"]') ? control.closest('label') || control : control; el.scrollIntoView({block:'center'}); for(let parent=el;parent;parent=parent.parentElement) if(parent.getAnimations().some(animation => animation.playState === 'running')) return null; const r = el.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; const hit=document.elementFromPoint(x,y); return hit && (el === hit || el.contains(hit)) ? {x,y} : null })()`), `actionable ${selector}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function button(text) {
  const selector = await evaluate(`(() => { const el = [...document.querySelectorAll('button,a')].find(el => el.textContent.trim() === ${JSON.stringify(text)} && (${visible})(el)); if (!el) return null; el.setAttribute('data-e2e-action','current'); return '[data-e2e-action="current"]' })()`)
  if (!selector) throw new Error(`Missing button/link: ${text}`)
  try { await click(selector) } finally { await evaluate(`document.querySelector('[data-e2e-action="current"]')?.removeAttribute('data-e2e-action')`) }
}

async function key(key, code, virtualKey) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey })
}

async function fill(selector, value) {
  await wait(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el && Object.keys(el).some(key => key.startsWith('__reactProps$')) })()`, `hydrated ${selector}`)
  await click(selector)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.insertText', { text: value })
  await wait(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`, `entered ${selector}`)
}

async function navigate(route) {
  if (!['/generate', '/library'].includes(route)) throw new Error(`Disallowed test route: ${route}`)
  await send('Page.navigate', { url: `${origin}${route}` })
  await wait(`location.pathname === ${JSON.stringify(route)} && document.querySelector('h1') && !document.querySelector('nextjs-portal [data-nextjs-dialog]')`, `ready ${route}`)
  const control = route === '/generate' ? 'textarea' : 'input[type="search"]'
  await wait(`(() => { const el = document.querySelector(${JSON.stringify(control)}); return el && Object.keys(el).some(key => key.startsWith('__reactProps$')) })()`, `hydrated ${route}`)
}

async function screenshot(name) {
  await evaluate(`document.fonts.ready.then(() => true)`)
  await delay(200)
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  screenshots.push(file)
}

async function noOverflow(name) {
  const dimensions = await evaluate(`({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth})`)
  check(`${name}: no horizontal document overflow`, dimensions.document <= dimensions.viewport && dimensions.body <= dimensions.viewport, dimensions)
}

function report() {
  const result = {
    completion, generatedAt: new Date().toISOString(), durationMs: Date.now() - started,
    origin, outputDirectory: OUT, node: process.version,
    scope: 'Local browser mock only; no real auth, admin, providers, database or production build. API traffic blocked and counted, never fulfilled with synthetic API responses.',
    limitations: ['Does not prove production mock flag hard-off (covered by separate source/unit tests).', 'Screenshots captured, not pixel-diffed or manually reviewed by this script.'],
    children: children.map(({ name, child }) => ({ name, pid: child.pid, exitCode: child.exitCode })),
    summary: { assertions: checks.length, passed: checks.filter((item) => item.passed).length, failed: checks.filter((item) => !item.passed).length, apiCalls: apiCalls.length, runtimeErrors: runtimeErrors.length },
    checks, apiCalls, runtimeErrors, screenshots,
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ completion, ...result.summary, report: path.join(OUT, 'report.json'), screenshots }, null, 2))
}

function cleanup() {
  if (cleaned) return
  cleaned = true
  try { ws?.close() } catch { /* already closed */ }
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Harness cleanup')) }
  pending.clear()
  for (const { child } of children.toReversed()) {
    if (!child.pid || child.exitCode !== null) continue
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else child.kill('SIGTERM')
  }
  sink?.closeAllConnections()
  sink?.close()
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  completion = signal; checks.push({ name: signal, passed: false }); cleanup(); report(); process.exit(1)
})
const watchdog = setTimeout(() => {
  completion = 'timeout'; checks.push({ name: 'overall timeout', passed: false }); cleanup(); report(); process.exit(1)
}, Number(process.env.WORKSPACE_MOCK_TIMEOUT_MS || 360_000))

try {
  check('Node 24+ fetch/WebSocket available', Number(process.versions.node.split('.')[0]) >= 24 && typeof WebSocket === 'function')
  check('isolated Chrome executable exists', fs.existsSync(CHROME), CHROME)
  sink = http.createServer((request, response) => {
    apiCalls.push({ via: 'server-sink', method: request.method, url: request.url })
    response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{"error":"E2E forbids real API traffic"}')
  })
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve))
  const sinkOrigin = `http://127.0.0.1:${sink.address().port}`
  const webPort = await freePort()
  const chromePort = await freePort()
  origin = `http://127.0.0.1:${webPort}`
  const require = createRequire(path.join(WEB, 'package.json'))
  launch(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(webPort)], 'next', {
    ...process.env, NODE_ENV: 'development', NEXT_PUBLIC_WORKSPACE_MOCK: 'true', NEXT_TELEMETRY_DISABLED: '1',
    API_ORIGIN: sinkOrigin, INTERNAL_API_BASE_URL: sinkOrigin,
  })
  await eventually(async () => { const response = await fetch(`${origin}/generate`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }); return response.status === 200 }, 'mock Next dev server', 150_000)
  launch(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${path.join(OUT, 'chrome-profile')}`, '--window-size=1440,1000', 'about:blank'], 'chrome')
  const targets = await eventually(async () => { const response = await fetch(`http://127.0.0.1:${chromePort}/json/list`); return response.ok && await response.json() }, 'Chrome debugging endpoint')
  const target = targets.find((item) => item.type === 'page')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer); pending.delete(message.id)
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails)
    else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params
      apiCalls.push({ via: 'browser-blocked', method: request.method, url: request.url })
      void send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {})
    }
  })
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/*', requestStage: 'Request' }, { urlPattern: '*://*/api', requestStage: 'Request' }] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })

  // The acceptance selectors below follow the actual workspace UI, not fixtures.
  await navigate('/generate')
  await wait(`document.querySelector('select')?.options.length > 0 && !document.querySelector('select').disabled`, 'initial models')
  check('mock disclosure explicit', await evaluate(`/独立演示模式/.test(document.body.innerText) && /不会调用供应商/.test(document.body.innerText)`))
  check('local mock model loaded', await evaluate(`[...document.querySelectorAll('option')].some(el => /本地样片/.test(el.textContent))`))
  await noOverflow('generate desktop initial'); await screenshot('generate-1440-initial')
  await click('textarea'); await key('Tab', 'Tab', 9)
  check('composer keyboard Tab moves focus', await evaluate(`document.activeElement?.tagName === 'BUTTON'`))
  // Native dropdown: real keyboard events, not setting React state from JavaScript.
  await click('select')
  await key('ArrowDown', 'ArrowDown', 40); await key('Enter', 'Enter', 13)
  check('model dropdown remains valid', await evaluate(`Boolean(document.querySelector('select').value)`))
  const prompt = 'E2E mock warm ceramic studio unique prompt'
  await fill('textarea', prompt)
  await button('生成示例图片')
  await wait(`document.body.innerText.includes('任务已提交')`, 'task submitted')
  check('generation task submitted', true)
  await wait(`document.querySelector('section[aria-labelledby="results-heading"] img')?.complete && document.querySelector('section[aria-labelledby="results-heading"] img')?.naturalWidth > 0`, 'generated local sample', 60_000)
  check('task yields loaded local sample image', true)
  await screenshot('generate-1440-complete')

  await navigate('/library')
  await wait(`document.querySelectorAll('article').length > 1 && [...document.querySelectorAll('article img')].some(el => el.complete && el.naturalWidth > 0)`, 'initial library assets')
  check('initial local library assets loaded', true)
  await fill('input[type="search"]', prompt)
  await wait(`document.querySelectorAll('article').length === 1 && document.querySelector('article').innerText.includes(${JSON.stringify(prompt)})`, 'generated asset library roundtrip')
  check('generated sample is searchable in library', true)
  await click('button[aria-label^="查看作品："]')
  await wait(`document.querySelector('[role="dialog"]')?.innerText.includes('作品详情')`, 'asset details')
  check('asset detail contains prompt and metadata', await evaluate(`document.querySelector('[role="dialog"]').innerText.includes(${JSON.stringify(prompt)}) && document.querySelector('[role="dialog"]').innerText.includes('分辨率')`))
  await screenshot('library-1440-detail')
  await button('复用提示词')
  try {
    await wait(`location.pathname === '/generate' && document.querySelector('textarea')?.value === ${JSON.stringify(prompt)}`, 'prompt reuse handoff')
    check('detail reuse hands prompt to composer', true)
  } catch (error) {
    checks.push({ name: 'detail reuse hands prompt to composer', passed: false, detail: { error: error.message, ...await evaluate(`({url:location.href,prompt:document.querySelector('textarea')?.value})`) } })
    await screenshot('prompt-reuse-failure')
  }

  await navigate('/library')
  await fill('input[type="search"]', 'e2e-no-such-local-sample-zzzz')
  await wait(`document.body.innerText.includes('没有找到匹配的作品')`, 'search empty state')
  check('search no-results state', true)
  await button('清除筛选')
  await wait(`document.querySelectorAll('article').length > 1 && document.querySelector('input[type="search"]').value === ''`, 'clear search')
  check('clear restores local assets', true)
  await click('select[aria-label="图库网格列数"]')
  await key('Home', 'Home', 36); await key('Enter', 'Enter', 13)
  await wait(`document.querySelector('select[aria-label="图库网格列数"]').value === '2'`, 'grid dropdown keyboard change')
  await click('select[aria-label="图库网格列数"]')
  await key('End', 'End', 35); await key('Enter', 'Enter', 13)
  await wait(`document.querySelector('select[aria-label="图库网格列数"]').value === '6'`, 'grid dropdown keyboard selection')
  check('actual layout dropdown keyboard selection', true)
  await fill('input[type="search"]', prompt)
  await wait(`document.querySelectorAll('article').length === 1`, 'isolate generated sample for deletion')
  await click('input[aria-label^="选择作品："]')
  await button('删除所选')
  await wait(`document.querySelector('[role="dialog"]')?.innerText.includes('删除 1 件作品')`, 'delete confirmation')
  check('selection delete requires confirmation', await evaluate(`document.querySelectorAll('article').length === 1`))
  await button('保留作品')
  await wait(`!document.querySelector('[role="dialog"]')`, 'cancel dialog fully dismissed')
  check('cancel delete preserves asset', await evaluate(`document.querySelectorAll('article').length === 1`))
  await button('删除所选'); await button('确认删除')
  await wait(`!document.querySelector('[role="dialog"]') && document.body.innerText.includes('没有找到匹配的作品')`, 'confirmed delete updates library')
  check('confirmed delete removes only selected generated sample', true)
  await button('清除筛选')
  await wait(`document.querySelectorAll('article').length > 0`, 'seed samples remain')

  // Leave the generator while the new task is still pending. The shell observer
  // must invalidate the mounted library when the mock completes (~4 seconds).
  const seedCount = await evaluate(`document.querySelectorAll('article').length`)
  const batchPrompt = 'E2E two-output sample for cascade batch deletion'
  await navigate('/generate')
  await wait(`document.querySelector('input[type="number"]') && document.querySelector('select')?.value`, 'multi-output composer')
  await fill('textarea', batchPrompt)
  await fill('input[type="number"]', '2')
  const submittedAt = Date.now()
  await button('生成示例图片')
  await wait(`document.body.innerText.includes('任务已提交')`, 'multi-output submit')
  await navigate('/library')
  check('navigates to library before mock completion', Date.now() - submittedAt < 4000, { elapsedMs: Date.now() - submittedAt })
  await wait(`[...document.querySelectorAll('article')].filter(el => el.innerText.includes(${JSON.stringify(batchPrompt)})).length === 2`, 'library auto-refresh after off-page job completion')
  check('pending job completes into library without generator revisit', await evaluate(`location.pathname === '/library' && document.querySelectorAll('article').length === ${seedCount + 2}`))
  await screenshot('library-1440-offpage-completion')
  // Two outputs belonging to one job plus a separate seed exercise the cascade
  // 404 edge case in sequential deletion; no fixture/storage edits are involved.
  for (const index of [1, 2, 3]) await click(`article:nth-child(${index}) input[type="checkbox"]`)
  await wait(`document.body.innerText.includes('已选 3 件')`, 'multi-output plus independent selection')
  await button('删除所选')
  await wait(`document.querySelector('[role="dialog"]')?.innerText.includes('删除 3 件作品')`, 'three-asset delete confirmation')
  await button('确认删除')
  await wait(`!document.querySelector('[role="dialog"]') && document.querySelectorAll('article').length === ${seedCount - 1}`, 'cascade-safe batch delete')
  check('batch deletes both outputs and independent asset', await evaluate(`![...document.querySelectorAll('article')].some(el => el.innerText.includes(${JSON.stringify(batchPrompt)})) && !document.body.innerText.includes('操作未完成')`))
  await screenshot('library-1440-batch-delete')

  for (const width of [1440, 375, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 })
    for (const route of ['/generate', '/library']) {
      await navigate(route)
      await wait(route === '/library' ? `document.querySelectorAll('article').length > 0` : `document.querySelector('select')?.value`, `${route} ${width} ready`)
      await noOverflow(`${route} ${width}`)
      await screenshot(`${route.slice(1)}-${width}`)
    }
  }
  check('zero browser/server API calls across mock workspace', apiCalls.length === 0, apiCalls)
  check('zero uncaught browser runtime errors', runtimeErrors.length === 0, runtimeErrors)
  completion = checks.some((item) => !item.passed) ? 'failed' : 'passed'
  if (completion === 'failed') process.exitCode = 1
} catch (error) {
  completion = 'failed'
  checks.push({ name: 'harness/acceptance failure', passed: false, detail: error.stack || String(error) })
  if (ws?.readyState === WebSocket.OPEN) {
    try { await screenshot('failure'); fs.writeFileSync(path.join(OUT, 'failure-dom.txt'), await evaluate(`document.body.innerText`)) } catch { /* preserve original failure */ }
  }
  console.error(error.stack || error)
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  cleanup()
  report()
}
