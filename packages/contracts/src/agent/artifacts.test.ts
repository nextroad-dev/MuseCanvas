import assert from 'node:assert/strict'
import test from 'node:test'
import { API_ENDPOINTS } from '../endpoints'

test('Agent artifact endpoint helpers preserve the session-scoped REST paths', () => {
  const sessionId = '12345678-1234-1234-1234-123456789abc'
  const artifactId = 'text:23456789-2345-2345-2345-23456789abcd'
  const threadId = '3456789a-3456-3456-3456-3456789abcde'
  const artifactsPath = `/api/agent/sessions/${sessionId}/artifacts`
  const artifactPath = `${artifactsPath}/text%3A23456789-2345-2345-2345-23456789abcd`
  assert.equal(API_ENDPOINTS.agent.artifacts(sessionId), artifactsPath)
  assert.equal(API_ENDPOINTS.agent.artifact(sessionId, artifactId), artifactPath)
  assert.equal(API_ENDPOINTS.agent.artifactThreads(sessionId, artifactId), `${artifactPath}/threads`)
  assert.equal(API_ENDPOINTS.agent.artifactThread(sessionId, artifactId, threadId), `${artifactPath}/threads/${threadId}`)
  assert.equal(API_ENDPOINTS.agent.artifactThreadReplies(sessionId, artifactId, threadId), `${artifactPath}/threads/${threadId}/replies`)
})

test('Agent artifact endpoint helpers URI-encode every dynamic segment independently', () => {
  const sessionId = 'session/one ?#%'
  const artifactId = 'media:asset/二?%'
  const threadId = 'thread/reply #&%'
  const artifactsPath = '/api/agent/sessions/session%2Fone%20%3F%23%25/artifacts'
  const artifactPath = `${artifactsPath}/media%3Aasset%2F%E4%BA%8C%3F%25`
  const threadPath = `${artifactPath}/threads/thread%2Freply%20%23%26%25`
  assert.equal(API_ENDPOINTS.agent.artifacts(sessionId), artifactsPath)
  assert.equal(API_ENDPOINTS.agent.artifact(sessionId, artifactId), artifactPath)
  assert.equal(API_ENDPOINTS.agent.artifactThreads(sessionId, artifactId), `${artifactPath}/threads`)
  assert.equal(API_ENDPOINTS.agent.artifactThread(sessionId, artifactId, threadId), threadPath)
  assert.equal(API_ENDPOINTS.agent.artifactThreadReplies(sessionId, artifactId, threadId), `${threadPath}/replies`)
})
