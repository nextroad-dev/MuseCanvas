import { CanvasErrorCode as C, isCanvasUuid, parseCanvasAgentApplyRequest, parseCanvasAgentConfirmRequest, parseCanvasAgentMessageRequest, type CanvasAgentHistoryDto } from '@musecanvas/contracts'
import { callLanguageModelChat } from '../../../../../../packages/providers/src/index'
import type { AuthedContext } from '../../../router/types'
import { mutationOriginValid, fail, ok } from '../../../shared/http'
import { limited } from '../../../shared/redis'
import { createGenerationJob } from '../../generations/create-job'
import { safeError } from './config'
import { PgAgentStore, type AgentStore } from './store'
import { publicMessage, publicPending } from './history'
import { agentStream } from './sse'
import { runAgent } from './loop'
import { submitPending, type GenerationCreate } from './submit'

export function createCanvasAgentHandlers(deps: { store: AgentStore; chat: typeof callLanguageModelChat; create: GenerationCreate; limited: typeof limited }) {
  async function guard(context: AuthedContext, mutation: boolean) {
    if (context.actor.status !== 'active') return fail('FORBIDDEN', 'FORBIDDEN', 403)
    if (!isCanvasUuid(context.params.id)) return fail(C.INVALID_INPUT, 'Invalid canvas ID')
    if (mutation && !mutationOriginValid(context.request)) return fail('INVALID_ORIGIN', 'INVALID_ORIGIN', 403)
    if (await deps.limited(`canvas-agent:${context.actor.id}`, 30, 60)) return fail(C.CANVAS_AGENT_RATE_LIMITED, C.CANVAS_AGENT_RATE_LIMITED, 429)
    return undefined
  }
  return {
    async messages(context: AuthedContext) {
      const rejected = await guard(context, true); if (rejected) return rejected
      const parsed = parseCanvasAgentMessageRequest(await context.json())
      if (!parsed.success) return fail(parsed.error.code, 'Invalid agent request')
      try {
        const ctx = await deps.store.start(context.actor.id, context.params.id, parsed.data)
        return agentStream({ signal: context.request.signal, timeoutMs: Math.max(1, ctx.deadline - Date.now()),
          run: (send, signal) => runAgent({ ctx, actor: context.actor, store: deps.store, chat: deps.chat, create: deps.create, send, signal }),
          cleanup: () => ctx.replay || ctx.leaseReleased ? Promise.resolve() : deps.store.release(ctx, ctx.cleanupCode ?? C.CANVAS_AGENT_CANCELED) })
      } catch (error) { const e = safeError(error); return fail(e.code, e.message, e.status) }
    },
    async history(context: AuthedContext) {
      const rejected = await guard(context, false); if (rejected) return rejected
      const query = context.request.nextUrl.searchParams
      const after = query.get('afterSeq'), before = query.get('beforeSeq'), count = query.get('limit') ?? '50'
      if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 100) return fail(C.INVALID_INPUT, 'Invalid history pagination')
      if (after !== null && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)) || Number(after) > 2147483647)) return fail(C.INVALID_INPUT, 'Invalid history pagination')
      if (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)) || Number(before) < 1 || Number(before) > 2147483647)) return fail(C.INVALID_INPUT, 'Invalid history pagination')
      try {
        const page = await deps.store.history(context.actor.id, context.params.id, after !== null ? Number(after) : 0, Number(count), before !== null ? Number(before) : undefined)
        const dto: CanvasAgentHistoryDto = { sessionId: page.scope.sessionId, messages: page.messages.map(publicMessage), pendingJobs: page.pending.map(publicPending),
          requireConfirmation: page.session.requireConfirmation, autoContinuationCount: page.session.autoContinuationCount, nextAfterSeq: page.nextAfterSeq, ...(page.nextBeforeSeq !== undefined ? { nextBeforeSeq: page.nextBeforeSeq } : {}) }
        return ok(dto)
      } catch (error) { const e = safeError(error); return fail(e.code, e.message, e.status) }
    },
    async turn(context: AuthedContext) {
      const rejected = await guard(context, false); if (rejected) return rejected
      if (!isCanvasUuid(context.params.turnId)) return fail(C.INVALID_INPUT, 'Invalid turn ID')
      try { return ok(await deps.store.turn(context.actor.id, context.params.id, context.params.turnId)) }
      catch (error) { const e = safeError(error); return fail(e.code, e.message, e.status) }
    },
    async confirm(context: AuthedContext) {
      const rejected = await guard(context, true); if (rejected) return rejected
      const parsed = parseCanvasAgentConfirmRequest(await context.json())
      if (!parsed.success) return fail(parsed.error.code, 'Invalid confirmation')
      const abort = new AbortController()
      const cancel = () => abort.abort('canceled')
      context.request.signal.addEventListener('abort', cancel, { once: true })
      if (context.request.signal.aborted) cancel()
      const timer = setTimeout(() => abort.abort('timeout'), 120_000)
      try {
        const pending = await submitPending(deps.store, context.actor, context.params.id, parsed.data, deps.create, abort.signal, 120_000)
        return ok({ pending: publicPending(pending), ops: pending.status === 'submitted' ? pending.ops : [], jobId: pending.jobId })
      } catch (error) { const e = safeError(error); return fail(e.code, e.message, e.status) }
      finally { clearTimeout(timer); context.request.signal.removeEventListener('abort', cancel) }
    },
    async apply(context: AuthedContext) {
      const rejected = await guard(context, true); if (rejected) return rejected
      const parsed = parseCanvasAgentApplyRequest(await context.json())
      if (!parsed.success) return fail(parsed.error.code, 'Invalid apply request')
      try {
        const result = await deps.store.apply(context.actor.id, context.params.id, parsed.data.turnId)
        if (result.status === 'applied' || result.status === 'replay') {
          return ok({ applied: true, revision: result.revision, ops: result.ops })
        }
        const code = 'code' in result ? result.code : undefined
        if (result.status === 'not_found') return fail(C.CANVAS_NOT_FOUND, 'Canvas or turn not found', 404)
        if (result.status === 'conflict') return fail((code as any) ?? C.CANVAS_REVISION_CONFLICT, 'Apply conflict', 409)
        return fail((code as any) ?? C.INVALID_INPUT, 'Invalid operations', 400)
      } catch (error) { const e = safeError(error); return fail(e.code, e.message, e.status) }
    },
    async status(context: AuthedContext) {
      if (context.actor.status !== 'active') return fail('FORBIDDEN', 'FORBIDDEN', 403)
      try {
        const statusDto = await deps.store.status()
        return ok(statusDto)
      } catch (error) { const e = safeError(error); return fail(e.code, e.message, e.status) }
    },
  }
}
const handlers = createCanvasAgentHandlers({ store: new PgAgentStore(), chat: callLanguageModelChat, create: createGenerationJob, limited })
export const postCanvasAgentMessages = handlers.messages
export const getCanvasAgentHistory = handlers.history
export const postCanvasAgentConfirm = handlers.confirm
export const postCanvasAgentApply = handlers.apply
export const getCanvasAgentStatus = handlers.status

export const getCanvasAgentTurn = handlers.turn
