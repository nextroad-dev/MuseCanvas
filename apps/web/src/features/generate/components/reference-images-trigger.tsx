'use client'

import { useEffect, useRef, useState } from 'react'
import { ImagesIcon as ImagePlus } from '@phosphor-icons/react'
import { Button } from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import type { ImageInputPlan, ImageInputPlanModel } from '@/shared/lib/generation-params'
import { ReferenceImagesDialog } from './reference-images-dialog'

const PREVIEW_LIMIT = 3

/** Frame slots mean the staged images *are* the video's first/last frames, so the
 *  trigger stops calling them references. */
function usesFrameSlots(plan: ImageInputPlan): boolean {
  return plan.slots.some((slot) => slot.role === 'first_frame' || slot.role === 'last_frame')
}

export function ReferenceImagesTrigger({
  model,
  plan,
  disabled = false,
}: {
  /** `ImageInputPlanModel`, not the legacy 2-key pick: `modelKind` has to survive
   *  the prop hop down to `addReferenceFiles`, which re-resolves the plan itself. */
  model: ImageInputPlanModel | null | undefined
  plan: ImageInputPlan
  disabled?: boolean
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const hasOpened = useRef(false)
  const [isOpen, setIsOpen] = useState(false)

  const stagedImages = useGenerateUiStore((s) => s.stagedImages)
  const maxInputs = plan.capacity
  const frameMode = usesFrameSlots(plan)
  const noun = frameMode ? '输入画面' : '参考图'
  const uploading = stagedImages.find((image) => image.status === 'uploading')
  const pending = stagedImages.some((image) => image.status === 'pending')
  const processing = stagedImages.some((image) => image.status === 'processing')
  const preparing = useGenerateUiStore((s) => s.isPreparingReferences)
  const failed = stagedImages.some((image) => image.status === 'error')
  const count = stagedImages.length

  useEffect(() => {
    // Only return focus when a panel we opened actually closed.
    if (!isOpen && hasOpened.current) buttonRef.current?.focus()
  }, [isOpen])

  useEffect(() => { if (disabled) setIsOpen(false) }, [disabled])

  function openPanel() {
    if (disabled || useGenerateUiStore.getState().isGenerating) return
    hasOpened.current = true
    setIsOpen(true)
  }

  const counter = `${count}/${maxInputs}`
  const status = failed ? '上传失败' : preparing || processing ? '校验中' : uploading ? `上传中 ${uploading.progress}%` : pending ? '排队中' : count > 0 ? '已就绪' : maxInputs === 0 ? '模型不支持' : '未添加'

  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="secondary"
        size="sm"
        onClick={openPanel}
        disabled={disabled}
        aria-label={
          `${noun}，已添加 ${count} 张，最多 ${maxInputs} 张，${status}`
        }
        className={cn(
          'border gap-1.5 px-2.5',
          failed ? 'border-danger text-danger' : count > 0 ? 'border-border-control bg-tonal-selected' : 'border-border-control',
        )}
        icon={
          <ImagePlus weight="bold"
            aria-hidden="true"
            className={maxInputs > 0 ? 'text-primary' : 'text-muted-foreground'}
          />
        }
      >
        <span>{noun}</span>
        {stagedImages.slice(0, PREVIEW_LIMIT).map((image) => (
          <img
            key={image.localId}
            src={image.previewUrl}
            alt=""
            aria-hidden="true"
            className="h-5 w-5 shrink-0 rounded-control border border-border object-cover"
          />
        ))}
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{counter}</span>
        <span className="text-xs">{status}</span>
      </Button>

      <ReferenceImagesDialog
        open={isOpen && !disabled}
        disabled={disabled}
        model={model}
        plan={plan}
        onClose={() => setIsOpen(false)}
      />
    </>
  )
}
