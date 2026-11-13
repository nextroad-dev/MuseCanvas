export interface ReuseDraft {
  prompt: string
  requestedKind: string
  lastReuseQuery: string
}

/** Consume navigation intent once; ordinary navigation must never clear a draft. */
export function consumeReuseQuery<T extends ReuseDraft>(state: T, query: string): T {
  const params = new URLSearchParams(query)
  const prompt = params.get('prompt')
  const kind = params.get('kind')
  const identity = prompt === null && kind === null ? '' : JSON.stringify([prompt, kind])
  if (identity === state.lastReuseQuery) return state
  if (!identity) return { ...state, lastReuseQuery: '' }
  return {
    ...state,
    prompt: prompt ?? state.prompt,
    requestedKind: kind ?? 'image',
    lastReuseQuery: identity,
  }
}

export function reuseKindBlockReason(kind: string): string | null {
  if (kind === 'image') return null
  if (kind === 'video') return '你复用了视频提示词，但当前工作台暂不支持视频生成。提示词已保留；只有主动选择“改为图片创作”后才能提交图片任务。'
  return '无法识别复用素材的类型。提示词已保留；请先明确选择图片创作。'
}
