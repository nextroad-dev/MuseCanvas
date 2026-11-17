'use client'

import { useState } from 'react'
import { ImageBrokenIcon, VideoCameraIcon } from '@phosphor-icons/react'
import type { AssetDto } from '@/shared/types'
import { previewSource } from '../lib/library-actions'

export function AssetMedia({ asset, detail = false }: { asset: AssetDto; detail?: boolean }) {
  const [failed, setFailed] = useState(false)
  const isVideo = asset.mediaKind === 'video'
  const source = detail ? asset.url || asset.imageUrl : previewSource(asset)
  if (failed || !source) {
    const Icon = isVideo ? VideoCameraIcon : ImageBrokenIcon
    return (
      <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 bg-tonal p-4 text-center text-sm text-muted-foreground">
        <Icon aria-hidden="true" className="size-8 text-muted-foreground" />
        <span>{isVideo ? '暂无可播放的视频预览' : '图片暂时无法显示'}</span>
        {detail && <span className="text-xs">可尝试下载原文件，或稍后重试。</span>}
      </div>
    )
  }
  if (isVideo && detail) {
    return (
      <video
        className="max-h-[55vh] w-full rounded-card bg-tonal"
        src={source}
        poster={asset.posterUrl}
        controls
        playsInline
        preload="metadata"
        aria-label={asset.prompt || '视频作品'}
        onError={() => setFailed(true)}
      />
    )
  }
  // Signed media URLs and local showcase assets are both served by the existing API boundary.
  return (
    <img
      src={source}
      alt={asset.prompt || '生成作品'}
      loading={detail ? 'eager' : 'lazy'}
      className={
        detail
          ? 'max-h-[55vh] w-full rounded-card bg-tonal object-contain'
          : 'h-full w-full object-cover transition-transform duration-(--motion-base) motion-reduce:transition-none group-hover:scale-[1.025]'
      }
      onError={() => setFailed(true)}
    />
  )
}
