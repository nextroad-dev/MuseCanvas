'use client'

import { useCallback, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useMutation } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { CaretLeftIcon as ChevronLeft, CaretRightIcon as ChevronRight, DownloadSimpleIcon as Download, XIcon as X } from '@phosphor-icons/react'
import { MediaFrame } from '@/shared/components/media-frame'
import { useDialog } from '@/shared/hooks/useDialog'
import type { DialogDirection } from '@/shared/hooks/useDialog'
import { useGenerationMode } from '@/shared/hooks/useGenerationMode'
import { useModelsQuery } from '@/shared/hooks/useModels'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import { maskCapabilityBlockReason, resolveActiveImageModel } from '@/shared/lib/model-capabilities'
import { formatDateTime } from '@/shared/lib/format'
import { api } from '@/shared/services/api'
import { assetPlaybackUrl, assetPreviewUrl, isVideoAsset } from '@/shared/types'
import type { Asset } from '@/shared/types'
import { Alert, Button, IconButton, buttonVariants } from '@/shared/components/ui'
import { iconSize } from '@/shared/components/ui/size'
import { assetTitle } from './workspace-page-state'

export interface AssetLightboxProps {
  /** Navigation is limited to the currently filtered, loaded grid. */
  assets: Asset[]
  activeAssetId: string | null
  onClose: () => void
  onSelect: (assetId: string) => void
}

const SCRIM_BACKGROUND = 'color-mix(in srgb, var(--color-overlay) calc(var(--opacity-overlay) * 100%), transparent)'

/** The 44px round pager on the dark stage: a circular touch target by geometry. */
const STAGE_PAGER_CLASS =
  'motion-press absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-pill bg-overlay/40 text-foreground-inverse backdrop-blur-md border border-white/10 disabled:cursor-not-allowed disabled:opacity-50'

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
  const setPrompt = useGenerateUiStore((s) => s.setPrompt)
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

  function reuseParameters(asset: Asset) {
    setEditTarget(null)
    if (asset.prompt) setPrompt(asset.prompt)
    onClose()
    selectMode(isVideoAsset(asset) ? 'video' : 'image')
  }

  return createPortal(
    <div
      {...rootProps}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
      style={{ backgroundColor: SCRIM_BACKGROUND }}
      className={`fixed inset-0 z-modal flex items-center justify-center p-4 backdrop-blur-sm sm:p-6 lg:p-8 ${closing ? 'motion-fade-out pointer-events-none' : 'motion-fade-in'}`}
    >
      <div {...dialogProps} className={`flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[1280px] flex-col overflow-hidden rounded-panel border border-white/10 bg-overlay text-foreground shadow-modal sm:max-h-[calc(100dvh-3rem)] lg:h-[min(740px,calc(100dvh-4rem))] lg:flex-row ${closing ? 'motion-dialog-out' : 'motion-dialog-in'}`}>
        <AssetPreview
          key={shown.id}
          asset={shown}
          index={index}
          total={assets.length}
          labelId={labelId}
          closeButtonRef={closeButtonRef}
          regionEditBlocked={regionEditBlocked}
          onClose={onClose}
          onNavigate={onNavigate}
          onEdit={startRegionEdit}
          onReuse={reuseParameters}
        />
      </div>
    </div>,
    portalTarget,
  )
}

function AssetPreview({ asset, index, total, labelId, closeButtonRef, regionEditBlocked, onClose, onNavigate, onEdit, onReuse }: {
  asset: Asset
  index: number
  total: number
  labelId: string
  closeButtonRef: RefObject<HTMLButtonElement | null>
  regionEditBlocked: string | null
  onClose: () => void
  onNavigate: (direction: DialogDirection) => void
  onEdit: (asset: Asset, url: string) => void
  onReuse: (asset: Asset) => void
}) {
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
  const preview = assetPreviewUrl(asset)
  const isVideo = isVideoAsset(asset)
  const title = assetTitle(asset.prompt) ?? (isVideo ? '视频作品' : '图像作品')
  // Only a still image with no recorded size gets the mock's fixed 3:4 cover box. Anything
  // with real dimensions (and every video) keeps its own ratio, so a user's image is never cropped.
  const coverBox = !isVideo && !(asset.width && asset.height)
  const frameClass = coverBox
    ? 'aspect-[3/4] w-full max-h-[60dvh] lg:h-full lg:max-h-full lg:w-auto [&>div]:h-full'
    : 'w-full lg:h-full lg:max-h-full lg:[&>div]:h-full'
  const mediaClass = coverBox
    ? 'h-full w-full object-cover'
    : 'h-auto w-auto max-h-[60dvh] max-w-full object-contain lg:max-h-full'

  async function retry() {
    if (signingRef.current) return
    signingRef.current = true
    try {
      await signing.mutateAsync()
      setAttempt((value) => value + 1)
    } finally {
      signingRef.current = false
    }
  }

  function onMediaError() {
    // A failed original gets one automatic re-sign. Later retries require a click.
    if (!automaticRetrySpent.current) {
      automaticRetrySpent.current = true
      void retry()
    }
  }

  return (
    <>
      <div className="relative flex min-h-[360px] min-w-0 flex-1 items-center justify-center overflow-hidden bg-overlay p-4 sm:p-6 md:p-8 lg:flex-[999_1_560px]">
        <div className={`flex min-h-0 min-w-0 items-center justify-center ${frameClass}`}>
          <MediaFrame
            key={`${url}|${attempt}`}
            src={url}
            previewSrc={preview}
            kind={isVideo ? 'video' : 'image'}
            alt={asset.prompt || (isVideo ? '视频作品' : '图像作品')}
            layout="stage"
            showControls={isVideo}
            width={asset.width}
            height={asset.height}
            onMediaError={onMediaError}
            className={mediaClass}
          />
        </div>
        <button
          type="button"
          aria-label="上一个作品"
          disabled={index <= 0}
          onClick={() => onNavigate('previous')}
          className={`${STAGE_PAGER_CLASS} left-4`}
        >
          <ChevronLeft weight="bold" aria-hidden="true" className={iconSize.md} />
        </button>
        <button
          type="button"
          aria-label="下一个作品"
          disabled={index >= total - 1}
          onClick={() => onNavigate('next')}
          className={`${STAGE_PAGER_CLASS} right-4`}
        >
          <ChevronRight weight="bold" aria-hidden="true" className={iconSize.md} />
        </button>
      </div>
      <aside className="flex min-h-0 w-full min-w-0 shrink flex-col bg-surface lg:w-auto lg:min-w-[320px] lg:max-w-[380px] lg:flex-[1_1_320px]">
        <header className="flex shrink-0 items-start justify-between gap-3 px-5 pb-5 pt-5">
          <div className="min-w-0">
            <h2 id={labelId} className="break-words text-module">{title}</h2>
            <p role="status" aria-live="polite" className="text-sm tabular-nums text-muted-foreground">第 {Math.max(index + 1, 1)} 张，共 {total} 张</p>
          </div>
          <IconButton variant="ghost" size="sm" ref={closeButtonRef} aria-label="关闭" onClick={onClose} icon={<X weight="bold" aria-hidden="true" />} />
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pb-5">
          {signing.isError ? (
            <Alert
              tone="danger"
              title="作品链接更新失败"
              action={<Button variant="secondary" size="sm" loading={signing.isPending} onClick={() => void retry()}>重新加载</Button>}
            >
              {signing.error.message}。请使用重新加载操作。
            </Alert>
          ) : null}
          <section className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium text-foreground">提示词</h3>
            <p className="whitespace-pre-wrap break-words text-sm leading-[1.6] text-foreground [overflow-wrap:anywhere]">{asset.prompt || '此作品没有提示词。'}</p>
          </section>
          <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">类型</dt>
            <dd className="m-0 text-foreground">{isVideo ? '视频' : '图像'}</dd>
            <dt className="text-muted-foreground">尺寸</dt>
            <dd className="m-0 font-mono tabular-nums text-foreground">
              {asset.width && asset.height ? `${asset.width} × ${asset.height}` : '—'}
            </dd>
            <dt className="text-muted-foreground">创建于</dt>
            <dd className="m-0 font-mono tabular-nums text-foreground">{formatDateTime(asset.createdAt)}</dd>
          </dl>
          {regionEditBlocked ? <p className="text-xs text-muted-foreground">局部修改：{regionEditBlocked}</p> : null}
        </div>
        <footer className="flex shrink-0 flex-col gap-2 border-t border-border px-5 py-5">
          <a href={signing.data?.downloadUrl ?? url} download target="_blank" rel="noreferrer" className={`${buttonVariants({ variant: 'primary', fullWidth: true })} text-sm font-medium`}>
            <Download weight="bold" aria-hidden="true" />下载原图
          </a>
          <div className="grid grid-cols-2 gap-2.5">
            <Button variant="secondary" className="text-sm font-medium" onClick={() => onEdit(asset, url)} disabled={Boolean(regionEditBlocked)} title={regionEditBlocked ?? '到创作台框选要修改的区域'}>局部修改</Button>
            <Button variant="secondary" className="text-sm font-medium" onClick={() => onReuse(asset)}>复用参数</Button>
          </div>
        </footer>
      </aside>
    </>
  )
}
