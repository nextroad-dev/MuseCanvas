import assert from 'node:assert/strict'
import test from 'node:test'
import { initializeObservability, normalizeOtlpTraceEndpoint, shutdownObservability, withSpan } from './index'

test('disabled endpoint returns false without starting telemetry', async () => {
  const previous = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  try {
    assert.equal(await initializeObservability('test-service'), false)
  } finally {
    if (previous !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous
  }
})

test('normalizes base endpoint and preserves explicit traces endpoint', () => {
  assert.equal(normalizeOtlpTraceEndpoint('https://collector.example/otel'), 'https://collector.example/otel/v1/traces')
  assert.equal(normalizeOtlpTraceEndpoint('http://localhost:4318/v1/traces'), 'http://localhost:4318/v1/traces')
})

test('rejects unsafe or unsupported endpoints', () => {
  for (const endpoint of [
    'ftp://collector.example',
    'https://user:secret@collector.example',
    'https://collector.example?token=secret',
    'https://collector.example/#fragment',
    'not a url',
  ]) assert.equal(normalizeOtlpTraceEndpoint(endpoint), undefined)
})

test('runs callback transparently when telemetry is disabled', async () => {
  const expected = { value: 42 }
  assert.equal(await withSpan('operation', { safe: true }, async () => expected), expected)
})

test('shutdown is a no-op when telemetry is disabled', async () => {
  await shutdownObservability()
})
