'use client'

import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { Crop, ChevronLeft, ChevronRight, Download, X } from 'lucide-react'
import { MediaFrame } from '@/shared/components/media-frame'
import { useDialog } from '@/shared/hooks/useDialog'
import type { DialogDirection } from '@/shared/hooks/useDialog'
import { useGenerationMode } from '@/shared/hooks/useGenerationMode'
import { useModelsQuery } from '@/shared/hooks/useModels'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import { maskCapabilityBlockReason, modelAcceptsMask, resolveActiveImageModel } from '@/shared/lib/model-capabilities'
import { assetPlaybackUrl, isVideoAsset } from '@/shared/types'
import type { Asset } from '@/shared/types'

export interface AssetLightboxProps {
  /** The currently filtered grid, in display order — this list *is* the
   *  navigation domain, so prev/next never lands on a hidden asset. */
  assets: Asset[]
  /** `previewAssetId` from the store. The component resolves it against `assets`
   *  on every render instead of ever holding the object itself, so a refetch or a
   *  delete can only close the dialog, never leave a stale row on screen. */
  activeAssetId: string | null
  onClose: () => void
  onSelect: (assetId: string) => void
}

/** Full-size preview over the library grid. All modal behaviour (mount
 *  lifecycle, portal, focus trap, scroll lock, Escape / arrow keys) comes from
 *  `useDialog`; this file only decides what the panel shows. */
export function AssetLightbox({ assets, activeAssetId, onClose, onSelect }: AssetLightboxProps) {
  const index = activeAssetId ? assets.findIndex((asset) => asset.id === activeAssetId) : -1
  const current = index >= 0 ? assets[index] : null

  const onNavigate = useCallback(
    (direction: DialogDirection) => {
      const target = assets[index + (direction === 'previous' ? -1 : 1)]
      if (target) onSelect(target.id)
    },
    [assets, index, onSelect],
  )

  const { mounted, phase, labelId, closeButtonRef, portalTarget, rootProps, dialogProps } = useDialog({
    open: current !== null,
    onClose,
    onNavigate,
  })

  // 局部修改 runs on the model the creation console would submit with, so the gate
  // here has to ask *that* model — a second, locally chosen one is how the lightbox
  // ends up offering an edit the console then refuses.
  const { data: models } = useModelsQuery()
  const storedImageModelId = useGenerateUiStore((s) => s.selectedModelIdByKind.image)
  const setEditTarget = useGenerateUiStore((s) => s.setEditTarget)
  const { selectMode } = useGenerationMode()

  // Body of the exit fade: the row can already be gone (delete, filter switch)
  // while the close animation runs, and a panel that empties mid-fade looks
  // broken. The id stays the single source of truth — `open` goes false the
  // moment `current` is, so this cached copy can only ever be on its way out.
  const [lastKnown, setLastKnown] = useState<Asset | null>(null)
  if (current && current !== lastKnown) setLastKnown(current)
  const shown = current ?? lastKnown

  if (!mounted || !portalTarget || !shown) return null

  const closing = phase === 'close'
  const isVideo = isVideoAsset(shown)
  const isFirst = index <= 0
  const isLast = index >= assets.length - 1
  const regionEditBlocked = isVideo
    ? '仅图像作品支持局部修改'
    : maskCapabilityBlockReason(resolveActiveImageModel(models ?? [], storedImageModelId))

  function startRegionEdit(asset: Asset) {
    setEditTarget({
      assetId: asset.id,
      url: assetPlaybackUrl(asset),
      width: asset.width,
      height: asset.height,
      selection: null,
    })
    // Close the dialog before routing: it traps focus and locks body scroll, and a
    // portal left over the console would keep swallowing both.
    onClose()
    selectMode('image')
  }

  return createPortal(
    <div
      {...rootProps}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className={`fixed inset-0 z-[var(--z-index-overlay)] flex items-center justify-center bg-overlay/80 p-4 ${
        closing ? 'motion-fade-out pointer-events-none' : 'motion-fade-in'
      }`}
    >
      <p className="sr-only" role="status" aria-live="polite">
        第 {Math.max(index + 1, 1)} / {assets.length} 个作品
      </p>

      <button
        type="button"
        ref={closeButtonRef}
        onClick={onClose}
        aria-label="关闭预览"
        className="absolute right-4 top-4 rounded-full bg-overlay/40 p-2 text-foreground-inverse transition-colors hover:bg-overlay/60"
      >
        <X className="h-6 w-6" />
      </button>

      <NavButton direction="previous" disabled={isFirst} onNavigate={onNavigate} />
      <NavButton direction="next" disabled={isLast} onNavigate={onNavigate} />

      <div
        {...dialogProps}
        className={`max-h-[90vh] max-w-4xl overflow-hidden rounded-[var(--radius-card)] bg-surface shadow-lg ${
          closing ? 'motion-dialog-out' : 'motion-dialog-in'
        }`}
      >
        <div key={shown.id} className="motion-pop">
          <MediaFrame
            src={assetPlaybackUrl(shown)}
            kind={isVideo ? 'video' : 'image'}
            alt={shown.prompt || ''}
            layout="stage"
            showControls={isVideo}
            durationSeconds={shown.durationSeconds}
            width={shown.width}
            height={shown.height}
            hasAudio={shown.hasAudio}
            className={isVideo ? 'max-h-[75vh] w-full object-contain' : 'max-h-[75vh] w-auto object-contain'}
          />
        </div>
        <div className="p-4">
          <p id={labelId} className="text-xs font-medium text-foreground">
            {shown.prompt}
          </p>
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{new Date(shown.createdAt).toLocaleString()}</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => startRegionEdit(shown)}
                disabled={Boolean(regionEditBlocked)}
                title={regionEditBlocked ?? '到创作台框选要修改的区域'}
                className="flex items-center gap-1 text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
              >
                <Crop className="h-3.5 w-3.5" aria-hidden="true" />
                局部修改
              </button>
              <a
                href={assetPlaybackUrl(shown)}
                download
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-accent hover:underline"
              >
                <Download className="h-3.5 w-3.5" />
                下载
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>,
    portalTarget,
  )
}

interface NavButtonProps {
  direction: DialogDirection
  disabled: boolean
  onNavigate: (direction: DialogDirection) => void
}

/** Edge arrows. The boundary ones stay out of the tab ring because `useDialog`
 *  skips `[disabled]` when it collects the focusable set. */
function NavButton({ direction, disabled, onNavigate }: NavButtonProps) {
  const previous = direction === 'previous'
  const Icon = previous ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={() => onNavigate(direction)}
      disabled={disabled}
      aria-label={previous ? '上一个作品' : '下一个作品'}
      className={`absolute top-1/2 -translate-y-1/2 rounded-full bg-overlay/40 p-2 text-foreground-inverse transition-colors hover:bg-overlay/60 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-overlay/40 ${
        previous ? 'left-4' : 'right-4'
      }`}
    >
      <Icon className="h-6 w-6" />
    </button>
  )
}
