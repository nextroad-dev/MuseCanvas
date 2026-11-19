import type { AgentArtifactAnchor } from '@musecanvas/contracts'

export type TextArtifactAnchor = Extract<AgentArtifactAnchor, { kind: 'text' }>

/** JavaScript string indexes and DOM Range offsets both count UTF-16 code units. */
export function textArtifactAnchor(content: string, start: number, end: number): TextArtifactAnchor | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > content.length) return null
  const splitsPair = (i: number) => i > 0 && i < content.length
    && /[\uD800-\uDBFF]/u.test(content[i - 1]!) && /[\uDC00-\uDFFF]/u.test(content[i]!)
  if (splitsPair(start) || splitsPair(end)) return null
  const quote = content.slice(start, end)
  if (new TextEncoder().encode(quote).length > 32000 || quote.includes('\0')) return null
  return { kind: 'text', start, end, quote }
}

export function selectedTextAnchor(root: HTMLElement, selection: Selection | null, content: string): TextArtifactAnchor | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const prefix = range.cloneRange()
  prefix.selectNodeContents(root)
  prefix.setEnd(range.startContainer, range.startOffset)
  const start = prefix.toString().length
  const anchor = textArtifactAnchor(content, start, start + range.toString().length)
  return anchor?.quote === range.toString() ? anchor : null
}

/** Bounds for centered object-fit: contain. Letterboxed pixels are never anchorable. */
export function containedImageBounds(box: { left: number; top: number; width: number; height: number }, width: number, height: number) {
  if (width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0) return null
  const scale = Math.min(box.width / width, box.height / height)
  const drawnWidth = width * scale, drawnHeight = height * scale
  return { left: box.left + (box.width - drawnWidth) / 2, top: box.top + (box.height - drawnHeight) / 2, width: drawnWidth, height: drawnHeight }
}

export function imagePointAnchor(box: { left: number; top: number; width: number; height: number }, width: number, height: number, clientX: number, clientY: number): Extract<AgentArtifactAnchor, { kind: 'image_point' }> | null {
  const bounds = containedImageBounds(box, width, height)
  if (!bounds) return null
  const x = (clientX - bounds.left) / bounds.width, y = (clientY - bounds.top) / bounds.height
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { kind: 'image_point', x, y } : null
}

export function videoTimeAnchor(seconds: number, durationMs: number | null): Extract<AgentArtifactAnchor, { kind: 'video' }> | null {
  if (!Number.isFinite(seconds) || seconds < 0 || durationMs === null) return null
  return { kind: 'video', timeMs: Math.min(durationMs, Math.round(seconds * 1000)) }
}

export function artifactAnchorLabel(anchor: AgentArtifactAnchor): string {
  switch (anchor.kind) {
    case 'whole': return '整个 Artifact'
    case 'text': return `文字 ${anchor.start}–${anchor.end}：${anchor.quote}`
    case 'image_point': return `图片位置 ${Math.round(anchor.x * 100)}%, ${Math.round(anchor.y * 100)}%`
    case 'image_rect': return `图片区域 ${Math.round(anchor.x * 100)}%, ${Math.round(anchor.y * 100)}% · ${Math.round(anchor.width * 100)}% × ${Math.round(anchor.height * 100)}%`
    case 'video': return `视频 ${(anchor.timeMs / 1000).toFixed(2)} 秒`
  }
}

export function artifactMessageError(body: string): string | null {
  if (!body.trim()) return '请输入评论内容。'
  if (body.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(body)) return '评论包含无效字符。'
  return new TextEncoder().encode(body).length > 8000 ? '评论不能超过 8000 字节，请缩短内容。' : null
}
