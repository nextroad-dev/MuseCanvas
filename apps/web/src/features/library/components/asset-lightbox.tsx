'use client'

import { useCallback, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { CropIcon as Crop, CaretLeftIcon as ChevronLeft, CaretRightIcon as ChevronRight, DownloadSimpleIcon as Download, XIcon as X } from '@phosphor-icons/react'
import { MediaFrame } from '@/shared/components/media-frame'
import { useDialog } from '@/shared/hooks/useDialog'
import type { DialogDirection } from '@/shared/hooks/useDialog'
import { useGenerationMode } from '@/shared/hooks/useGenerationMode'
import { useModelsQuery } from '@/shared/hooks/useModels'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import { maskCapabilityBlockReason, resolveActiveImageModel } from '@/shared/lib/model-capabilities'
import { formatDateTime } from '@/shared/lib/format'
import { api } from '@/shared/services/api'
import { assetPlaybackUrl, isVideoAsset } from '@/shared/types'
import type { Asset } from '@/shared/types'
import { Alert, Button, IconButton, buttonVariants } from '@/shared/components/ui'

export interface AssetLightboxProps {
  /** Navigation is limited to the currently filtered, loaded grid. */
  assets: Asset[]
  activeAssetId: string | null
  onClose: () => void
  onSelect: (assetId: string) => void
}

const SCRIM_BACKGROUND = 'color-mix(in srgb, var(--color-overlay) calc(var(--opacity-overlay) * 100%), transparent)'

/** A fixed header/action row surrounds one scroll body, including on short screens. */
export function AssetLightbox({ assets, activeAssetId, onClose, onSelect }: AssetLightboxProps) {
  const index = activeAssetId ? assets.findIndex((asset) => asset.id === activeAssetId) : -1
  const current = index >= 0 ? assets[index] : null
  const onNavigate = useCallback((direction: DialogDirection) => {
    const target = assets[index + (direction === 'previous' ? -1 : 1)]
    if (target) onSelect(target.id)
  }, [assets, index, onSelect])
  const { mounted, phase, labelId, closeButtonRef, portalTarget, rootProps, dialogProps } = useDialog({
    open: current !== null,
    onClose,
    onNavigate,
  })
  const { data: models } = useModelsQuery()
  const storedImageModelId = useGenerateUiStore((s) => s.selectedModelIdByKind.image)
  const setEditTarget = useGenerateUiStore((s) => s.setEditTarget)
  const { selectMode } = useGenerationMode()

  // Only retained for the exit animation; the current ID remains the open-state truth.
  const [lastKnown, setLastKnown] = useState<Asset | null>(null)
  if (current && current !== lastKnown) setLastKnown(current)
  const shown = current ?? lastKnown
  if (!mounted || !portalTarget || !shown) return null

  const closing = phase === 'close'
  const regionEditBlocked = isVideoAsset(shown)
    ? '仅图像作品支持局部修改'
    : maskCapabilityBlockReason(resolveActiveImageModel(models ?? [], storedImageModelId))

  function startRegionEdit(asset: Asset, url: string) {
    setEditTarget({ assetId: asset.id, url, width: asset.width, height: asset.height, selection: null })
    onClose()
    selectMode('image')
  }

  return createPortal(
    <div
      {...rootProps}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
      style={{ backgroundColor: SCRIM_BACKGROUND }}
      className={`fixed inset-0 z-modal flex items-center justify-center p-3 sm:p-6 ${closing ? 'motion-fade-out pointer-events-none' : 'motion-fade-in'}`}
    >
      <div {...dialogProps} className={`flex max-h-[calc(100dvh-1.5rem)] w-full max-w-content flex-col overflow-hidden rounded-panel bg-surface text-foreground shadow-modal sm:max-h-[calc(100dvh-3rem)] ${closing ? 'motion-dialog-out' : 'motion-dialog-in'}`}>
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <h2 id={labelId} className="text-module">{isVideoAsset(shown) ? '视频作品' : '图像作品'}</h2>
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground">第 {Math.max(index + 1, 1)} / {assets.length} 个已加载作品</p>
          </div>
          <div className="flex items-center gap-1">
            <IconButton variant="ghost" disabled={index <= 0} aria-label="上一个作品" onClick={() => onNavigate('previous')} icon={<ChevronLeft weight="bold" aria-hidden="true" />} />
            <IconButton variant="ghost" disabled={index >= assets.length - 1} aria-label="下一个作品" onClick={() => onNavigate('next')} icon={<ChevronRight weight="bold" aria-hidden="true" />} />
            <IconButton variant="ghost" ref={closeButtonRef} aria-label="关闭预览" onClick={onClose} icon={<X weight="bold" aria-hidden="true" />} />
          </div>
        </header>
        <AssetPreview key={shown.id} asset={shown} regionEditBlocked={regionEditBlocked} onEdit={startRegionEdit} />
      </div>
    </div>,
    portalTarget,
  )
}

function AssetPreview({ asset, regionEditBlocked, onEdit }: {
  asset: Asset
  regionEditBlocked: string | null
  onEdit: (asset: Asset, url: string) => void
}) {
  const [mediaPhase, setMediaPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [attempt, setAttempt] = useState(0)
  const automaticRetrySpent = useRef(false)
  const signingRef = useRef(false)
  const signing = useMutation({
    mutationFn: async () => {
      const response = await api.getAssetDownloadUrl(asset.id)
      if (!response.success || !response.data?.url) throw new Error(response.error?.message || '无法更新作品链接')
      return response.data
    },
  })
  const url = signing.data?.url ?? assetPlaybackUrl(asset)
  const isVideo = isVideoAsset(asset)

  async function retry() {
    if (signingRef.current) return
    signingRef.current = true
    try {
      await signing.mutateAsync()
      setMediaPhase('loading')
      setAttempt((value) => value + 1)
    } catch {
      setMediaPhase('failed')
    } finally {
      signingRef.current = false
    }
  }

  function onMediaError() {
    setMediaPhase('failed')
    // A failed original gets one automatic re-sign. Later retries require a click.
    if (!automaticRetrySpent.current) {
      automaticRetrySpent.current = true
      void retry()
    }
  }

  return (
    <>
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        <div
          className="relative flex min-h-32 items-center justify-center bg-tonal"
          onLoadCapture={() => setMediaPhase('ready')}
          onLoadedDataCapture={() => setMediaPhase('ready')}
          aria-busy={mediaPhase === 'loading'}
        >
          {mediaPhase === 'failed' ? (
            <p role="alert" className="p-6 text-center text-sm text-muted-foreground">原始媒体未能加载。可以重新加载以更新链接，或下载作品。</p>
          ) : <MediaFrame
            key={`${url}|${attempt}`}
            src={url}
            kind={isVideo ? 'video' : 'image'}
            alt={asset.prompt || (isVideo ? '视频作品' : '图像作品')}
            layout="stage"
            showControls={isVideo}
            durationSeconds={asset.durationSeconds}
            width={asset.width}
            height={asset.height}
            hasAudio={asset.hasAudio}
            onMediaError={onMediaError}
            className="mx-auto max-h-[55dvh] w-full object-contain"
          />}
          {mediaPhase === 'loading' ? <p role="status" className="pointer-events-none absolute inset-x-0 top-3 text-center text-sm text-muted-foreground">{signing.isPending ? '正在更新作品链接…' : '正在加载原始媒体…'}</p> : null}
        </div>
        <div className="flex flex-col gap-4 p-4 sm:p-6">
          {signing.isError ? <Alert tone="danger" title="作品链接更新失败">{signing.error.message}。请使用下方重新加载操作。</Alert> : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-xs tabular-nums text-muted-foreground">
            <span>{formatDateTime(asset.createdAt)}</span>
            {asset.width && asset.height ? <span>{asset.width} × {asset.height}</span> : null}
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">提示词</h3>
            <p className="whitespace-pre-wrap break-words text-sm text-foreground [overflow-wrap:anywhere]">{asset.prompt || '此作品没有提示词。'}</p>
          </div>
          {regionEditBlocked ? <p className="text-xs text-muted-foreground">局部修改：{regionEditBlocked}</p> : null}
        </div>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-surface px-4 py-3 sm:px-6">
        <Button variant="ghost" loading={signing.isPending} onClick={() => void retry()}>重新加载</Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" icon={<Crop weight="bold" aria-hidden="true" />} onClick={() => onEdit(asset, url)} disabled={Boolean(regionEditBlocked)} title={regionEditBlocked ?? '到创作台框选要修改的区域'}>局部修改</Button>
          <a href={signing.data?.downloadUrl ?? url} download target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'primary' })}>
            <Download weight="bold" aria-hidden="true" />下载
          </a>
        </div>
      </footer>
    </>
  )
}
