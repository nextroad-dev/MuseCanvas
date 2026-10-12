// Actor-scoped TanStack query keys for canvases and the Canvas Agent conversation.
//
// Every key embeds the signed-in actor id, so signing out and in as someone else can
// never reuse the previous actor's cached list, detail or history. Keeping the keys in
// a React-free module lets the scoping be asserted without mounting a hook.

export const CANVASES_QUERY_KEY = ['canvases'] as const
export const CANVAS_AGENT_STATUS_KEY = ['canvas-agent', 'status'] as const

export function canvasListQueryKey(actorId: string) {
  return [...CANVASES_QUERY_KEY, actorId, 'list'] as const
}

export function canvasDetailQueryKey(actorId: string, canvasId: string) {
  return [...CANVASES_QUERY_KEY, actorId, 'detail', canvasId] as const
}

export function canvasAgentHistoryQueryKey(actorId: string, canvasId: string) {
  return ['canvas-agent', actorId, 'history', canvasId] as const
}

/** Query-key prefixes that hold one actor's conversation state. The actor-switch
 *  cleanup removes exactly these, so the next actor's first render cannot reuse them. */
export function actorScopedCanvasQueryKeys(actorId: string) {
  return [['canvases', actorId], ['canvas-agent', actorId]] as const
}
