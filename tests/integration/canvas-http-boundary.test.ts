import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { API_ENDPOINTS } from '../../packages/contracts/src/endpoints'

// Explicit integration check: build apps/api first, then run with its tsx loader.
// It starts the real production catch-all but deliberately uses no session or DB
// credentials. This proves only the anonymous/Origin boundary, not the LLM/PG flow.
test('production Next canvas routes reject anonymous access and invalid mutation Origins', { timeout: 60_000 }, async () => {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const apiDir = fileURLToPath(new URL('../../apps/api/', import.meta.url))
  const require = createRequire(new URL('../../apps/api/package.json', import.meta.url))
  const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: apiDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  })
  let log = ''
  child.stdout.on('data', chunk => { log = (log + String(chunk)).slice(-4000) })
  child.stderr.on('data', chunk => { log = (log + String(chunk)).slice(-4000) })
  const exited = once(child, 'exit')
  const origin = `http://127.0.0.1:${port}`
  const id = '11111111-1111-4111-8111-111111111111'
  const operations: Array<[string, string]> = [
    ['GET', API_ENDPOINTS.canvases.list], ['POST', API_ENDPOINTS.canvases.create],
    ['GET', API_ENDPOINTS.canvases.detail(id)], ['PATCH', API_ENDPOINTS.canvases.update(id)],
    ['DELETE', API_ENDPOINTS.canvases.remove(id)], ['POST', API_ENDPOINTS.canvases.agent.messages(id)],
    ['GET', API_ENDPOINTS.canvases.agent.turn(id, id)], ['GET', API_ENDPOINTS.canvases.agent.history(id)], ['POST', API_ENDPOINTS.canvases.agent.confirm(id)],
    ['POST', API_ENDPOINTS.canvases.agent.apply(id)], ['GET', API_ENDPOINTS.canvasAgent.status],
    ['GET', API_ENDPOINTS.admin.canvasAgentSettings], ['PATCH', API_ENDPOINTS.admin.canvasAgentSettings],
  ]
  try {
    const deadline = Date.now() + 30_000
    let ready = false
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Next exited before ready: ${log}`)
      try {
        const response = await fetch(origin + API_ENDPOINTS.canvases.list, { signal: AbortSignal.timeout(1000) })
        await response.arrayBuffer()
        if (response.status === 401) { ready = true; break }
      } catch { /* Readiness retry for this local test server only. */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ready, `Next canvas auth boundary was not ready: ${log}`)
    for (const [method, path] of operations) {
      const mutation = method !== 'GET'
      const response = await fetch(origin + path, {
        method, headers: mutation ? { 'Content-Type': 'application/json' } : {},
        body: mutation ? '{}' : undefined, signal: AbortSignal.timeout(5000),
      })
      assert.equal(response.status, 401, `${method} ${path}`)
      const body = await response.json()
      assert.equal(body.success, false)
      assert.equal(body.error.code, 'UNAUTHORIZED')
      if (mutation) {
        const rejected = await fetch(origin + path, {
          method, headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.invalid' },
          body: '{}', signal: AbortSignal.timeout(5000),
        })
        assert.equal(rejected.status, 403, `${method} ${path} Origin`)
        const error = await rejected.json()
        assert.equal(error.success, false)
        assert.equal(error.error.code, 'CSRF_REJECTED')
      }
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await exited
  }
})
