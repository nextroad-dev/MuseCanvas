import type { NextRequest } from 'next/server'
import { dispatchDelete, dispatchGet, dispatchPatch, dispatchPost, dispatchPut } from '../../../src/router'

/**
 * The whole API surface hangs off this one catch-all handler.
 *
 * It reads the matched path and hands it to the dispatcher, and nothing else.
 * Routing lives in `src/router`, and each feature's SQL, validation and DTO
 * projection live in `src/modules/<feature>`. Keeping this file free of queries
 * is the point: `apps/api/README.md` states the same rule.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ path: string[] }> }

const cleanPath = (context: Context) => context.params.then(value => value.path.join('/'))

export async function GET(request: NextRequest, context: Context) {
  return dispatchGet(request, await cleanPath(context))
}

export async function POST(request: NextRequest, context: Context) {
  return dispatchPost(request, await cleanPath(context))
}

export async function PATCH(request: NextRequest, context: Context) {
  return dispatchPatch(request, await cleanPath(context))
}

export async function PUT(request: NextRequest, context: Context) {
  return dispatchPut(request, await cleanPath(context))
}

export async function DELETE(request: NextRequest, context: Context) {
  return dispatchDelete(request, await cleanPath(context))
}
