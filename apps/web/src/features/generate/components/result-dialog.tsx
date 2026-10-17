'use client'

import { useEffect, useState } from 'react'
import { CropIcon, DownloadSimpleIcon } from '@phosphor-icons/react'
import { editSelectionIsUsable } from '@musecanvas/contracts'
import type { EditSelection } from '@musecanvas/contracts'
import { Button, Dialog, SegmentedControl, buttonVariants } from '@/shared/components/ui'
import { MediaFrame } from '@/shared/components/media-frame'
import { cn } from '@/shared/lib/cn'
import { EditRegionStage } from './edit-region-stage'

export interface ResultEditSourceDraft {
  assetId: string
  selection: EditSelection
  sourceWidth?: number
  sourceHeight?: number
}

/** One media variant of a result (`count > 1` produces several). */
export interface ResultVariant {
  id: string
  /** `assets.id`; `null` disables region selection (e.g. a legacy output row). */
  assetId: string | null
  url: string
  downloadUrl?: string
  video: boolean
  width?: number
  height?: number
}

/**
 * One media surface the dialog can show. A generation result (all its outputs) and
 * a library asset both reduce to this, so region editing and download live in
 * exactly one dialog instead of a per-source copy — and no entry can submit
 * anything on its own.
 */
export interface ResultSubject {
  /** Identity: a new subject resets the selection and the view mode. */
  id: string
  alt: string
  aspectRatio?: string
  variants: ResultVariant[]
  /** Job facts; absent for a plain library asset. */
  prompt?: string
  modelName?: string
  size?: string
  createdAt?: string
}

export interface ResultDialogProps {
  open: boolean
  onClose: () => void
  subject: ResultSubject | null
  /** Writes a local edit draft into the composer context. Never posts an edit or
   *  creates a job directly — the Agent proposal/confirmation path stays the only
   *  execution route. */
  onUseEditSource: (draft: ResultEditSourceDraft) => void
}

/** Result dialog: original media plus metadata, an output switcher, and (for
 *  images) a region selection surface that hands the selection back as composer
 *  context. */
export function ResultDialog({ open, onClose, subject, onUseEditSource }: ResultDialogProps) {
  const [mode, setMode] = useState<'preview' | 'select'>('preview')
  const [selection, setSelection] = useState<EditSelection | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  // A new subject resets the selection and the view mode, so a rectangle from the
  // previous image can never be handed to the Agent for this one.
  useEffect(() => {
    setMode('preview')
    setSelection(null)
    setActiveIndex(0)
  }, [subject?.id])

  // A different output is a different picture: the rectangle must not carry over.
  useEffect(() => {
    setSelection(null)
  }, [activeIndex])

  if (!subject) return null
  const variant = subject.variants[Math.min(activeIndex, subject.variants.length - 1)]
  if (!variant) return null

  const { assetId, url, video, width, height } = variant
  const canSelect = !video && Boolean(assetId)
  const selectionUsable = editSelectionIsUsable(selection)

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="wide"
      title="结果详情"
      description="查看原图/原视频与元信息；需要局部修改时框选区域，选区只写入草稿，不会直接提交。"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              if (!assetId || !selectionUsable || selection === null) return
              onUseEditSource({
                assetId,
                selection,
                ...(typeof width === 'number' ? { sourceWidth: width } : {}),
                ...(typeof height === 'number' ? { sourceHeight: height } : {}),
              })
            }}
            disabled={!canSelect || !selectionUsable}
            icon={<CropIcon weight="bold" aria-hidden="true" />}
          >
            用此选区起草修改
          </Button>
          {variant.downloadUrl || url ? (
            <a href={variant.downloadUrl || url} download target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'secondary' })}>
              <DownloadSimpleIcon weight="bold" aria-hidden="true" />{video ? '下载视频' : '下载原图'}
            </a>
          ) : null}
          <Button variant="primary" onClick={onClose}>关闭</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {canSelect ? (
          <SegmentedControl
            label="查看方式"
            size="sm"
            value={mode}
            onChange={(value) => setMode(value)}
            items={[
              { value: 'preview', label: '原图' },
              { value: 'select', label: '框选区域' },
            ]}
          />
        ) : null}

        {subject.variants.length > 1 ? (
          <div aria-label="切换产物" className="flex items-center gap-2 overflow-x-auto pb-1">
            <span className="shrink-0 text-xs text-muted-foreground">第 {activeIndex + 1} / 共 {subject.variants.length} 个</span>
            {subject.variants.map((item, itemIndex) => (
              <button
                key={item.id}
                type="button"
                aria-label={`查看第 ${itemIndex + 1} 个产物`}
                aria-pressed={itemIndex === activeIndex}
                onClick={() => setActiveIndex(itemIndex)}
                className={cn('h-10 w-10 shrink-0 overflow-hidden rounded-control border-2', itemIndex === activeIndex ? 'border-primary' : 'border-transparent')}
              >
                <MediaFrame src={item.url} kind={item.video ? 'video' : 'image'} alt="" layout="thumb" />
              </button>
            ))}
          </div>
        ) : null}

        {mode === 'select' && canSelect ? (
          <EditRegionStage
            src={url}
            alt={subject.alt}
            declaredWidth={width}
            declaredHeight={height}
            selection={selection}
            onSelectionChange={setSelection}
          />
        ) : (
          // Keyed on the output identity: switching variants remounts the stage
          // so the new media fades in instead of swapping mid-frame.
          <div key={variant.id} className="motion-fade-in overflow-hidden rounded-card bg-tonal">
            <MediaFrame
              src={url}
              kind={video ? 'video' : 'image'}
              alt={subject.alt}
              layout="stage"
              showControls={video}
              width={width}
              height={height}
              aspectRatio={subject.aspectRatio}
            />
          </div>
        )}

        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
          {subject.prompt ? <div className="flex gap-2 sm:col-span-2"><dt className="shrink-0 text-muted-foreground">提示词</dt><dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">{subject.prompt}</dd></div> : null}
          {subject.modelName ? <div className="flex gap-2"><dt className="shrink-0 text-muted-foreground">模型</dt><dd className="text-foreground">{subject.modelName}</dd></div> : null}
          {typeof width === 'number' && typeof height === 'number'
            ? <div className="flex gap-2"><dt className="shrink-0 text-muted-foreground">尺寸</dt><dd className="font-mono tabular-nums text-foreground">{width}×{height}</dd></div>
            : subject.size ? <div className="flex gap-2"><dt className="shrink-0 text-muted-foreground">尺寸</dt><dd className="font-mono tabular-nums text-foreground">{subject.size}</dd></div> : null}
          {subject.createdAt ? <div className="flex gap-2"><dt className="shrink-0 text-muted-foreground">创建时间</dt><dd className="text-foreground">{new Date(subject.createdAt).toLocaleString()}</dd></div> : null}
        </dl>
      </div>
    </Dialog>
  )
}
