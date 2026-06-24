import assert from 'node:assert/strict'

const base = process.env.BASE_URL || 'http://localhost:8080'
const mailpit = process.env.MAILPIT_URL || 'http://localhost:8025'
const email = process.env.ADMIN_EMAIL || 'admin@musecanvas.local'

async function json(path, init = {}) {
  const response = await fetch(`${base}${path}`, init)
  const payload = await response.json()
  return { response, payload }
}

const requested = await json('/api/auth/otp/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
assert.equal(requested.response.status, 200)

let code
for (let attempt = 0; attempt < 10 && !code; attempt++) {
  const messages = await fetch(`${mailpit}/api/v1/messages`).then(response => response.json())
  const message = messages.messages.find(item => item.To?.some(to => to.Address === email))
  code = message?.Snippet.match(/\b\d{6}\b/)?.[0]
  if (!code) await new Promise(resolve => setTimeout(resolve, 500))
}
assert.ok(code, 'administrator OTP was not delivered')

const verified = await json('/api/auth/otp/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) })
assert.equal(verified.payload.data.user.role, 'admin')
const cookie = verified.response.headers.get('set-cookie')?.split(';')[0]
assert.ok(cookie)

for (const endpoint of ['dashboard', 'registration', 'smtp', 'users', 'models', 'model-presets', 'jobs']) {
  const result = await json(`/api/admin/${endpoint}`, { headers: { cookie } })
  assert.equal(result.response.status, 200, endpoint)
  assert.equal(result.payload.success, true, endpoint)
  if (endpoint === 'registration') assert.equal(typeof result.payload.data.requiresInvitation, 'boolean')
  if (endpoint === 'jobs') {
    const serialized = JSON.stringify(result.payload).toLowerCase()
    for (const forbidden of ['prompt', 'object_key', 'objectkey', 'imageurl', 'b64_json']) assert.equal(serialized.includes(forbidden), false, forbidden)
  }
  if (endpoint === 'model-presets') {
    assert.ok(result.payload.data.length >= 4)
    for (const preset of result.payload.data) assert.ok(preset.baseUrl.startsWith('https://'))
  }
}

const invitation = await json('/api/admin/invitations', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ignored@example.com', count: 5 }) })
assert.equal(invitation.response.status, 200)
assert.equal(invitation.payload.success, true)
assert.equal(typeof invitation.payload.data.code, 'string')
assert.equal('email' in invitation.payload.data, false)

const anonymous = await json('/api/admin/dashboard')
assert.equal(anonymous.response.status, 401)
console.log('admin panel e2e smoke passed')
