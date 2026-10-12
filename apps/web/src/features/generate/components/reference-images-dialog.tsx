'use client'

import {
  useEffect,
  useMemo,
  useRef,
  useState } from 'react'
import {
  CheckIcon as Check,
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
  ImagesIcon as ImagePlus,
  TrashIcon as Trash2,
  UploadSimpleIcon as Upload,
  } from '@phosphor-icons/react'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import {
  ALLOWED_IMAGE_MIME_TYPES,
  UPLOAD_LIMITS,
  addGalleryImage,
  addReferenceFiles,
  clearReferenceImages,
  formatSize,
  refreshGalleryPreview,
  removeReferenceImage,
  reorderReferenceImages,
  retryReferenceUpload,
  } from '@/shared/lib/reference-upload'
import { planRolePositions } from '@/shared/lib/generation-params'
import { Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  Progress,
  iconSize,
} from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import type { ImageInputPlan, ImageInputPlanModel } from '@/shared/lib/generation-params'
import type { Asset, StagedReferenceImage } from '@/shared/types'
import { GalleryImagePicker } from './gallery-image-picker'

function statusLabel(image: StagedReferenceImage, index: number, noun: string): string {
  switch (image.status) {
    case 'pending':
      return `${noun} ${index + 1} 排队中`
    case 'uploading':
      return `${noun} ${index + 1} 上传中 ${image.progress}%`
    case 'processing':
      return `${noun} ${index + 1} 服务端校验中`
    case 'error':
      return `${noun} ${index + 1} 上传失败`
    default:
      return `${noun} ${index + 1} 已就绪`
  }
}

export function ReferenceImagesDialog({
  open,
  model,
  plan,
  onClose,
  disabled = false,
}: {
  /** Desired visibility. Kept mounted so the shared `Dialog` can play its exit
   *  animation instead of the panel vanishing on unmount. */
  open: boolean
  /** `ImageInputPlanModel`, not the legacy 2-key pick: `addReferenceFiles`
   *  re-resolves the plan from this object, and a video model without its
   *  `modelKind` would wrongly fall back to the image capacity of 4. */
  model: ImageInputPlanModel | null | undefined
  /** Resolved once by the console so the trigger, this panel and the submit
   *  guard all read the same plan. */
  plan: ImageInputPlan
  onClose: () => void
  disabled?: boolean
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isReadingFiles, setIsReadingFiles] = useState(false)
  const [isGalleryPickerOpen, setIsGalleryPickerOpen] = useState(false)
  const fileReadCountRef = useRef(0)

  const stagedImages = useGenerateUiStore((s) => s.stagedImages)
  const inlineUploadError = useGenerateUiStore((s) => s.inlineUploadError)
  const setInlineUploadError = useGenerateUiStore((s) => s.setInlineUploadError)
  const beginReferencePreparation = useGenerateUiStore((s) => s.beginReferencePreparation)
  const finishReferencePreparation = useGenerateUiStore((s) => s.finishReferencePreparation)

  const maxInputs = plan.capacity
  const supportsImages = maxInputs > 0
  const canAdd = !disabled && supportsImages && stagedImages.length < maxInputs
  useEffect(() => { if (disabled) setIsGalleryPickerOpen(false) }, [disabled])

  function mutateInputs(action: () => unknown) {
    if (disabled || useGenerateUiStore.getState().isGenerating) return
    void action()
  }
  const totalBytes = stagedImages.reduce((sum, image) => sum + image.sizeBytes, 0)
  const excludedGalleryAssetIds = useMemo(
    () => stagedImages.flatMap((image) => (image.assetId ? [image.assetId] : [])),
    [stagedImages],
  )
  // Roles are positional: order alone decides 首帧 / 尾帧, which is why the tile
  // badges are derived from the plan instead of being picked per tile.
  const rolePositions = planRolePositions(plan)
  const frameMode = plan.slots.some(
    (slot) => slot.role === 'first_frame' || slot.role === 'last_frame',
  )
  const noun = frameMode ? '输入画面' : '参考图'

  // Counts only, never progress, so the live region stays quiet during a transfer.
  const announcement = useMemo(() => {
    if (stagedImages.length === 0) return `已清空所有${noun}`
    const failed = stagedImages.filter((image) => image.status === 'error').length
    const ready = stagedImages.filter((image) => image.status === 'ready').length
    if (failed > 0) return `${failed} 张${noun}上传失败`
    if (ready === stagedImages.length) return `${noun}全部就绪，共 ${ready} 张`
    return `正在上传${noun}，已就绪 ${ready} 张`
  }, [stagedImages, noun])

  /**
   * The gallery picker nests inside this dialog. While it is up, the outer layer
   * must not react to Escape or to a scrim click: `useDialog` on both levels puts
   * the background (this panel included) inert, so the inner dialog is the only
   * thing the user can act on — and it is the one that has to leave first.
   */
  function requestClose() {
    if (isGalleryPickerOpen) return
    onClose()
  }

  async function handleFiles(fileList: File[] | FileList) {
    if (disabled || useGenerateUiStore.getState().isGenerating) return
    fileReadCountRef.current += 1
    if (fileReadCountRef.current === 1) {
      setIsReadingFiles(true)
      beginReferencePreparation()
    }
    try {
      await addReferenceFiles(fileList, model)
    } finally {
      fileReadCountRef.current -= 1
      if (fileReadCountRef.current === 0) {
        setIsReadingFiles(false)
        finishReferencePreparation()
      }
    }
  }

  async function handleGallerySelect(asset: Asset) {
    if (disabled || useGenerateUiStore.getState().isGenerating) return
    // The helper reports capacity/size/geometry failures in the reference panel.
    // Close either way so that message remains visible instead of hiding behind the picker.
    await addGalleryImage(asset, model)
    setIsGalleryPickerOpen(false)
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

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      size="wide"
      title={noun}
      // The panel's first job is picking files, so focus goes to 上传本地图片
      // rather than the X.
      initialFocus="first-input"
      closeLabel={`关闭${noun}面板`}
      description={
        frameMode
          ? '顺序即角色：第一张作为首帧，最后一张作为尾帧，可用左右按钮调整。'
          : '模型会参照这些画面生成，可调整顺序影响参考强度。'
      }
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            {isReadingFiles ? '正在校验文件…' : `${stagedImages.length}/${maxInputs} 张 · ${formatSize(totalBytes)}`}
          </p>
          <Button variant="secondary" onClick={requestClose}>
            完成
          </Button>
        </div>
      }
    >
      <fieldset disabled={disabled} inert={disabled} className="m-0 min-w-0 border-0 p-0">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {stagedImages.length > 0 && !supportsImages && (
        <Alert
          tone="warning"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => mutateInputs(() => clearReferenceImages())}
              icon={<Trash2 weight="bold" aria-hidden="true" />}
            >
              删除全部
            </Button>
          }
        >
          无法使用{noun}：当前模型不接受图像输入。请切换到支持{frameMode ? '图生视频' : '图生图'}的模型，或删除已添加的{noun}。
        </Alert>
      )}

      {inlineUploadError && (
        <Alert
          tone="danger"
          role="alert"
          onDismiss={() => setInlineUploadError(null)}
          dismissLabel="关闭上传错误提示"
        >
          {inlineUploadError}
        </Alert>
      )}

      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          'flex flex-col gap-3 rounded-card p-3 transition-colors',
          canAdd
            // Dashed is reserved for upload / drag-drop semantics, which is exactly
            // what this surface is while slots remain.
            ? cn(
                'border-2 border-dashed',
                isDragging ? 'border-primary bg-tonal-hover' : 'border-border-control bg-tonal',
              )
            : 'bg-tonal',
        )}
      >
        {canAdd && (
          <div className="flex flex-col items-center gap-3 px-4 py-5 text-center">
            <Upload weight="duotone" aria-hidden="true" className={`${iconSize.xl} text-muted-foreground`} />
            <p className="text-sm font-medium text-foreground">拖拽图片到此处</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={!supportsImages}
                onClick={() => fileInputRef.current?.click()}
                icon={<ImagePlus weight="bold" aria-hidden="true" />}
              >
                上传本地图片
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setIsGalleryPickerOpen(true)}
                icon={<ImagePlus weight="bold" aria-hidden="true" className="text-primary" />}
              >
                从图库选择
              </Button>
            </div>
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
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {stagedImages.map((image, index) => {
              const role = rolePositions[index]
              const slot = role ? plan.slots.find((candidate) => candidate.role === role) : undefined
              const badge = role ? slot?.label ?? role : ''
              return (
                <li
                  key={image.localId}
                  className="flex flex-col gap-3 rounded-card border border-border bg-surface p-2"
                >
                  <div className="relative aspect-square overflow-hidden rounded-control bg-tonal">
                    <img
                      src={image.previewUrl}
                      alt={statusLabel(image, index, noun)}
                      onError={() => {
                        if (image.source === 'gallery') void refreshGalleryPreview(image.localId)
                      }}
                      className="h-full w-full object-cover"
                    />
                    <span
                      aria-hidden="true"
                      className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-pill bg-overlay font-mono text-xs tabular-nums text-foreground-inverse"
                    >
                      {index + 1}
                    </span>

                    {image.status === 'error' ? (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-control bg-danger-soft p-2 text-center text-danger">
                        <p className="text-xs font-medium">上传失败</p>
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          onClick={() => mutateInputs(() => retryReferenceUpload(image.localId))}
                          aria-label={`重试上传${noun} ${index + 1}`}
                        >
                          重试
                        </Button>
                      </div>
                    ) : image.status === 'ready' ? (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded-pill bg-success text-on-success"
                      >
                        <Check weight="fill" className={iconSize.xs} />
                      </span>
                    ) : (
                      // Real upload progress as a determinate bar; 校验中 / 排队中 have
                      // no value to claim, so they travel the indeterminate track
                      // instead of freezing at a fake percentage.
                      <div className="media-scrim absolute inset-0 flex flex-col items-start justify-end gap-1 p-2 text-foreground-inverse">
                        <span className="text-xs tabular-nums">
                          {image.status === 'uploading'
                            ? `上传中 ${image.progress}%`
                            : image.status === 'processing'
                              ? '校验中'
                              : '排队中'}
                        </span>
                        <Progress
                          value={image.status === 'uploading' ? image.progress : null}
                          label={`${noun} ${index + 1} 上传进度`}
                          showLabelRow={false}
                          // The bar sits on the tile's own scrim, so it needs the
                          // inverse track instead of a tonal stripe over dark media.
                          variant="overlay"
                        />
                      </div>
                    )}
                  </div>

                  {plan.multiRole && (
                    <div className="flex items-center justify-between gap-1">
                      {badge ? (
                        <Badge tone="neutral">{badge}</Badge>
                      ) : (
                        <Badge tone="danger">超出当前模型上限</Badge>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatSize(image.sizeBytes)}
                    </span>
                    <div className="flex items-center gap-1">
                      <IconButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => mutateInputs(() => reorderReferenceImages(index, index - 1))}
                        disabled={index === 0}
                        aria-label={`将${noun} ${index + 1} 前移`}
                        icon={<ChevronLeft weight="bold" aria-hidden="true" />}
                      />
                      <IconButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => mutateInputs(() => reorderReferenceImages(index, index + 1))}
                        disabled={index === stagedImages.length - 1}
                        aria-label={`将${noun} ${index + 1} 后移`}
                        icon={<ChevronRight weight="bold" aria-hidden="true" />}
                      />
                      <IconButton
                        type="button"
                        variant="danger-ghost"
                        size="sm"
                        onClick={() => mutateInputs(() => removeReferenceImage(image.localId))}
                        aria-label={`删除${noun} ${index + 1}`}
                        icon={<Trash2 weight="bold" aria-hidden="true" />}
                      />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {stagedImages.length === 0 && !canAdd && (
          <EmptyState
            variant="no-permission"
            objectName={noun}
            density="compact"
            title={`当前模型不支持${noun}`}
            description={`请直接输入提示词生成，或切换到支持${frameMode ? '图生视频' : '图生图'}的模型后再添加${noun}。`}
          />
        )}
        {!canAdd && stagedImages.length >= maxInputs && supportsImages && (
          <p className="px-1 text-xs text-muted-foreground">
            已达当前模型上限（{maxInputs} 张），如需替换请先删除一张。
          </p>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_IMAGE_MIME_TYPES.join(',')}
        multiple
        tabIndex={-1}
        aria-label={`选择本地${noun}文件`}
        className="sr-only"
        onChange={onInputChange}
      />

      </fieldset>
      <GalleryImagePicker
        open={isGalleryPickerOpen && !disabled}
        onClose={() => setIsGalleryPickerOpen(false)}
        onSelect={(asset) => void handleGallerySelect(asset)}
        excludedAssetIds={excludedGalleryAssetIds}
        noun={noun}
      />
    </Dialog>
  )
}
