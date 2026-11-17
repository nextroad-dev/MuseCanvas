import { NextResponse, type NextRequest } from 'next/server'
import { AgentCoreError } from '@musecanvas/database'
import { requireActor } from '../../router/guard'
import type { Actor } from '../../auth/security'
import { fail, mutationOriginValid, ok } from '../../shared/http'
import { limited } from '../../shared/redis'
import { agentControlPort, type AgentControlPort } from './service'
import { approvalInput, boundedBody, createSessionInput, emptyInput, eventCursor, messageInput, pageQuery, uuid } from './validation'
import { agentReplay } from './sse'
import { agentCoreEnabled, agentCoreAdmissionReady } from './feature'

export interface AgentHandlerContext { request: NextRequest; params: Record<string, string> }
interface AgentHandlerPorts {
  control: AgentControlPort
  enabled: () => boolean
  admissionReady: () => boolean
  authorize: (request: NextRequest) => Promise<Actor | NextResponse>
  limited: (key: string, max: number, seconds: number) => Promise<boolean>
}
export function agentErrorResponse(error: unknown): NextResponse {
  const code = error instanceof AgentCoreError ? error.code : 'UNAVAILABLE'
  const status = code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' || code === 'CURSOR_AHEAD' ? 409 : code === 'INVALID_INPUT' ? 400 : 503
  return fail(code, status === 404 ? '接口不存在' : status === 503 ? 'Agent Core 暂不可用' : 'Agent Core 请求无效', status)
}
/** Router delegates auth here deliberately: disabled feature must not open a DB connection even for session authentication. */
export function createAgentHandlers(ports: AgentHandlerPorts) {
  const wrap = (operation: (context: AgentHandlerContext, actor: Actor) => Promise<NextResponse>, mutation = false) =>
    async (context: AgentHandlerContext): Promise<NextResponse> => {
      if (!ports.enabled()) return fail('NOT_FOUND', '接口不存在', 404)
      try {
        if (mutation && !mutationOriginValid(context.request)) return fail('CSRF_REJECTED', '请求来源无效', 403)
        const actor = await ports.authorize(context.request)
        if (actor instanceof NextResponse) return actor
        if (actor.status !== 'active') return fail('FORBIDDEN', '账号已停用', 403)
        if (context.params.id !== undefined) uuid(context.params.id)
        // Body clientRequestId/clientMessageId is the sole authority; no shadow header identity.
        if (context.request.headers.has('idempotency-key')) throw new AgentCoreError('INVALID_INPUT')
        if (context.request.headers.has('last-event-id') && !context.request.nextUrl.pathname.endsWith('/events')) throw new AgentCoreError('INVALID_INPUT')
        if (await ports.limited(`agent-core:${mutation ? 'write' : 'read'}:${actor.id}`, mutation ? 30 : 90, 60)) return fail('RATE_LIMITED', '请求过于频繁', 429)
        return await operation(context, actor)
      } catch (error) { return agentErrorResponse(error) }
    }
  const noQuery = (request: NextRequest) => { if (request.nextUrl.search) throw new AgentCoreError('INVALID_INPUT') }
  return {
    createSession: wrap(async ({ request }, actor) => {
      noQuery(request)
      return ok(await ports.control.createSession(actor.id, createSessionInput(await boundedBody(request)), ports.admissionReady()), { status: 202 })
    }, true),
    listSessions: wrap(async ({ request }, actor) => {
      const q = pageQuery(request.nextUrl, 'sessions')
      return ok(await ports.control.listSessions(actor.id, q.limit, q.cursor))
    }),
    snapshot: wrap(async ({ request, params }, actor) => {
      const q = pageQuery(request.nextUrl, 'snapshot')
      return ok(await ports.control.snapshot(actor.id, uuid(params.id), q.limit))
    }),
    items: wrap(async ({ request, params }, actor) => {
      const q = pageQuery(request.nextUrl, 'items')
      return ok(await ports.control.items(actor.id, uuid(params.id), q.cursor ?? '0', q.limit))
    }),
    events: wrap(async ({ request, params }, actor) => {
      const q = pageQuery(request.nextUrl, 'events'), sessionId = uuid(params.id)
      const cursor = eventCursor(sessionId, q.cursor, request.headers.get('last-event-id'))
      const first = await ports.control.events(actor.id, sessionId, cursor, q.limit)
      return agentReplay({ sessionId, cursor, first, signal: request.signal,
        poll: after => ports.control.events(actor.id, sessionId, after, q.limit) })
    }),
    message: wrap(async ({ request, params }, actor) => {
      noQuery(request)
      return ok(await ports.control.message(actor.id, uuid(params.id), messageInput(await boundedBody(request)), ports.admissionReady()), { status: 202 })
    }, true),
    steer: wrap(async ({ request, params }, actor) => {
      noQuery(request)
      return ok(await ports.control.steer(actor.id, uuid(params.id), messageInput(await boundedBody(request))), { status: 202 })
    }, true),
    turn: wrap(async ({ request, params }, actor) => { noQuery(request); return ok(await ports.control.getTurn(actor.id, uuid(params.id))) }),
    cancel: wrap(async ({ request, params }, actor) => {
      noQuery(request); emptyInput(await boundedBody(request))
      return ok(await ports.control.cancel(actor.id, uuid(params.id)), { status: 202 })
    }, true),
    resolveApproval: wrap(async ({ request, params }, actor) => {
      noQuery(request)
      const result = await ports.control.resolveApproval(actor.id, uuid(params.id), approvalInput(await boundedBody(request)))
      return result.expired ? NextResponse.json({ success: false, error: { code: 'APPROVAL_EXPIRED', message: '审批已过期' }, data: result.approval }, { status: 409 })
        : ok(result.approval, { status: 202 })
    }, true),
  }
}
export const agentHandlers = createAgentHandlers({ control: agentControlPort, enabled: agentCoreEnabled,
  admissionReady: agentCoreAdmissionReady, authorize: requireActor, limited })
