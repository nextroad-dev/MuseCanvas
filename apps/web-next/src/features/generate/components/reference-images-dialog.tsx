'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  Loader2,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import {
  ALLOWED_IMAGE_MIME_TYPES,
  UPLOAD_LIMITS,
  addReferenceFiles,
  clearReferenceImages,
  formatSize,
  removeReferenceImage,
  reorderReferenceImages,
  resolveMaxInputs,
  retryReferenceUpload,
} from '@/shared/lib/reference-upload'
import type { ModelConfig, StagedReferenceImage } from '@/shared/types'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'

function statusLabel(image: StagedReferenceImage, index: number): string {
  switch (image.status) {
    case 'pending':
      return `参考图 ${index + 1} 排队中`
    case 'uploading':
      return `参考图 ${index + 1} 上传中 ${image.progress}%`
    case 'processing':
      return `参考图 ${index + 1} 服务端校验中`
    case 'error':
      return `参考图 ${index + 1} 上传失败`
    default:
      return `参考图 ${index + 1} 已就绪`
  }
}

function ProgressRing({ value }: { value: number }) {
  return (
    <svg viewBox="0 0 36 36" aria-hidden="true" className="h-9 w-9 -rotate-90">
      <circle
        cx="18"
        cy="18"
        r="15.9155"
        pathLength={100}
        fill="none"
        stroke="currentColor"
        strokeWidth={3.5}
        className="text-foreground-inverse/25"
      />
      <circle
        cx="18"
        cy="18"
        r="15.9155"
        pathLength={100}
        fill="none"
        stroke="currentColor"
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeDasharray="100 100"
        strokeDashoffset={100 - value}
        className="text-accent-soft transition-[stroke-dashoffset] duration-[var(--motion-base)]"
      />
    </svg>
  )
}

export function ReferenceImagesDialog({
  model,
  onClose,
}: {
  model: Pick<ModelConfig, 'inputSlots' | 'maxInputImages'> | null | undefined
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isReadingFiles, setIsReadingFiles] = useState(false)

  const stagedImages = useGenerateUiStore((s) => s.stagedImages)
  const inlineUploadError = useGenerateUiStore((s) => s.inlineUploadError)
  const setInlineUploadError = useGenerateUiStore((s) => s.setInlineUploadError)

  const maxInputs = resolveMaxInputs(model)
  const supportsImages = maxInputs > 0
  const canAdd = supportsImages && stagedImages.length < maxInputs
  const totalBytes = stagedImages.reduce((sum, image) => sum + image.sizeBytes, 0)

  // Counts only, never progress, so the live region stays quiet during a transfer.
  const announcement = useMemo(() => {
    if (stagedImages.length === 0) return '已清空所有参考图'
    const failed = stagedImages.filter((image) => image.status === 'error').length
    const ready = stagedImages.filter((image) => image.status === 'ready').length
    if (failed > 0) return `${failed} 张参考图上传失败`
    if (ready === stagedImages.length) return `参考图全部就绪，共 ${ready} 张`
    return `正在上传参考图，已就绪 ${ready} 张`
  }, [stagedImages])

  useEffect(() => {
    addButtonRef.current?.focus()
  }, [])

  async function handleFiles(fileList: File[] | FileList) {
    setIsReadingFiles(true)
    try {
      await addReferenceFiles(fileList, model)
    } finally {
      setIsReadingFiles(false)
    }
  }

  function onInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target
    if (input.files && input.files.length > 0) void handleFiles(input.files)
    // Without the reset, re-picking the same file fires no change event.
    input.value = ''
  }

  function onDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!canAdd || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setIsDragging(true)
  }

  function onDragLeave(event: React.DragEvent<HTMLDivElement>) {
    const next = event.relatedTarget as Node | null
    if (!next || !event.currentTarget.contains(next)) setIsDragging(false)
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!canAdd) return
    event.preventDefault()
    setIsDragging(false)
    if (event.dataTransfer.files.length > 0) void handleFiles(event.dataTransfer.files)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
    if (!focusables || focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[var(--z-index-overlay)] flex items-end justify-center p-4 sm:items-center"
    >
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 bg-overlay/40"
      />
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reference-images-title"
        className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col gap-4 rounded-[var(--radius-panel)] border border-border bg-surface p-5 shadow-lg"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="reference-images-title" className="text-[var(--text-subtitle)] leading-[1.4] text-foreground">
              参考图
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              模型会参照这些画面生成，可调整顺序影响参考强度。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭参考图面板"
            className="flex min-h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        {stagedImages.length > 0 && !supportsImages && (
          <div
            role="status"
            className="flex items-start justify-between gap-3 rounded-[var(--radius-popover)] border border-warning-soft bg-warning-soft px-3 py-2.5 text-sm"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-foreground">
                当前模型不支持参考图，请切换到支持图生图的模型，或移除已添加的参考图。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void clearReferenceImages()}
              aria-label="清空所有参考图"
              className="flex min-h-8 shrink-0 items-center gap-1 rounded-[var(--radius-control)] border border-border-control bg-surface px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle"
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              清空
            </button>
          </div>
        )}

        {inlineUploadError && (
          <div
            role="status"
            className="flex items-start justify-between gap-2 rounded-[var(--radius-popover)] border border-danger-border bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            <div className="flex items-start gap-2">
              <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{inlineUploadError}</span>
            </div>
            <button
              type="button"
              onClick={() => setInlineUploadError(null)}
              aria-label="关闭上传错误提示"
              className="flex min-h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] transition-colors hover:bg-danger-soft"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="-mx-1 flex-1 overflow-y-auto px-1 py-1">
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={
              canAdd
                ? `flex flex-col gap-3 rounded-[var(--radius-card)] border-2 border-dashed p-3 transition-colors duration-[var(--motion-fast)] ${
                    isDragging ? 'border-accent bg-accent-soft' : 'border-border-control bg-surface-subtle'
                  }`
                : 'flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-3'
            }
          >
            {canAdd && (
              <div className="flex flex-col items-center gap-2 px-4 py-5 text-center">
                <UploadCloud aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
                <p className="text-sm text-foreground">拖拽图片到此处</p>
                <button
                  ref={addButtonRef}
                  type="button"
                  disabled={!supportsImages}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex min-h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-primary px-3 text-sm font-medium text-canvas transition-colors duration-[var(--motion-fast)] hover:bg-primary-hover disabled:opacity-50"
                >
                  <ImagePlus aria-hidden="true" className="h-4 w-4" />
                  添加图片
                </button>
                <p className="text-xs text-muted-foreground">
                  PNG 或 JPEG，单张不超过 {formatSize(UPLOAD_LIMITS.maxImageBytes)}，总计不超过{' '}
                  {formatSize(UPLOAD_LIMITS.maxTotalBytes)}，最多 {maxInputs} 张
                </p>
                <p className="text-xs text-muted-foreground">
                  上传期间可关闭此面板或切换到其他页面，任务会在后台继续。
                </p>
              </div>
            )}

            {stagedImages.length > 0 && (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {stagedImages.map((image, index) => {
                  const isBusy = image.status === 'uploading' || image.status === 'processing'
                  return (
                    <li
                      key={image.localId}
                      className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-surface p-2"
                    >
                      <div className="relative aspect-square overflow-hidden rounded-[var(--radius-control)] bg-surface-subtle">
                        <img
                          src={image.previewUrl}
                          alt={statusLabel(image, index)}
                          className="h-full w-full object-cover"
                        />
                        <span
                          aria-hidden="true"
                          className="absolute left-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-overlay/85 font-mono text-xs tabular-nums text-foreground-inverse"
                        >
                          {index + 1}
                        </span>

                        {image.status === 'error' ? (
                          <div className="absolute inset-0 top-6 flex flex-col items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-danger-soft/95 p-2 text-center text-danger">
                            <AlertCircle aria-hidden="true" className="h-4 w-4" />
                            <span className="text-xs leading-[1.5]">上传失败</span>
                            <button
                              type="button"
                              onClick={() => void retryReferenceUpload(image.localId)}
                              aria-label={`重试上传参考图 ${index + 1}`}
                              className="flex min-h-8 items-center rounded-[var(--radius-control)] border border-danger px-2 text-xs font-medium transition-colors duration-[var(--motion-fast)] hover:bg-danger hover:text-foreground-inverse"
                            >
                              重试
                            </button>
                          </div>
                        ) : image.status === 'ready' ? (
                          <span
                            aria-hidden="true"
                            className="absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-accent-strong"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </span>
                        ) : (
                          <div
                            role={isBusy ? 'progressbar' : undefined}
                            aria-valuenow={image.status === 'uploading' ? image.progress : undefined}
                            aria-valuemin={image.status === 'uploading' ? 0 : undefined}
                            aria-valuemax={image.status === 'uploading' ? 100 : undefined}
                            aria-label={`参考图 ${index + 1} 上传进度`}
                            className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-overlay/80 text-foreground-inverse"
                          >
                            {image.status === 'uploading' ? (
                              <ProgressRing value={image.progress} />
                            ) : (
                              <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />
                            )}
                            <span className="text-xs tabular-nums">
                              {image.status === 'uploading'
                                ? `上传中 ${image.progress}%`
                                : image.status === 'processing'
                                  ? '校验中'
                                  : '排队中'}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-1">
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {formatSize(image.sizeBytes)}
                        </span>
                        <div className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => reorderReferenceImages(index, index - 1)}
                            disabled={index === 0}
                            aria-label={`将参考图 ${index + 1} 前移`}
                            className="flex min-h-8 w-8 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors duration-[var(--motion-fast)] hover:bg-surface-subtle hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                          >
                            <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => reorderReferenceImages(index, index + 1)}
                            disabled={index === stagedImages.length - 1}
                            aria-label={`将参考图 ${index + 1} 后移`}
                            className="flex min-h-8 w-8 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors duration-[var(--motion-fast)] hover:bg-surface-subtle hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                          >
                            <ChevronRight aria-hidden="true" className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeReferenceImage(image.localId)}
                            aria-label={`移除参考图 ${index + 1}`}
                            className="flex min-h-8 w-8 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors duration-[var(--motion-fast)] hover:bg-danger-soft hover:text-danger"
                          >
                            <X aria-hidden="true" className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            {stagedImages.length === 0 && !canAdd && (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                {supportsImages
                  ? '尚未添加参考图。'
                  : '当前模型不支持参考图，直接生成文字即可。'}
              </p>
            )}
            {!canAdd && stagedImages.length >= maxInputs && supportsImages && (
              <p className="px-1 text-xs text-muted-foreground">
                已达当前模型上限（{maxInputs} 张），如需替换请先移除一张。
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            {isReadingFiles ? '正在校验文件…' : `${stagedImages.length}/${maxInputs} 张 · ${formatSize(totalBytes)}`}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-8 items-center rounded-[var(--radius-control)] bg-surface-subtle px-3 text-sm font-medium text-foreground transition-colors duration-[var(--motion-fast)] hover:bg-surface-subtle-strong"
          >
            完成
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_IMAGE_MIME_TYPES.join(',')}
        multiple
        tabIndex={-1}
        aria-label="选择本地参考图文件"
        className="sr-only"
        onChange={onInputChange}
      />
    </div>
  )
}
