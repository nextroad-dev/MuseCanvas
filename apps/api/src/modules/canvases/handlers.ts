import type pg from 'pg'
import {
  CanvasErrorCode,
  isCanvasUuid,
  parseCreateCanvasRequest,
  parseUpdateCanvasRequest,
} from '@musecanvas/contracts'
import {
  CanvasReferenceError,
  createCanvasDocument,
  db,
  deleteCanvasDocument,
  findCanvasForActor,
  listCanvasDocuments,
  updateCanvasDocument,
} from '@musecanvas/database'
import type { AuthedContext } from '../../router/types'
import { fail, ok } from '../../shared/http'
import { limited } from '../../shared/redis'

/** Parent route registration must use access: 'actor'; CSRF stays in the dispatcher. */
export type RouteContext = AuthedContext
export interface CanvasPorts {
  db: () => pg.Pool
  limited: typeof limited
}
export const defaultCanvasPorts: CanvasPorts = { db, limited }

const notFound = () => fail(CanvasErrorCode.CANVAS_NOT_FOUND, '画布不存在', 404)
const invalidId = () => fail(CanvasErrorCode.INVALID_INPUT, '画布 ID 无效', 400)
const rateLimited = () => fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)

// The shared body() converts malformed JSON to {}, which would create an empty
// canvas. Read unknown JSON here so malformed, null and array bodies all fail.
async function readJson(context: RouteContext): Promise<unknown> {
  try { return await context.request.json() } catch { return undefined }
}
async function mutationLimited(actorId: string, ports: CanvasPorts): Promise<boolean> {
  return ports.limited(`canvas:mutate:${actorId}`, 60, 60)
}

export async function listCanvases(context: RouteContext, ports: CanvasPorts = defaultCanvasPorts) {
  const query = context.request.nextUrl.searchParams
  const rawLimit = query.get('limit')
  if (query.getAll('limit').length > 1 || query.getAll('cursor').length > 1
    || (rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit))) {
    return fail(CanvasErrorCode.INVALID_INPUT, '分页参数无效', 400)
  }
  const limit = rawLimit === null ? 20 : Number(rawLimit)
  if (limit > 100) return fail(CanvasErrorCode.INVALID_INPUT, '分页参数无效', 400)
  const cursor = query.get('cursor')
  try {
    return ok(await listCanvasDocuments(ports.db(), context.actor.id,
      { limit, ...(cursor === null ? {} : { cursor }) }))
  } catch (error) {
    if (error instanceof Error && error.message === CanvasErrorCode.INVALID_INPUT) {
      return fail(CanvasErrorCode.INVALID_INPUT, '分页游标无效', 400)
    }
    throw error
  }
}

export async function createCanvas(context: RouteContext, ports: CanvasPorts = defaultCanvasPorts) {
  if (await mutationLimited(context.actor.id, ports)
    || await ports.limited(`canvas:create:${context.actor.id}`, 20, 60)) return rateLimited()
  const parsed = parseCreateCanvasRequest(await readJson(context))
  if (!parsed.success) return fail(parsed.error.code, parsed.error.message, 400)
  try {
    // Pool entrypoints own the short transaction: refs and insert commit together.
    return ok(await createCanvasDocument(ports.db(), context.actor.id, parsed.data), { status: 201 })
  } catch (error) {
    if (error instanceof CanvasReferenceError) return fail(error.code, '画布引用无效', 400)
    throw error
  }
}

export async function getCanvas(context: RouteContext, ports: CanvasPorts = defaultCanvasPorts) {
  const id = context.params.id
  if (!isCanvasUuid(id)) return invalidId()
  const document = await findCanvasForActor(ports.db(), context.actor.id, id.toLowerCase())
  return document ? ok(document) : notFound()
}

export async function updateCanvas(context: RouteContext, ports: CanvasPorts = defaultCanvasPorts) {
  const id = context.params.id
  if (!isCanvasUuid(id)) return invalidId()
  if (await mutationLimited(context.actor.id, ports)) return rateLimited()
  const parsed = parseUpdateCanvasRequest(await readJson(context))
  if (!parsed.success) return fail(parsed.error.code, parsed.error.message, 400)
  // The repository locks the owner row, checks revision before references and
  // atomically increments it. Stored refs (not client claims) allow placeholders.
  const result = await updateCanvasDocument(ports.db(), context.actor.id, id.toLowerCase(), parsed.data)
  switch (result.status) {
    case 'updated': return ok(result.document)
    case 'not_found': return notFound()
    case 'conflict': return fail(CanvasErrorCode.CANVAS_REVISION_CONFLICT, '画布已被更新，请刷新后重试', 409)
    case 'invalid_reference': return fail(CanvasErrorCode.INVALID_INPUT, '画布引用无效', 400)
  }
}

export async function deleteCanvas(context: RouteContext, ports: CanvasPorts = defaultCanvasPorts) {
  const id = context.params.id
  if (!isCanvasUuid(id)) return invalidId()
  if (await mutationLimited(context.actor.id, ports)) return rateLimited()
  const normalizedId = id.toLowerCase()
  return await deleteCanvasDocument(ports.db(), context.actor.id, normalizedId)
    ? ok({ id: normalizedId }) : notFound()
}
