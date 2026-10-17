#!/usr/bin/env node
/**
 * P6 browser-acceptance matrix for the MuseCanvas UI redesign.
 *
 * Self-contained: Node built-ins + the global fetch/WebSocket only. No Playwright,
 * no new dependency. It starts
 *   1. a read-only fixture API (synthetic admin session + synthetic payloads),
 *   2. the already-built production Next app via `pnpm --filter @musecanvas/web start`,
 *   3. headless Chrome over raw CDP (global WebSocket).
 *
 * Because the production Next build intentionally has no `/api` rewrite (nginx owns
 * that in deploys), the browser-side `/api/*` calls are fulfilled from the *same*
 * fixture router through the CDP Fetch domain. SSR reaches the fixture directly via
 * INTERNAL_API_BASE_URL / API_ORIGIN. Both paths therefore serve identical data.
 *
 * Deliverable: machine-readable report.json + screenshots under
 *   D:/Temp/musecanvas-ui-redesign-20261006/browser/
 * Exit code is non-zero when any case fails.
 *
 * Coverage boundaries (honest, see report.coverage):
 * - synthetic, read-only single-actor fixture; no real auth, generation, upload,
 *   mutation, provider or deployment was exercised;
 * - font rasterisation/colour-blind checks are not replaced by screenshot review;
 *   contrast is computed from computed styles, not from pixels;
 * - 200% text is emulated by doubling the root font size, not by OS/browser zoom.
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const OUT = 'D:/Temp/musecanvas-ui-redesign-20261006/browser'
const API_PORT = Number(process.env.UI_REDESIGN_API_PORT || 3531)
const WEB_PORT = Number(process.env.UI_REDESIGN_WEB_PORT || 3530)
const CHROME_PORT = Number(process.env.UI_REDESIGN_CHROME_PORT || 9533)
const FORCE_DEV = process.env.UI_REDESIGN_USE_DEV === '1'
const CHROME = process.env.UI_REDESIGN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SESSION_COOKIE = 'ui-redesign-fixture'
const FIXTURE_ORIGIN = `http://127.0.0.1:${API_PORT}`
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`
const MEDIA_URL = `${FIXTURE_ORIGIN}/fixture.svg`
const CANVAS_ID = '33333333-3333-4333-8333-333333333333'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const NOW = '2026-10-06T00:00:00.000Z'

fs.mkdirSync(OUT, { recursive: true })

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const user = { id: USER_ID, email: 'ui-fixture@example.invalid', role: 'admin', status: 'active', createdAt: NOW }

const imageModel = {
  id: '22222222-2222-4222-8222-222222222222',
  displayName: '合成图像模型',
  adapter: 'fixture-image',
  modelKind: 'image',
  vendorModelId: 'fixture-image-v1',
  modes: ['text_to_image', 'image_to_image'],
  sizes: ['1024x1024', '1280x720'],
  qualityOptions: ['standard', 'high'],
  maxCount: 4,
  concurrencyLimit: 2,
  enabled: true,
  sortOrder: 0,
  maxInputImages: 4,
  parameters: [{ type: 'enum', name: 'size', label: '尺寸', options: ['1024x1024', '1280x720'], defaultValue: '1024x1024' }],
  inputSlots: [{ role: 'reference_image', required: false, minCount: 0, maxCount: 4, allowedMediaKinds: ['image'] }],
  capabilities: { modes: ['text_to_image', 'image_to_image'], parameters: [{ type: 'enum', name: 'size', options: ['1024x1024', '1280x720'] }], inputSlots: [{ role: 'reference_image', required: false, minCount: 0, maxCount: 4, allowedMediaKinds: ['image'] }] },
}

const videoModel = {
  id: '44444444-4444-4444-8444-444444444444',
  displayName: '合成视频模型',
  adapter: 'fixture-video',
  modelKind: 'video',
  vendorModelId: 'fixture-video-v1',
  modes: ['text_to_video'],
  sizes: ['1280x720'],
  maxCount: 1,
  concurrencyLimit: 1,
  enabled: true,
  sortOrder: 1,
  maxInputImages: 0,
  parameters: [{ type: 'enum', name: 'size', label: '尺寸', options: ['1280x720'], defaultValue: '1280x720' }],
  inputSlots: [],
}

const assets = [1, 2, 3, 4].map((n) => ({
  id: `55555555-5555-4555-8555-55555555555${n}`,
  prompt: `合成作品 ${n}：一条足够长的中文提示词，用来验证单行截断与换行在窄屏和多列网格中的表现。`,
  inputPrompt: `合成作品 ${n}`,
  mediaKind: n === 4 ? 'video' : 'image',
  imageUrl: MEDIA_URL,
  url: MEDIA_URL,
  thumbnailUrl: MEDIA_URL,
  downloadUrl: MEDIA_URL,
  width: 1024,
  height: 1024,
  mimeType: n === 4 ? 'video/mp4' : 'image/png',
  sizeBytes: 204800 + n * 1000,
  createdAt: NOW,
}))

const jobs = [
  {
    id: '66666666-6666-4666-8666-666666666661',
    createdBy: USER_ID,
    modelId: imageModel.id,
    modelName: imageModel.displayName,
    prompt: '合成成功任务',
    size: '1024x1024',
    count: 1,
    status: 'succeeded',
    mediaKind: 'image',
    createdAt: NOW,
    completedAt: NOW,
    outputs: [{ id: 'output-1', assetId: assets[0].id, mediaKind: 'image', url: MEDIA_URL, imageUrl: MEDIA_URL, downloadUrl: MEDIA_URL, metadata: { width: 1024, height: 1024, aspectRatio: '1:1' } }],
  },
  {
    id: '66666666-6666-4666-8666-666666666662',
    createdBy: USER_ID,
    modelId: videoModel.id,
    modelName: videoModel.displayName,
    prompt: '合成排队任务',
    size: '1280x720',
    count: 1,
    status: 'running',
    mediaKind: 'video',
    createdAt: NOW,
    outputs: [],
  },
  {
    id: '66666666-6666-4666-8666-666666666663',
    createdBy: USER_ID,
    modelId: imageModel.id,
    modelName: imageModel.displayName,
    prompt: '合成失败任务',
    size: '1024x1024',
    count: 1,
    status: 'failed',
    mediaKind: 'image',
    errorCode: 'PROVIDER_ERROR',
    createdAt: NOW,
    outputs: [],
  },
]

const canvases = [
  { id: CANVAS_ID, title: '首个创作对话', revision: 3, coverAssetId: null, createdAt: NOW, updatedAt: NOW },
  { id: '77777777-7777-4777-8777-777777777771', title: '第二个创作对话', revision: 1, coverAssetId: null, createdAt: NOW, updatedAt: NOW },
]

const longToolArgs = {
  mode: 'image_to_image',
  modelId: imageModel.id,
  parameters: { size: '1024x1024', quality: 'high' },
  inputs: [{ role: 'reference_image', position: 0, assetId: assets[1].id }],
  notes: '这一段 JSON 故意足够长，用于验证工具调用参数在时间线中折叠而不是形成第二个滚动区域。'.repeat(3),
}

const historyMessages = []
for (let i = 0; i < 6; i += 1) {
  historyMessages.push({ id: `msg-user-${i}`, seq: i * 3 + 1, turnId: `turn-${i}`, role: 'user', content: `第 ${i + 1} 轮：请生成一张暖白工作室风格的合成画面。`, createdAt: NOW })
  historyMessages.push({
    id: `msg-assistant-${i}`,
    seq: i * 3 + 2,
    turnId: `turn-${i}`,
    role: 'assistant',
    content: `这是第 ${i + 1} 轮 Agent 回复，用于确认时间线在长历史下的滚动与排版表现。`,
    toolCalls: [{ id: `call-${i}`, name: 'generate_image', arguments: longToolArgs }],
    createdAt: NOW,
  })
  historyMessages.push({ id: `msg-tool-${i}`, seq: i * 3 + 3, turnId: `turn-${i}`, role: 'tool', content: JSON.stringify({ toolCallId: `call-${i}`, success: true, result: { items: [{ id: assets[i % 4].id, note: 'ok' }], note: '工具结果用于验证工具输出为纯文本并有自己的展开入口。' } }), createdAt: NOW })
}

const history = {
  sessionId: 'session-fixture',
  messages: historyMessages,
  pendingJobs: [],
  requireConfirmation: true,
  autoContinuationCount: 0,
  nextAfterSeq: null,
  nextBeforeSeq: null,
}

const adminModels = [
  { ...imageModel, name: '合成图像模型', presetId: 'preset-image', baseUrl: 'https://api.example.invalid/v1', capabilitiesJson: '{}', defaultsJson: '{}' },
  { ...videoModel, name: '合成视频模型', presetId: 'preset-video', baseUrl: 'https://api.example.invalid/v1', capabilitiesJson: '{}', defaultsJson: '{}' },
  { id: '88888888-8888-4888-8888-888888888881', displayName: '合成语言模型', adapter: 'fixture-llm', modelKind: 'language', vendorModelId: 'fixture-llm-v1', languageProtocol: 'openai_chat', maxOutputTokens: 4096, temperature: 0.7, baseUrl: 'https://api.example.invalid/v1', enabled: true, sortOrder: 0, concurrencyLimit: 1, sizes: [], maxCount: 1, providerCredentialId: '99999999-9999-4999-8999-999999999991', providerCredentialName: '合成凭据 A' },
]

const credentials = [
  { id: '99999999-9999-4999-8999-999999999991', displayName: '合成凭据 A（很长的供应商显示名称）', adapter: 'fixture-image', providerId: 'openai', baseUrl: 'https://api.example.invalid/v1', enabled: true, hasApiKey: true, hasCredential: true, keyFingerprint: 'abcdef0123456789', lastTestStatus: 'success', lastTestedAt: NOW, updatedAt: NOW, configuredFields: { hasApiKey: true } },
  { id: '99999999-9999-4999-8999-999999999992', displayName: '合成凭据 B', adapter: 'fixture-llm', providerId: 'google', baseUrl: 'https://api.example.invalid/v1', enabled: false, hasApiKey: false, hasCredential: false, lastTestStatus: 'not_tested', updatedAt: NOW, configuredFields: {} },
]

const presets = [
  { id: 'preset-image', modelKind: 'image', displayName: '合成图像预设', vendorModelId: 'fixture-image-v1', baseUrl: 'https://api.example.invalid/v1', sizes: ['1024x1024'], maxCount: 4, concurrencyLimit: 2 },
  { id: 'preset-video', modelKind: 'video', displayName: '合成视频预设', vendorModelId: 'fixture-video-v1', baseUrl: 'https://api.example.invalid/v1', sizes: ['1280x720'], maxCount: 1, concurrencyLimit: 1 },
]

const adminUsers = [
  { id: USER_ID, email: 'ui-fixture@example.invalid', role: 'admin', status: 'active', createdAt: NOW },
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', email: 'member-one@example.invalid', role: 'user', status: 'active', createdAt: NOW },
]

const adminJobs = jobs.map((job) => ({
  id: job.id,
  createdBy: job.createdBy,
  userEmail: user.email,
  modelId: job.modelId,
  modelName: job.modelName,
  status: job.status,
  createdAt: NOW,
  completedAt: job.completedAt,
  errorCode: job.errorCode,
}))

const oauthProviders = [
  { provider: 'github', label: 'GitHub', enabled: true, configuredInDatabase: true, source: 'database', clientId: 'fixture-client-id', hasClientSecret: true, redirectUri: `${WEB_ORIGIN}/api/auth/oauth/github/callback` },
  { provider: 'google', label: 'Google', enabled: false, configuredInDatabase: false, source: 'none', clientId: '', hasClientSecret: false, redirectUri: `${WEB_ORIGIN}/api/auth/oauth/google/callback` },
]

const sections = {}
for (const key of ['bootstrap', 'site', 'smtp', 'admin', 'storage', 'providers', 'models', 'oauth', 'templates', 'runtime']) {
  sections[key] = { status: 'pending', updatedAt: NOW }
}
const setupStatus = { setupComplete: false, status: 'pending', sections, bootstrap: null, configRevision: 1, completedAt: null }

const setupConfig = {
  site: { siteName: 'MuseCanvas 合成站点', siteUrl: WEB_ORIGIN, revision: 1, updatedAt: NOW },
  smtp: { host: 'smtp.example.invalid', port: 587, tlsMode: 'starttls', username: 'fixture', fromAddress: 'noreply@example.invalid', fromName: 'MuseCanvas', hasSecret: true, secretFingerprint: 'aaaa1111', encryptionKeyId: 'k1', status: 'configured', revision: 1, updatedAt: NOW },
  storage: { endpoint: 'https://s3.example.invalid', publicEndpoint: 'https://cdn.example.invalid', region: 'us-east-1', bucket: 'fixture-bucket', accessKeyId: 'fixture-access', signedUrlTtlSeconds: 900, hasSecret: true, secretFingerprint: 'bbbb2222', encryptionKeyId: 'k1', status: 'configured', revision: 1, updatedAt: NOW },
  runtime: { uploadTtlSeconds: 86400, signedUrlTtlSeconds: 900, maxImageBytes: 10000000, maxTotalBytes: 40000000, maxInputs: 8, providerTimeoutMs: 120000, maxOutputBytes: 20000000, jobLeaseMs: 120000, revision: 1, updatedAt: NOW },
  templates: { active: null, entries: [] },
}

const emptyPage = { items: [], total: 0, hasMore: false }

/**
 * One router for both transports. `cookie` is the raw Cookie header.
 * Anything that is not a GET is refused: the fixture is read-only on purpose.
 */
function fixtureRespond(method, pathname, search, cookie) {
  const authed = typeof cookie === 'string' && cookie.includes(`muse_session=${SESSION_COOKIE}`)
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 400, body: { success: false, error: { code: 'FIXTURE_READ_ONLY', message: 'UI redesign fixture forbids mutations' } } }
  }
  if (pathname === '/fixture.svg') {
    return { status: 200, raw: '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#deded8"/><circle cx="256" cy="256" r="120" fill="#667766"/></svg>', contentType: 'image/svg+xml' }
  }
  if (pathname === '/api/health/ready') return { status: 200, body: { success: true, data: { ready: true } } }
  if (pathname === '/api/session') {
    if (!authed) return { status: 401, body: { success: false, error: { code: 'UNAUTHORIZED', message: 'fixture anonymous' } } }
    return { status: 200, body: { success: true, data: { user } } }
  }
  if (pathname === '/api/models') return { status: 200, body: { success: true, data: [imageModel, videoModel] } }
  if (pathname === '/api/jobs') return { status: 200, body: { success: true, data: { items: jobs, total: jobs.length, hasMore: false } } }
  if (pathname === '/api/library') return { status: 200, body: { success: true, data: { items: assets, total: assets.length, hasMore: false } } }
  if (pathname.startsWith('/api/library/') && pathname.endsWith('/download')) {
    return { status: 200, body: { success: true, data: { url: MEDIA_URL, downloadUrl: MEDIA_URL, mediaKind: 'image', mimeType: 'image/png' } } }
  }
  if (pathname === '/api/account/oauth') return { status: 200, body: { success: true, data: [] } }
  if (pathname === '/api/auth/oauth/providers') return { status: 200, body: { success: true, data: [{ provider: 'github', label: 'GitHub', enabled: true }, { provider: 'google', label: 'Google', enabled: false }] } }
  if (pathname === '/api/canvas-agent/status') {
    return { status: 200, body: { success: true, data: { enabled: true, available: true, reason: 'ready', maxToolCallsPerTurn: 12, maxJobsPerTurn: 4, timeoutMs: 120000, maxAutoContinuations: 3 } } }
  }
  if (pathname === '/api/canvases') {
    if (!authed) return { status: 401, body: { success: false, error: { code: 'UNAUTHORIZED', message: 'fixture anonymous' } } }
    return { status: 200, body: { success: true, data: { items: canvases, nextCursor: null } } }
  }
  const canvasMatch = pathname.match(/^\/api\/canvases\/([0-9a-f-]+)$/i)
  if (canvasMatch) {
    const found = canvases.find((c) => c.id === canvasMatch[1])
    return { status: 200, body: { success: true, data: { ...(found ?? canvases[0]), scene: { nodes: [], edges: [] } } } }
  }
  if (/^\/api\/canvases\/[0-9a-f-]+\/agent\/history$/i.test(pathname)) {
    return { status: 200, body: { success: true, data: history } }
  }
  if (pathname.startsWith('/api/setup/status')) return { status: 200, body: { success: true, data: setupStatus } }
  if (pathname === '/api/setup/config') return { status: 200, body: { success: true, data: setupConfig } }
  if (pathname === '/api/setup/site') return { status: 200, body: { success: true, data: setupConfig.site } }
  if (pathname === '/api/setup/smtp') return { status: 200, body: { success: true, data: setupConfig.smtp } }
  if (pathname === '/api/setup/storage') return { status: 200, body: { success: true, data: setupConfig.storage } }
  if (pathname === '/api/setup/runtime') return { status: 200, body: { success: true, data: setupConfig.runtime } }
  if (pathname === '/api/admin/dashboard') return { status: 200, body: { success: true, data: { totalUsers: adminUsers.length, totalJobs: jobs.length, successRate7d: 97.5, failedJobs7d: 1 } } }
  if (pathname === '/api/admin/jobs') return { status: 200, body: { success: true, data: { items: adminJobs, total: adminJobs.length, hasMore: false } } }
  if (pathname === '/api/admin/users') return { status: 200, body: { success: true, data: { items: adminUsers, total: adminUsers.length, hasMore: false } } }
  if (pathname === '/api/admin/invitations') return { status: 200, body: { success: true, data: { items: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', used: false, revoked: false, createdAt: NOW }] } } }
  if (pathname === '/api/admin/models') return { status: 200, body: { success: true, data: adminModels } }
  if (pathname === '/api/admin/model-presets') return { status: 200, body: { success: true, data: presets } }
  if (pathname === '/api/admin/provider-credentials') return { status: 200, body: { success: true, data: credentials } }
  if (pathname === '/api/admin/provider-templates') return { status: 200, body: { success: true, data: { templates: [] } } }
  if (pathname === '/api/admin/plugins') return { status: 200, body: { success: true, data: [] } }
  if (pathname === '/api/admin/oauth-providers') return { status: 200, body: { success: true, data: oauthProviders } }
  if (pathname === '/api/admin/prompt-templates') return { status: 200, body: { success: true, data: null } }
  if (pathname === '/api/admin/prompt-optimization-settings') return { status: 200, body: { success: true, data: { enabled: false, allowUserReadFinalPrompt: false, languageModelConfigId: null, timeoutMs: 60000, updatedAt: NOW } } }
  if (pathname === '/api/admin/canvas-agent-settings') return { status: 200, body: { success: true, data: { enabled: true, languageModelConfigId: null, maxToolCallsPerTurn: 12, maxJobsPerTurn: 4, timeoutMs: 120000, maxAutoContinuations: 3 } } }
  // Unknown GETs never 404 here: callers must see the empty envelope, not an error.
  return { status: 200, body: { success: true, data: { ...emptyPage } } }
}

const fixtureLog = []

// ---------------------------------------------------------------------------
// Fixture HTTP server (SSR path)
// ---------------------------------------------------------------------------

const fixtureServer = http.createServer((req, res) => {
  const url = new URL(req.url, FIXTURE_ORIGIN)
  fixtureLog.push({ via: 'ssr', method: req.method, path: url.pathname })
  const result = fixtureRespond(req.method, url.pathname, url.searchParams, req.headers.cookie)
  if (result.raw !== undefined) {
    res.statusCode = result.status
    res.setHeader('Content-Type', result.contentType)
    res.end(result.raw)
    return
  }
  res.statusCode = result.status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(result.body))
})

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

let ws
let nextId = 1
const pending = new Map()
const runtimeExceptions = []
const interceptedCalls = []

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 60000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)}`)
  return r.result.value
}

async function handlePaused(params) {
  try {
    const url = new URL(params.request.url)
    const method = params.request.method || 'GET'
    const cookie = params.request.headers?.Cookie || params.request.headers?.cookie || ''
    const result = fixtureRespond(method, url.pathname, url.searchParams, cookie)
    interceptedCalls.push({ via: 'browser', method, path: url.pathname })
    const body = result.raw !== undefined ? result.raw : JSON.stringify(result.body)
    await send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: result.status,
      responseHeaders: [
        { name: 'Content-Type', value: result.contentType || 'application/json; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store' },
      ],
      body: Buffer.from(body, 'utf8').toString('base64'),
    })
  } catch (error) {
    try { await send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' }) } catch { /* ignore */ }
    runtimeExceptions.push(`Fetch interception failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

let themeScriptId = null
async function setThemeScript(theme) {
  if (themeScriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: themeScriptId })
  const added = await send('Page.addScriptToEvaluateOnNewDocument', {
    // Runs before the app's own first-paint bootstrap reads localStorage.
    source: `try{localStorage.setItem('muse-theme',${JSON.stringify(theme)})}catch(e){}`,
  })
  themeScriptId = added.identifier
}

async function waitForLoad(timeout = 90000) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', listener); reject(new Error('Page.loadEventFired timed out')) }, timeout)
    const listener = (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Page.loadEventFired') {
        clearTimeout(timer)
        ws.removeEventListener('message', listener)
        resolve()
      }
    }
    ws.addEventListener('message', listener)
  })
}

/**
 * The page-side measurement bundle. Self-contained: it is stringified and injected.
 * Everything is derived from computed styles/geometry, never from screenshots.
 */
function measurePage() {
  const round = (value) => Math.round(value * 100) / 100
  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height), right: round(r.right), center: round(r.x + r.width / 2) }
  }
  const visible = (el) => {
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const parseRgb = (str) => {
    if (!str) return null
    const m = str.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    if (parts.length < 3) return null
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1]
  }
  const luminance = (c) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  const over = (src, dst) => { const a = src[3]; return [src[0] * a + dst[0] * (1 - a), src[1] * a + dst[1] * (1 - a), src[2] * a + dst[2] * (1 - a)] }
  const contrast = (a, b) => { const l1 = luminance(a); const l2 = luminance(b); const hi = Math.max(l1, l2); const lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05) }
  const effectiveBg = (el) => {
    const layers = []
    let node = el
    while (node) {
      const c = parseRgb(getComputedStyle(node).backgroundColor)
      if (c && c[3] > 0) layers.push(c)
      node = node.parentElement
    }
    let base = [255, 255, 255]
    for (let i = layers.length - 1; i >= 0; i -= 1) base = over(layers[i], base)
    return base
  }

  const h1s = [...document.querySelectorAll('h1')]
  // Horizontal centering is measured against the scrollbar-free content width, the
  // way `mx-auto` actually centers, not against `innerWidth`.
  const layoutWidth = document.documentElement.clientWidth
  const headers = [...document.querySelectorAll('header')].filter(visible)
  const mainHeader = headers.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
  const frames = [...document.querySelectorAll('.max-w-content')].filter(visible).map((el) => {
    const r = rectOf(el)
    // `mx-auto` centres inside the element's own containing block. Comparing against
    // `documentElement.clientWidth` would be wrong for a frame nested in a narrower
    // scroll container (e.g. the workspace `<main>`), so use the parent's box.
    const parent = el.parentElement
    const pb = parent ? parent.getBoundingClientRect() : { left: 0, right: layoutWidth }
    const leftGap = round(r.x - pb.left)
    const rightGap = round(pb.right - r.right)
    const cs = getComputedStyle(el)
    const paddingX = round((parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0))
    return { w: r.w, center: r.center, offsetFromCenter: round(Math.abs(leftGap - rightGap) / 2), leftGap, rightGap, paddingX, inner: round(r.w - paddingX), maxWidth: getComputedStyle(el).maxWidth }
  })
  const asides = [...document.querySelectorAll('aside')].filter(visible).map((el) => rectOf(el).w)
  const zeroIcons = []
  for (const el of document.querySelectorAll('svg,img')) {
    // getClientRects() is empty for anything inside a display:none subtree; those are
    // not rendered at all, so they are not "zero-size icons".
    if (el.getClientRects().length === 0) continue
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || Number(s.opacity) === 0) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) zeroIcons.push({ tag: el.tagName, cls: String(el.getAttribute('class') || '').slice(0, 60) })
  }
  // Wide tables must scroll inside their own overflow-x wrapper, never push the page
  // sideways. A table counts as unprotected only when it is wider than a wrapper that
  // cannot scroll (or has no wrapper at all).
  const tables = [...document.querySelectorAll('table')].filter(visible).map((table) => {
    const r = table.getBoundingClientRect()
    let wrapper = null
    for (let el = table.parentElement; el && el !== document.body; el = el.parentElement) {
      const ox = getComputedStyle(el).overflowX
      if (ox === 'auto' || ox === 'scroll') { wrapper = el; break }
    }
    const wrapperClient = wrapper ? wrapper.clientWidth : null
    const fitsWrapper = wrapper ? r.width <= wrapperClient + 1 : true
    return {
      w: round(r.width),
      wrapperTag: wrapper ? wrapper.tagName : null,
      wrapperOverflowX: wrapper ? getComputedStyle(wrapper).overflowX : null,
      wrapperScrollable: wrapper ? wrapper.scrollWidth > wrapper.clientWidth + 1 : false,
      fitsWrapper,
    }
  })
  const tablesUnscrollableWide = tables.filter((t) => !t.fitsWrapper && !t.wrapperScrollable).length
  const liveRegions = document.querySelectorAll('[aria-live]').length

  const contrastViolations = []
  let contrastChecked = 0
  const candidates = document.querySelectorAll('body *')
  for (const el of candidates) {
    if (contrastChecked >= 500) break
    if (!(el instanceof HTMLElement)) continue
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'OPTION'].includes(el.tagName)) continue
    if (el.closest('[aria-hidden="true"]')) continue
    if (el.classList.contains('sr-only')) continue
    if (el.closest('[disabled],[aria-disabled="true"]')) continue
    let text = ''
    for (const node of el.childNodes) if (node.nodeType === 3) text += node.textContent
    text = text.trim()
    if (!text) continue
    if (!visible(el)) continue
    const s = getComputedStyle(el)
    const fg = parseRgb(s.color)
    if (!fg) continue
    const bg = effectiveBg(el)
    const fgC = fg[3] < 1 ? over(fg, bg) : [fg[0], fg[1], fg[2]]
    const ratio = contrast(fgC, bg)
    const size = parseFloat(s.fontSize)
    const weight = parseInt(s.fontWeight, 10) || 400
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    const need = large ? 3 : 4.5
    contrastChecked += 1
    if (ratio + 0.02 < need) {
      contrastViolations.push({ text: text.slice(0, 32), tag: el.tagName, cls: String(el.getAttribute('class') || '').slice(0, 70), ratio: round(ratio), need, size: round(size), weight })
    }
  }

  const scrollables = (root) => {
    const out = []
    if (!root) return out
    for (const el of root.querySelectorAll('*')) {
      const s = getComputedStyle(el)
      if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') continue
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') continue
      if (el.clientHeight < 40) continue
      if (el.scrollHeight > el.clientHeight + 2) {
        out.push({ tag: el.tagName, aria: el.getAttribute('aria-label'), h: el.clientHeight, sh: el.scrollHeight, cls: String(el.getAttribute('class') || '').slice(0, 60) })
      }
    }
    return out
  }
  const mainEl = document.querySelector('main')
  const timeline = document.querySelector('section[aria-label="对话"]')
  // Only a *scrollable* (auto/scroll) pre counts: a collapsed `overflow-hidden` block
  // clips content but never creates a second scroll band.
  const toolScroll = timeline
    ? [...timeline.querySelectorAll('pre,code')].filter((el) => {
      const oy = getComputedStyle(el).overflowY
      return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 2
    }).length
    : 0

  return {
    pathname: location.pathname,
    search: location.search,
    theme: document.documentElement.dataset.theme,
    innerWidth,
    innerHeight,
    layoutWidth,
    clientWidth: document.documentElement.clientWidth,
    documentStatus: (performance.getEntriesByType('navigation')[0] || {}).responseStatus || null,
    h1Count: h1s.length,
    h1Visible: h1s.filter(visible).length,
    headerHeight: mainHeader ? rectOf(mainHeader).h : null,
    frames,
    adminSidebarWidth: asides.length ? Math.max(...asides) : null,
    zeroIconCount: zeroIcons.length,
    zeroIcons: zeroIcons.slice(0, 5),
    liveRegionCount: liveRegions,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    contrastChecked,
    contrastViolations: contrastViolations.slice(0, 20),
    contrastViolationCount: contrastViolations.length,
    scrollMain: scrollables(mainEl),
    scrollTimeline: scrollables(timeline),
    toolJsonScrollable: toolScroll,
    tables,
    tablesUnscrollableWide,
    hasDialog: Boolean(document.querySelector('[role="dialog"]')),
    visibleButtons: [...document.querySelectorAll('button,a')].filter(visible).length,
    pageText: document.body.innerText.slice(0, 6000),
  }
}

const MEASURE_SRC = `(${measurePage.toString()})()`

// ---------------------------------------------------------------------------
// Matrix definitions
// ---------------------------------------------------------------------------

const FULL_ROUTES = ['/', '/terms', '/privacy', '/login', '/setup', '/generate', '/library', '/account', '/admin', '/admin/jobs', '/admin/language-models', '/admin/media-models', '/admin/oauth', '/admin/prompt-templates', '/admin/settings', '/admin/users']
const ANON_ROUTES = new Set(['/', '/terms', '/privacy', '/login', '/setup'])
const ADMIN_ROUTES = new Set(FULL_ROUTES.filter((r) => r.startsWith('/admin')))
const REPRESENTATIVE = ['/', '/generate', '/library', '/admin', '/admin/users', '/terms']
const REP_SIZES = [[320, 568], [768, 900], [959, 900], [960, 900], [961, 900], [1279, 900], [1280, 900], [1920, 1080]]

const routeHref = (route) => (route === '/generate' ? `/generate?canvas=${CANVAS_ID}` : route)
const slug = (route) => (route === '/' ? 'home' : route.slice(1).replace(/\//g, '-'))

// Proof that the browser really rendered fixture data (not a client-API error/empty
// state): each probe must appear in the page text. Without this the geometry checks
// could pass on a broken data path.
const ROUTE_PROBES = {
  '/': '把灵感整理成',
  '/terms': '用户协议',
  '/privacy': '隐私政策',
  '/login': 'MuseCanvas',
  '/setup': '只读检查',
  '/library': '合成作品 1',
  '/account': 'ui-fixture@example.invalid',
  '/generate': '首个创作对话',
  '/admin': '合成图像模型',
  '/admin/jobs': '合成图像模型',
  '/admin/users': 'member-one@example.invalid',
  '/admin/language-models': '合成语言模型',
  '/admin/media-models': '合成图像模型',
  '/admin/oauth': 'GitHub',
  '/admin/settings': '站点信息',
  '/admin/prompt-templates': '提示词模板',
}

const cases = []
for (const [width, height] of [[375, 812], [1440, 900]]) {
  for (const theme of ['light', 'dark']) {
    for (const route of FULL_ROUTES) cases.push({ route, width, height, theme, motion: 'no-preference', group: 'full' })
  }
}
for (const [width, height] of REP_SIZES) {
  for (const route of REPRESENTATIVE) cases.push({ route, width, height, theme: 'light', motion: 'no-preference', group: 'representative' })
}

// Development aid: run only the first N planned cases. Unset in normal runs.
const MAX_CASES = Number(process.env.UI_REDESIGN_MAX_CASES || 0)
const activeCases = MAX_CASES > 0 ? cases.slice(0, MAX_CASES) : cases

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function taskkill(pid) {
  if (pid) spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
}

async function waitHttp(address, timeout) {
  const start = Date.now()
  for (;;) {
    try {
      const r = await fetch(address, { redirect: 'manual' })
      if (r.status < 500) return r
    } catch { /* not up yet */ }
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${address}`)
    await delay(300)
  }
}

let webProcess = null
let chromeProcess = null
const startedAt = Date.now()
const results = []
const interactions = { failures: [] }
let completionState = null

/** Always-ish writer: used both on the normal path and by the watchdog. */
function writeReport(state) {
  const allFailures = results.flatMap((r) => r.failures.map((f) => ({ route: r.route, width: r.width, height: r.height, theme: r.theme, ...f })))
  const report = {
    generatedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    serverMode: completionState?.mode ?? (FORCE_DEV ? 'dev' : 'start'),
    completion: state,
    fixture: 'isolated read-only HTTP fixture + CDP Fetch interception; synthetic admin session; no real auth/generation/upload/mutation/deploy was exercised',
    coverage: {
      matrixCases: activeCases.length,
      plannedCases: cases.length,
      fullRoutes: FULL_ROUTES,
      representative: { routes: REPRESENTATIVE, sizes: REP_SIZES },
      skipped: [
        'pixel-based contrast/rasterisation review (contrast is computed from computed styles)',
        'screenshot/视觉人工复核 not automated',
        'no real OAuth/OTP/generation/provider round-trip',
        '200% text emulated via root font-size, not OS/browser zoom',
      ],
    },
    summary: {
      total: results.length,
      passed: results.filter((r) => r.failures.length === 0).length,
      failed: results.filter((r) => r.failures.length > 0).length,
      interactionFailures: interactions.failures.length,
      runtimeExceptions: runtimeExceptions.length,
      totalFailures: allFailures.length + interactions.failures.length,
    },
    failures: allFailures,
    interactions,
    cases: results,
    runtimeExceptions,
    interceptedRequestCount: interceptedCalls.length,
    fixtureRequestCount: fixtureLog.length,
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(OUT, 'intercepted.json'), JSON.stringify(interceptedCalls, null, 2))
  fs.writeFileSync(path.join(OUT, 'fixture-requests.json'), JSON.stringify(fixtureLog, null, 2))
  fs.writeFileSync(path.join(OUT, 'fixture-server.log'), fixtureLog.map((entry) => `${entry.via} ${entry.method} ${entry.path}`).join('\n'))
  console.log(JSON.stringify({ out: OUT, completion: state, summary: report.summary, failures: allFailures.slice(0, 40), interactionFailures: interactions.failures }, null, 2))
  return report.summary.totalFailures
}

function cleanup() {
  try { ws?.close() } catch { /* ignore */ }
  taskkill(chromeProcess?.pid)
  taskkill(webProcess?.pid)
  try { fixtureServer.close() } catch { /* ignore */ }
  try {
    // Remove the debugging profile lock so a later run can reuse the directory.
    fs.rmSync(path.join(OUT, 'chrome-profile', 'SingletonLock'), { force: true })
  } catch { /* ignore */ }
}

const OVERALL_TIMEOUT_MS = Number(process.env.UI_REDESIGN_TIMEOUT_MS || 19 * 60 * 1000)
const watchdog = setTimeout(() => {
  try { writeReport('watchdog-timeout') } catch (error) { console.error('watchdog report failed', error) }
  cleanup()
  process.exit(2)
}, OVERALL_TIMEOUT_MS)
watchdog.unref?.()

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)),
])

try {
  await new Promise((resolve, reject) => { fixtureServer.once('error', reject); fixtureServer.listen(API_PORT, '127.0.0.1', resolve) })

  const serverLog = fs.openSync(path.join(OUT, 'next-server.log'), 'w')
  const mode = FORCE_DEV ? 'dev' : 'start'
  const webCommand = mode === 'dev'
    ? `pnpm --filter @musecanvas/web dev --port ${WEB_PORT}`
    : `pnpm --filter @musecanvas/web start --port ${WEB_PORT}`
  webProcess = spawn(webCommand, {
    shell: true,
    cwd: ROOT,
    env: {
      ...process.env,
      API_ORIGIN: FIXTURE_ORIGIN,
      INTERNAL_API_BASE_URL: FIXTURE_ORIGIN,
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', serverLog, serverLog],
  })

  const ready = await waitHttp(`${WEB_ORIGIN}/`, 180000)
  if (ready.status >= 400) throw new Error(`web server responded ${ready.status}`)
  completionState = { mode }

  // A stale lock from a killed run makes a fresh headless Chrome exit immediately.
  try { fs.rmSync(path.join(OUT, 'chrome-profile', 'SingletonLock'), { force: true }) } catch { /* ignore */ }

  chromeProcess = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${path.join(OUT, 'chrome-profile')}`,
    'about:blank',
  ], { stdio: 'ignore' })

  // Chrome needs a moment to bind the DevTools port; retry instead of a single fetch.
  let targets = null
  {
    const start = Date.now()
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${CHROME_PORT}/json`)
        if (response.ok) { targets = await response.json(); break }
      } catch { /* not listening yet */ }
      if (Date.now() - start > 60000) throw new Error('Chrome DevTools endpoint did not start')
      await delay(250)
    }
  }
  const pageTarget = targets.find((t) => t.type === 'page')
  ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const p = pending.get(message.id)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(message.id)
      if (message.error) p.reject(new Error(JSON.stringify(message.error)))
      else p.resolve(message.result)
      return
    }
    if (message.method === 'Fetch.requestPaused') void handlePaused(message.params)
    else if (message.method === 'Runtime.exceptionThrown') {
      runtimeExceptions.push(message.params.exceptionDetails?.exception?.description || JSON.stringify(message.params.exceptionDetails))
    }
  })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: `${WEB_ORIGIN}/api/*`, requestStage: 'Request' }] })

  const navigate = async (spec) => {
    await send('Emulation.setDeviceMetricsOverride', { width: spec.width, height: spec.height, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: spec.theme }, { name: 'prefers-reduced-motion', value: spec.motion }] })
    await setThemeScript(spec.theme)
    await send('Network.clearBrowserCookies')
    if (!ANON_ROUTES.has(spec.route)) {
      await send('Network.setCookie', { name: 'muse_session', value: SESSION_COOKIE, url: WEB_ORIGIN, httpOnly: true })
    }
    const loaded = waitForLoad()
    await send('Page.navigate', { url: `${WEB_ORIGIN}${routeHref(spec.route)}` })
    await loaded
    await delay(1100)
  }

  for (const spec of activeCases) {
    const caseResult = { ...spec, failures: [], measured: null, screenshot: null }
    try {
      await withTimeout(navigate(spec), 120000, `navigate ${spec.route} ${spec.width} ${spec.theme}`)
      const measured = await withTimeout(evalJs(MEASURE_SRC), 60000, `measure ${spec.route} ${spec.width} ${spec.theme}`)
      caseResult.measured = measured

      const fail = (name, detail) => caseResult.failures.push({ name, detail })

      if (measured.pathname !== spec.route) fail('route', { expected: spec.route, actual: measured.pathname, search: measured.search })
      if (measured.documentStatus && measured.documentStatus >= 400) fail('http-status', { status: measured.documentStatus })
      if (measured.theme !== spec.theme) fail('theme', { expected: spec.theme, actual: measured.theme })
      if (measured.h1Visible !== 1) fail('single-h1', { count: measured.h1Visible, total: measured.h1Count })
      if (measured.docOverflow > 1) fail('doc-overflow', { overflow: measured.docOverflow })
      if (measured.tablesUnscrollableWide > 0) fail('table-local-scroll', { tablesUnscrollableWide: measured.tablesUnscrollableWide, tables: measured.tables })
      if (measured.headerHeight !== null && Math.abs(measured.headerHeight - 56) > 1) fail('header-height', { height: measured.headerHeight })
      if (measured.zeroIconCount > 0) fail('zero-size-icons', { count: measured.zeroIconCount, sample: measured.zeroIcons })
      if (measured.contrastViolationCount > 0) fail('contrast', { count: measured.contrastViolationCount, sample: measured.contrastViolations.slice(0, 6) })
      if (measured.liveRegionCount > 6) fail('aria-live-count', { count: measured.liveRegionCount })

      const probe = ROUTE_PROBES[spec.route]
      if (probe && !measured.pageText.includes(probe)) fail('fixture-content', { probe, textHead: measured.pageText.slice(0, 160) })

      if (ADMIN_ROUTES.has(spec.route) && spec.width >= 960) {
        if (measured.adminSidebarWidth === null || Math.abs(measured.adminSidebarWidth - 260) > 1) {
          fail('admin-sidebar', { width: measured.adminSidebarWidth })
        }
      }
      if (spec.width >= 1440) {
        const tooWide = measured.frames.filter((f) => f.w > 1441)
        const offCenter = measured.frames.filter((f) => f.w >= 320 && f.offsetFromCenter > 1)
        if (tooWide.length) fail('content-frame-width', { frames: tooWide })
        if (offCenter.length) fail('content-frame-center', { frames: offCenter })
        // When the frame actually reaches its 1440 cap (wide viewport, no scrollbar
        // reduction) it carries a 32px gutter pair (paddingX is their sum, 64), so the
        // interior content box must be 1376 (+/-1). At a 1440 viewport a visible
        // scrollbar narrows the layout to ~1434 and the frame follows it, which is
        // correct responsive behaviour and is not asserted here.
        for (const frame of measured.frames) {
          if (frame.paddingX === 64 && frame.w >= 1440 && Math.abs(frame.inner - 1376) > 1) {
            fail('content-frame-inner', { frame })
          }
        }
      }
      if (spec.route === '/generate') {
        if (measured.scrollTimeline.length > 1) fail('generate-scroll', { regions: measured.scrollTimeline })
        if (measured.toolJsonScrollable > 0) fail('generate-tool-json-scroll', { count: measured.toolJsonScrollable })
      }

      const shot = await withTimeout(send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), 30000, 'screenshot')
      const shotName = `${slug(spec.route)}-${spec.width}x${spec.height}-${spec.theme}${spec.group === 'representative' ? '-rep' : ''}.png`
      fs.writeFileSync(path.join(OUT, shotName), Buffer.from(shot.data, 'base64'))
      caseResult.screenshot = shotName
    } catch (error) {
      caseResult.failures.push({ name: 'navigate/measure', detail: error instanceof Error ? error.message : String(error) })
    }
    results.push(caseResult)
  }

  // -------------------------------------------------------------------------
  // Interaction checks (1440 light)
  // -------------------------------------------------------------------------

  const interactionFail = (name, detail) => interactions.failures.push({ name, detail })

  // Lightbox + Escape (library)
  await navigate({ route: '/library', width: 1440, height: 900, theme: 'light', motion: 'no-preference' })
  const lightboxOpened = await evalJs(`(() => { const b = document.querySelector('button[aria-label="放大查看该作品"]'); if (!b) return false; b.click(); return true })()`)
  await delay(500)
  const dialogAfterOpen = await evalJs(`({ dialogs: document.querySelectorAll('[role="dialog"]').length })`)
  interactions.lightboxOpen = { clicked: lightboxOpened, ...dialogAfterOpen }
  if (!lightboxOpened || dialogAfterOpen.dialogs !== 1) interactionFail('lightbox-open', interactions.lightboxOpen)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await delay(500)
  const dialogAfterEscape = await evalJs(`document.querySelectorAll('[role="dialog"]').length`)
  interactions.lightboxEscape = { dialogsRemaining: dialogAfterEscape }
  if (dialogAfterEscape !== 0) interactionFail('lightbox-escape', interactions.lightboxEscape)

  // Tab reaches a control
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await delay(150)
  const focusInfo = await evalJs(`({ tag: document.activeElement.tagName, label: (document.activeElement.getAttribute('aria-label') || document.activeElement.textContent || '').trim().slice(0, 60) })`)
  interactions.tabFocus = focusInfo
  if (['BODY', 'HTML'].includes(focusInfo.tag)) interactionFail('tab-focus', focusInfo)

  // Generate task dialog + Escape
  await navigate({ route: '/generate', width: 1440, height: 900, theme: 'light', motion: 'no-preference' })
  const tasksOpened = await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('查看全部任务')); if (!b) return false; b.click(); return true })()`)
  await delay(500)
  const taskDialog = await evalJs(`document.querySelectorAll('[role="dialog"]').length`)
  interactions.taskDialogOpen = { clicked: tasksOpened, dialogs: taskDialog }
  if (!tasksOpened || taskDialog < 1) interactionFail('task-dialog-open', interactions.taskDialogOpen)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await delay(400)
  const taskDialogClosed = await evalJs(`document.querySelectorAll('[role="dialog"]').length`)
  interactions.taskDialogEscape = { dialogsRemaining: taskDialogClosed }
  if (taskDialogClosed !== 0) interactionFail('task-dialog-escape', interactions.taskDialogEscape)

  // Reduced motion still renders
  await navigate({ route: '/generate', width: 1440, height: 900, theme: 'light', motion: 'reduce' })
  const reduced = await evalJs(`({ h1: document.querySelectorAll('h1').length, buttons: document.querySelectorAll('button').length, overflow: document.documentElement.scrollWidth - innerWidth })`)
  interactions.reducedMotion = reduced
  if (reduced.h1 < 1 || reduced.buttons < 1 || reduced.overflow > 1) interactionFail('reduced-motion', reduced)

  // 200% root font size: no horizontal overflow, primary actions not clipped
  const zoomResults = {}
  for (const route of ['/', '/generate', '/library', '/admin']) {
    await navigate({ route, width: 1440, height: 900, theme: 'light', motion: 'no-preference' })
    const zoom = await evalJs(`(() => {
      document.documentElement.style.fontSize = '200%'
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const btns = [...document.querySelectorAll('button,a')].filter((el) => el.getBoundingClientRect().width > 0)
        const clipped = btns.filter((el) => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1 })
        resolve({ overflow: document.documentElement.scrollWidth - innerWidth, buttons: btns.length, clipped: clipped.length, clippedSample: clipped.slice(0, 3).map((el) => (el.textContent || '').trim().slice(0, 24)) })
      })))
    })()`)
    zoomResults[route] = zoom
    if (zoom.overflow > 1) interactionFail('zoom-overflow', { route, ...zoom })
    if (zoom.clipped > 0) interactionFail('zoom-clipped-action', { route, ...zoom })
  }
  interactions.textZoom = zoomResults

  // Counts must not just be small, they must be stable across widths/themes per route.
  const liveByRoute = {}
  for (const r of results) {
    if (!r.measured) continue
    if (!liveByRoute[r.route]) liveByRoute[r.route] = new Set()
    liveByRoute[r.route].add(r.measured.liveRegionCount)
  }
  const unstableLive = Object.entries(liveByRoute)
    .filter(([, set]) => Math.max(...set) - Math.min(...set) > 1)
    .map(([route, set]) => ({ route, counts: [...set] }))
  interactions.liveRegionStability = { byRoute: Object.fromEntries(Object.entries(liveByRoute).map(([route, set]) => [route, [...set]])), unstable: unstableLive }
  if (unstableLive.length) interactionFail('aria-live-unstable', unstableLive)

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------

  const totalFailures = writeReport('complete')
  cleanup()
  clearTimeout(watchdog)
  process.exit(totalFailures > 0 ? 1 : 0)
} catch (error) {
  fs.writeFileSync(path.join(OUT, 'failure.json'), JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : null, runtimeExceptions, interceptedCalls, fixtureLog }, null, 2))
  try { writeReport('error: ' + String(error)) } catch { /* ignore */ }
  console.error(error)
  cleanup()
  clearTimeout(watchdog)
  process.exit(1)
}
