'use client'

import { useState } from 'react'
import { ImageBrokenIcon, PlayIcon, VideoCameraIcon } from '@phosphor-icons/react'
import { iconSize } from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import { formatDuration } from '@/shared/lib/format'
import type { AssetDto } from '@/shared/types'
import { previewSource } from '../lib/library-actions'

export interface AssetMediaProps {
  asset: AssetDto
  detail?: boolean
  className?: string
}

export function AssetMedia({ asset, detail = false, className }: AssetMediaProps) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const isVideo = asset.mediaKind === 'video'
  const source = detail ? asset.url || asset.imageUrl : previewSource(asset)

  if (failed || !source) {
    const Icon = isVideo ? VideoCameraIcon : ImageBrokenIcon
    return (
      <div
        className={cn(
          'flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 bg-tonal p-4 text-center text-ui text-muted-foreground',
          detail && 'rounded-card border border-border/70 py-12',
          className,
        )}
      >
        <Icon weight="duotone" aria-hidden="true" className={cn(iconSize.xl, 'text-muted-foreground')} />
        <span>{isVideo ? '暂无可播放的视频预览' : '图片暂时无法显示'}</span>
        {detail ? <span className="text-caption">可尝试下载原文件，或稍后重试。</span> : null}
      </div>
    )
  }

  if (isVideo && detail) {
    return (
      <video
        className={cn('max-h-[58vh] w-full rounded-card border border-border/70 bg-tonal object-contain', className)}
        src={source}
        poster={asset.posterUrl || asset.thumbnailUrl}
        controls
        playsInline
        preload="metadata"
        aria-label={asset.prompt || '视频作品'}
        onError={() => setFailed(true)}
      />
    )
  }

  if (detail) {
    return (
      <div className={cn('flex w-full items-center justify-center overflow-hidden rounded-card border border-border/70 bg-tonal', className)}>
        {/* Signed media URLs and local showcase assets are both served by the existing API boundary. */}
        <img
          src={source}
          alt={asset.prompt || '生成作品'}
          loading="eager"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            'max-h-[58vh] w-full object-contain',
            loaded && 'motion-fade-in-slow',
          )}
        />
      </div>
    )
  }

  // Signed media URLs and local showcase assets are both served by the existing API boundary.
  return (
    <div className={cn('relative h-full w-full overflow-hidden bg-tonal', className)}>
      <img
        src={source}
        alt={asset.prompt || '生成作品'}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={cn(
          'h-full w-full object-cover transition-transform duration-[var(--motion-spring-gentle)] ease-spring-gentle motion-reduce:transition-none group-hover:scale-[1.025]',
          loaded && 'motion-fade-in-slow',
        )}
      />
      {isVideo ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-pill bg-overlay/75 px-2 py-0.5 font-mono text-caption tabular-nums text-on-media backdrop-blur-xs"
        >
          <PlayIcon weight="fill" className={iconSize.xs} />
          <span>{asset.durationSeconds !== undefined ? formatDuration(asset.durationSeconds) : '视频'}</span>
        </span>
      ) : null}
    </div>
  )
}
