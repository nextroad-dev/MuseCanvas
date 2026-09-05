import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NextRequest } from 'next/server'
import { clientIpFromRequest, mutationOriginValid } from './http'

const requestWith = (headers: Record<string, string>): NextRequest =>
  ({ headers: new Headers(headers) }) as unknown as NextRequest

test('clientIpFromRequest takes the rightmost X-Forwarded-For entry', () => {
  const request = requestWith({ 'x-forwarded-for': '1.2.3.4, 10.0.0.9, 203.0.113.7' })
  assert.equal(clientIpFromRequest(request), '203.0.113.7')
})

test('clientIpFromRequest falls back to x-real-ip then unknown', () => {
  assert.equal(clientIpFromRequest(requestWith({ 'x-real-ip': '198.51.100.2' })), '198.51.100.2')
  assert.equal(clientIpFromRequest(requestWith({})), 'unknown')
})

test('clientIpFromRequest tolerates blank entries', () => {
  assert.equal(clientIpFromRequest(requestWith({ 'x-forwarded-for': ' , 203.0.113.9 ' })), '203.0.113.9')
})

test('mutationOriginValid allows requests without an Origin header', () => {
  assert.equal(mutationOriginValid(requestWith({ host: 'studio.example.com' })), true)
})

test('mutationOriginValid accepts matching host and x-forwarded-host candidates', () => {
  assert.equal(mutationOriginValid(requestWith({ host: 'studio.example.com', origin: 'https://studio.example.com' })), true)
  assert.equal(mutationOriginValid(requestWith({ 'x-forwarded-host': 'studio.example.com', origin: 'https://studio.example.com' })), true)
  assert.equal(mutationOriginValid(requestWith({ host: 'STUDIO.example.com', origin: 'https://studio.example.com' })), true)
})

test('mutationOriginValid ignores client-injected leading x-forwarded-host entries', () => {
  const request = requestWith({ 'x-forwarded-host': 'evil.example.net, studio.example.com', origin: 'https://evil.example.net' })
  assert.equal(mutationOriginValid(request), false)
  assert.equal(mutationOriginValid(requestWith({ 'x-forwarded-host': 'evil.example.net, studio.example.com', origin: 'https://studio.example.com' })), true)
})

test('mutationOriginValid rejects foreign origins and malformed URLs', () => {
  assert.equal(mutationOriginValid(requestWith({ host: 'studio.example.com', origin: 'https://evil.example.net' })), false)
  assert.equal(mutationOriginValid(requestWith({ host: 'studio.example.com', origin: 'not-a-url' })), false)
  assert.equal(mutationOriginValid(requestWith({ origin: 'https://studio.example.com' })), false)
})
