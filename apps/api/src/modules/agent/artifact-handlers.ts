import { NextResponse, type NextRequest } from 'next/server'
import { AgentArtifactsRepository, AgentCoreError, artifactIdentity, artifactPageQuery, artifactReplyInput, artifactResolveInput, artifactThreadInput, artifactUuid } from '@musecanvas/database'
import type { Actor } from '../../auth/security'
import { requireActor } from '../../router/guard'
import { fail, mutationOriginValid, ok } from '../../shared/http'
import { limited } from '../../shared/redis'
import { agentCoreEnabled } from './feature'
import { agentErrorResponse, type AgentHandlerContext } from './handlers'
import { agentCoreTransaction } from './service'
import { boundedBody } from './validation'

export type AgentArtifactsPort = Pick<AgentArtifactsRepository, 'list' | 'detail' | 'threads' | 'thread' | 'createThread' | 'reply' | 'resolve'>
interface ArtifactHandlerPorts {
  artifacts: AgentArtifactsPort
  enabled: () => boolean
  authorize: (request: NextRequest) => Promise<Actor | NextResponse>
  limited: (key: string, max: number, seconds: number) => Promise<boolean>
}
function identity(value: string): string {
  try { return artifactIdentity(decodeURIComponent(value)) } catch { throw new AgentCoreError('INVALID_INPUT') }
}
function noQuery(request: NextRequest) { if (request.nextUrl.search) throw new AgentCoreError('INVALID_INPUT') }
/** Deliberately public router entries: the feature gate precedes auth/DB/rate IO. */
export function createAgentArtifactHandlers(ports: ArtifactHandlerPorts) {
  const wrap = (operation: (context: AgentHandlerContext, actor: Actor) => Promise<NextResponse>, mutation = false) =>
    async (context: AgentHandlerContext): Promise<NextResponse> => {
      if (!ports.enabled()) return fail('NOT_FOUND', '接口不存在', 404)
      try {
        if (mutation && !mutationOriginValid(context.request)) return fail('CSRF_REJECTED', '请求来源无效', 403)
        const actor = await ports.authorize(context.request)
        if (actor instanceof NextResponse) return actor
        if (actor.status !== 'active') return fail('FORBIDDEN', '账号已停用', 403)
        const params = { ...context.params, id: artifactUuid(context.params.id),
          ...(context.params.artifactId !== undefined ? { artifactId: identity(context.params.artifactId) } : {}),
          ...(context.params.threadId !== undefined ? { threadId: artifactUuid(context.params.threadId) } : {}) }
        if (context.request.headers.has('idempotency-key') || context.request.headers.has('last-event-id')) throw new AgentCoreError('INVALID_INPUT')
        if (await ports.limited(`agent-core:${mutation ? 'write' : 'read'}:${actor.id}`, mutation ? 30 : 90, 60)) return fail('RATE_LIMITED', '请求过于频繁', 429)
        return await operation({ ...context, params }, actor)
      } catch (error) { return agentErrorResponse(error) }
    }
  return {
    list: wrap(async ({ request, params }, actor) => {
      const q = artifactPageQuery(request.nextUrl)
      return ok(await ports.artifacts.list(actor.id, params.id, q.limit, q.cursor))
    }),
    detail: wrap(async ({ request, params }, actor) => { noQuery(request); return ok(await ports.artifacts.detail(actor.id, params.id, params.artifactId)) }),
    threads: wrap(async ({ request, params }, actor) => {
      const q = artifactPageQuery(request.nextUrl)
      return ok(await ports.artifacts.threads(actor.id, params.id, params.artifactId, q.limit, q.cursor))
    }),
    thread: wrap(async ({ request, params }, actor) => { noQuery(request); return ok(await ports.artifacts.thread(actor.id, params.id, params.artifactId, params.threadId)) }),
    createThread: wrap(async ({ request, params }, actor) => {
      noQuery(request)
      return ok(await ports.artifacts.createThread(actor.id, params.id, params.artifactId, artifactThreadInput(await boundedBody(request))), { status: 202 })
    }, true),
    reply: wrap(async ({ request, params }, actor) => {
      noQuery(request)
      return ok(await ports.artifacts.reply(actor.id, params.id, params.artifactId, params.threadId, artifactReplyInput(await boundedBody(request))), { status: 202 })
    }, true),
    resolve: wrap(async ({ request, params }, actor) => {
      noQuery(request)
      return ok(await ports.artifacts.resolve(actor.id, params.id, params.artifactId, params.threadId, artifactResolveInput(await boundedBody(request))))
    }, true),
  }
}
export const agentArtifactHandlers = createAgentArtifactHandlers({ artifacts: new AgentArtifactsRepository(agentCoreTransaction), enabled: agentCoreEnabled, authorize: requireActor, limited })
