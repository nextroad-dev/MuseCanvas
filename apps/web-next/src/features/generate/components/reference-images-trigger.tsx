'use client'

import { useEffect, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import { resolveMaxInputs } from '@/shared/lib/reference-upload'
import type { ModelConfig } from '@/shared/types'
import { ReferenceImagesDialog } from './reference-images-dialog'

const PREVIEW_LIMIT = 3

export function ReferenceImagesTrigger({
  model,
  disabled = false,
}: {
  model: Pick<ModelConfig, 'inputSlots' | 'maxInputImages'> | null | undefined
  disabled?: boolean
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const hasOpened = useRef(false)
  const [isOpen, setIsOpen] = useState(false)

  const stagedImages = useGenerateUiStore((s) => s.stagedImages)
  const maxInputs = resolveMaxInputs(model)
  const uploading = stagedImages.find((image) => image.status === 'uploading')
  const failed = stagedImages.some((image) => image.status === 'error')
  const count = stagedImages.length

  useEffect(() => {
    // Only return focus when a panel we opened actually closed.
    if (!isOpen && hasOpened.current) buttonRef.current?.focus()
  }, [isOpen])

  function openPanel() {
    hasOpened.current = true
    setIsOpen(true)
  }

  const counter = uploading ? `${uploading.progress}%` : `${count}/${maxInputs}`

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={openPanel}
        disabled={disabled}
        aria-label={
          count > 0 ? `参考图，已添加 ${count} 张，最多 ${maxInputs} 张` : '添加参考图'
        }
        className={`flex min-h-8 items-center gap-1.5 rounded-[var(--radius-control)] border bg-surface px-2.5 text-sm font-medium transition-colors duration-[var(--motion-fast)] hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-50 ${
          failed
            ? 'border-danger text-danger'
            : count > 0
              ? 'border-accent text-foreground'
              : 'border-border-control text-foreground'
        }`}
      >
        <ImagePlus
          aria-hidden="true"
          className={maxInputs > 0 ? 'h-4 w-4 text-accent-strong' : 'h-4 w-4 text-muted-foreground'}
        />
        <span>参考图</span>
        {stagedImages.slice(0, PREVIEW_LIMIT).map((image) => (
          <img
            key={image.localId}
            src={image.previewUrl}
            alt=""
            aria-hidden="true"
            className="h-5 w-5 shrink-0 rounded-[calc(var(--radius-control)-4px)] border border-border object-cover"
          />
        ))}
        <span className="font-mono text-sm tabular-nums text-muted-foreground">{counter}</span>
      </button>

      {isOpen && <ReferenceImagesDialog model={model} onClose={() => setIsOpen(false)} />}
    </>
  )
}
