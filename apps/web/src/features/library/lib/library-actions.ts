import type { AssetDto } from '@/shared/types'

/** Only the user's original prompt is reused, never a privileged final prompt. */
export function reusablePrompt(asset: Pick<AssetDto, 'inputPrompt' | 'prompt'>): string {
  return asset.inputPrompt?.trim() || asset.prompt
}

export function generationSearch(asset: Pick<AssetDto, 'inputPrompt' | 'prompt' | 'mediaKind'>): string {
  return new URLSearchParams({ prompt: reusablePrompt(asset), kind: asset.mediaKind }).toString()
}

export function visibleSelection(selectedIds: string[], assets: Pick<AssetDto, 'id'>[]): string[] {
  const visible = new Set(assets.map((asset) => asset.id))
  return [...new Set(selectedIds)].filter((id) => visible.has(id))
}

export function downloadableUrl(value: string, origin: string): string {
  const url = new URL(value, origin)
  if (!['https:', 'http:', 'blob:'].includes(url.protocol)) throw new Error('下载地址无效，请刷新后重试。')
  return url.href
}

export function previewSource(asset: AssetDto): string {
  return asset.mediaKind === 'video'
    ? asset.thumbnailUrl || asset.posterUrl || ''
    : asset.thumbnailUrl || asset.imageUrl || asset.url
}
