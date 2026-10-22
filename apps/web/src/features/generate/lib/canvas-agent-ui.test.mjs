import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  agentScopeChanged,
  canConfirmPending,
  pendingStatusLabel,
  resolveAgentAvailability,
} from './agent-turn-state.ts'
import { createAgentSubmitLock } from './agent-stream.ts'

function pending(extra = {}) {
  return {
    id: 'p1',
    toolCallId: 'c1',
    kind: 'image',
    prompt: 'a cat',
    modelId: 'model-1',
    parameters: {},
    sourceNodeId: null,
    sourceAssetId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    status: 'pending',
    jobId: null,
    ...extra,
  }
}

function source(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

// The Agent UI modules. The console is now the only execution path on `/generate`,
// so it is included in the tripwire: none of these files may reach a direct
// generation/image-edit submit or hardcode an `/api` path.
const AGENT_UI_FILES = [
  './agent-stream.ts',
  './agent-turn-state.ts',
  './agent-composer.ts',
  './agent-confirmation.ts',
  './agent-continuation.ts',
  './canvas-api.ts',
  './canvas-query-keys.ts',
  '../components/conversation-sidebar.tsx',
  '../components/conversation-timeline.tsx',
  '../components/agent-message.tsx',
  '../components/agent-composer.tsx',
  '../components/pending-generation-card.tsx',
  '../components/generation-result-card.tsx',
  '../components/result-dialog.tsx',
  '../components/generation-task-panel.tsx',
  '../components/generate-console.tsx',
  '../../../shared/hooks/useCanvases.ts',
  '../../../shared/hooks/useCanvasAgent.ts',
]

test('submit lock rejects a duplicate activation until it is released', () => {
  const lock = createAgentSubmitLock()
  assert.equal(lock.tryLock(), true)
  assert.equal(lock.tryLock(), false)
  assert.equal(lock.locked, true)
  lock.unlock()
  assert.equal(lock.locked, false)
  assert.equal(lock.tryLock(), true)
})

test('actor scope change is detected so the stream can be aborted and the timeline cleared', () => {
  assert.equal(agentScopeChanged('user-a', 'user-a'), false)
  assert.equal(agentScopeChanged('user-a', 'user-b'), true)
  assert.equal(agentScopeChanged('', null), false)
  assert.equal(agentScopeChanged('user-a', null), true)

  const hook = source('../../../shared/hooks/useCanvasAgent.ts')
  assert.match(hook, /agentScopeChanged/)
  assert.match(hook, /senderRef\.current\?\.stop\(\)/)
  assert.match(hook, /updateTimeline\(\(\) => createAgentTimeline\(\)\)/)
  // Confirmations, apply feedback and the previous actor's cached conversation state
  // are all cleared on the same switch.
  assert.match(hook, /setConfirmations\(createConfirmationState\(\)\)/)
  assert.match(hook, /setApplyFeedback\(null\)/)
  assert.match(hook, /actorScopedCanvasQueryKeys\(previous\)/)
  // Unmount cleanup aborts the stream too.
  assert.match(hook, /useEffect\(\(\) => \(\) => \{[\s\S]*?senderRef\.current\?\.stop\(\)/)
})

test('cost-related confirmation is gated on a still-actionable pending proposal', () => {
  const now = Date.UTC(2026, 0, 1)
  assert.equal(canConfirmPending(pending(), now), true)
  assert.equal(canConfirmPending(pending({ status: 'submitting' }), now), false)
  assert.equal(canConfirmPending(pending({ status: 'submitted' }), now), false)
  assert.equal(canConfirmPending(pending({ status: 'rejected' }), now), false)
  assert.equal(canConfirmPending(pending({ status: 'expired' }), now), false)
  assert.equal(canConfirmPending(pending({ expiresAt: '2025-12-31T00:00:00.000Z' }), now), false)
  assert.equal(pendingStatusLabel('pending'), '等待确认')
  assert.equal(pendingStatusLabel('submitted'), '已提交生成')
})

test('a disabled or unconfigured Agent still keeps history, library and downloads usable', () => {
  for (const reason of ['disabled', 'not_configured', 'model_unsupported']) {
    const availability = resolveAgentAvailability({ enabled: false, available: false, reason, maxToolCallsPerTurn: 12, maxJobsPerTurn: 4, timeoutMs: 120000, maxAutoContinuations: 3 })
    assert.equal(availability.canGenerate, false)
    assert.equal(availability.historyUsable, true)
    assert.match(availability.notice, /历史/)
  }
  const ready = resolveAgentAvailability({ enabled: true, available: true, reason: 'ready', maxToolCallsPerTurn: 12, maxJobsPerTurn: 4, timeoutMs: 120000, maxAutoContinuations: 3 })
  assert.equal(ready.canGenerate, true)
  assert.equal(ready.notice, null)
  // Unknown status (still loading) never enables generation.
  assert.equal(resolveAgentAvailability(undefined).canGenerate, false)
})

test('the Agent UI never calls the direct generation or image-edit path, and never hardcodes /api', () => {
  const forbidden = [/useCreateJob\b/, /useCreateJobMutation\b/, /useCreateImageEdit\b/, /useCreateImageEditMutation\b/, /createGeneration\b/, /API_ENDPOINTS\.images\.edit/, /createGenerationUpload\b/]
  for (const file of AGENT_UI_FILES) {
    const text = source(file)
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${file} must not reference ${pattern}`)
    }
    assert.doesNotMatch(text, /["'`]\/api\/[a-z]/i, `${file} must use API_ENDPOINTS, not a hardcoded /api path`)
  }
})

test('every Agent turn is sent with requireConfirmation and agent-managed scene commit', () => {
  const composer = source('./agent-composer.ts')
  assert.match(composer, /requireConfirmation:\s*true/)
  assert.match(composer, /sceneCommitMode:\s*'agent-managed'/)
  // The hook routes every user send and every continuation through that one builder.
  const hook = source('../../../shared/hooks/useCanvasAgent.ts')
  assert.match(hook, /createComposerSender/)
  assert.match(hook, /sendUserMessage/)
  assert.match(hook, /sendJobEvent/)
})

test('actor-scoped TanStack keys embed the actor so a new actor cannot reuse the old conversation', async () => {
  const { canvasListQueryKey, canvasDetailQueryKey, canvasAgentHistoryQueryKey, actorScopedCanvasQueryKeys } = await import('./canvas-query-keys.ts')
  assert.deepEqual(canvasListQueryKey('user-a'), ['canvases', 'user-a', 'list'])
  assert.deepEqual(canvasDetailQueryKey('user-a', 'c1'), ['canvases', 'user-a', 'detail', 'c1'])
  assert.deepEqual(canvasAgentHistoryQueryKey('user-a', 'c1'), ['canvas-agent', 'user-a', 'history', 'c1'])
  assert.notDeepEqual(canvasAgentHistoryQueryKey('user-a', 'c1'), canvasAgentHistoryQueryKey('user-b', 'c1'))
  assert.deepEqual(actorScopedCanvasQueryKeys('user-a'), [['canvases', 'user-a'], ['canvas-agent', 'user-a']])
})

test('the composer measures only while visible, never submits during an IME composition, and scrolls long text inside itself', () => {
  const composer = source('../components/agent-composer.tsx')
  // A hidden textarea reports scrollHeight 0; the guard keeps it from collapsing.
  assert.match(composer, /offsetParent === null/)
  // Ctrl/Cmd+Enter must not fire mid-composition.
  assert.match(composer, /isComposing/)
  // Long drafts scroll inside the textarea instead of stretching the composer.
  assert.match(composer, /overflow-y-auto/)
  assert.match(composer, /MAX_TEXTAREA_PX/)
  // The composer is a context author, never a direct submitter.
  assert.doesNotMatch(composer, /useCreateJob|useCreateImageEdit|createGeneration/)
})

test('a completed unapplied turn is recovered after history load and only a newer turn re-arms it', () => {
  const hook = source('../../../shared/hooks/useCanvasAgent.ts')
  // The recovery trigger exists and is fed by the pure planner over the live timeline.
  assert.match(hook, /planApplyRecovery\(timelineRef\.current, applyAttemptedTurnIdsRef\.current\)/)
  // Never while a turn is streaming, and never twice: the attempt set is consulted
  // and written inside the single apply entry point.
  assert.match(hook, /if \(streaming\) return/)
  assert.match(hook, /applyAttemptedTurnIdsRef\.current\.has\(turnId\)/)
  assert.match(hook, /applyAttemptedTurnIdsRef\.current\.add\(turnId\)/)
  // Recovery is keyed on the newest ops turn: a refetch or a backward page that only
  // adds older pre-existing turns changes nothing, while a genuinely newer turn (a
  // mid-session disconnect) re-arms exactly one pass, and that pass may only apply
  // the newer turn — never an older pre-existing one.
  assert.match(hook, /unappliedOpsTurnIds\(timelineRef\.current\)/)
  assert.match(hook, /applyRecoveryNewestRef/)
  assert.match(hook, /if \(applyRecoveryNewestRef\.current === newest\) return/)
  assert.match(hook, /if \(turnId !== newest\) return/)
  assert.match(hook, /if \(!historyQuery\.data\) return/)
  // Every apply path (live done, confirm, recovery) goes through that one entry point.
  assert.match(hook, /requestApply\(event\.turnId\)/)
  assert.equal((hook.match(/applyRef\.current\.mutate\(/g) ?? []).length, 1, 'apply is invoked from exactly one place')
  // Apply and confirm refresh the shared job + library reads so the committed
  // scene's result assets are re-read from the server, not assumed.
  assert.match(hook, /JOBS_QUERY_KEY/)
  assert.match(hook, /LIBRARY_QUERY_KEY/)
  // A conversation switch resets the timeline, the attempt set and the recovery
  // baseline, and aborts the abandoned stream, so recovery can never apply a turn
  // from the previous canvas against the new one.
  assert.match(hook, /previousCanvasIdRef/)
  assert.match(hook, /senderRef\.current\?\.stop\(\)/)
})

test('a conversation switch aborts the abandoned stream and stream callbacks are canvas- and actor-scoped', () => {
  const hook = source('../../../shared/hooks/useCanvasAgent.ts')
  // The switch effect stops the sender before clearing state (one of at least the
  // switch, actor-switch and unmount stops).
  assert.ok((hook.match(/senderRef\.current\?\.stop\(\)/g) ?? []).length >= 3, 'switch, actor switch and unmount each abort')
  // Every stream callback receives its dispatch canvas and ignores events once the
  // live canvas has moved on (no timeline leak, no cross-canvas apply, no stale
  // settle clearing the new stream). The actor half covers an in-place actor change
  // that happens to reuse the same canvas id.
  assert.match(hook, /onRequest: \(request, canvas\)/)
  assert.match(hook, /onEvent: \(event, canvas\)/)
  assert.match(hook, /onSettled: \(outcome, canvas\)/)
  assert.ok((hook.match(/canvas !== latestRef\.current\.canvasId/g) ?? []).length >= 3, 'request/event/settled are all canvas-scoped')
  assert.ok((hook.match(/dispatchActorRef\.current !== latestRef\.current\.actorId/g) ?? []).length >= 3, 'request/event/settled are all actor-scoped')
  // The first message of a just-created conversation must not be dropped by that
  // guard: send() syncs the live canvas fact before dispatching.
  assert.match(hook, /latestRef\.current = \{ \.\.\.latestRef\.current, canvasId: canvas \}/)
  assert.match(hook, /dispatchActorRef\.current = latestRef\.current\.actorId/)
})
