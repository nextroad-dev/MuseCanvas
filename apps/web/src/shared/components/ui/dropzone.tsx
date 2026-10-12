'use client'

import { useId, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import { WarningCircleIcon as CircleAlert, FileTextIcon as FileText, ArrowClockwiseIcon as RefreshCw, TrashIcon as Trash2, UploadSimpleIcon as Upload } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { Button, IconButton } from './button'
import { Progress } from './progress'
import { focusRingPeer } from './interaction'
import { iconSize } from './size'

export type DropZoneFileStatus = 'queued' | 'uploading' | 'done' | 'error'

export interface DropZoneFile {
  id: string
  name: string
  /** Bytes. */
  size: number
  status?: DropZoneFileStatus
  /** 0–100 of the *real* transfer, fed from the caller's XHR/fetch progress event. */
  progress?: number
  /** Per-file failure. Rendered inline and unlocks 重试. */
  error?: string | null
}

export interface FileDropZoneProps {
  files: DropZoneFile[]
  /** Called with the files that survived the local size/type checks. */
  onFilesSelected?: (files: File[]) => void
  onRemove?: (fileId: string) => void
  onRetry?: (fileId: string) => void
  /** Standard `accept` syntax: `.png,image/*,application/pdf`. */
  accept?: string
  multiple?: boolean
  /** Bytes. Rejections are explained inline, never silently dropped. */
  maxFileSize?: number
  /** Selections above this count are rejected with an inline message. */
  maxFiles?: number
  disabled?: boolean
  label?: ReactNode
  hint?: ReactNode
  /** Server-side failure, shown under the drop target. */
  error?: string | null
  className?: string
}

/** Decimal units with the half-width space copy.md §9 requires (`10 MB`). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`
  return `${Number((bytes / 1_000_000).toFixed(1))} MB`
}

function matchesAccept(file: File, accept?: string): boolean {
  if (!accept) return true
  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase()
  return accept
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .some((token) => {
      if (token.startsWith('.')) return name.endsWith(token)
      if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1))
      return type === token
    })
}

/**
 * File upload / dropzone (components.md → File Upload row): the dashed container
 * is the only place dashed borders belong, drag-over raises a primary outline on a
 * tonal base, and every row carries icon + name + size + progress + a named 删除
 * button that is reachable by Tab.
 *
 * Keyboard path is a real `input[type=file]` kept `sr-only` (Tab reaches it,
 * Enter/Space open the native picker) with the visible surface as its `<label>`,
 * so no clickable `<div>` stands in for a control.
 */
export function FileDropZone({
  files,
  onFilesSelected,
  onRemove,
  onRetry,
  accept,
  multiple,
  maxFileSize,
  maxFiles,
  disabled,
  label = '拖拽文件到此处，或点击选择文件',
  hint,
  error,
  className,
}: FileDropZoneProps) {
  const inputId = useId()
  const hintId = `${inputId}-hint`
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [rejection, setRejection] = useState<string | null>(null)

  const fallbackHint = [
    accept ? `支持 ${accept.split(',').join(' / ')} 格式` : null,
    maxFileSize ? `单个文件不超过 ${formatFileSize(maxFileSize)}` : null,
  ]
    .filter(Boolean)
    .join('，')
  const shownHint: ReactNode = hint ?? (fallbackHint || null)

  function ingest(selected: File[]) {
    if (disabled || selected.length === 0) return
    const reasons: string[] = []
    const overCount = maxFiles !== undefined && selected.length > maxFiles
    if (overCount) reasons.push(`一次最多选择 ${maxFiles} 个文件。请减少选择数量后重试。`)

    const accepted = selected.filter((file) => {
      if (maxFileSize !== undefined && file.size > maxFileSize) {
        reasons.push(`无法上传：“${file.name}” 超过 ${formatFileSize(maxFileSize)}。请压缩后重试。`)
        return false
      }
      if (!matchesAccept(file, accept)) {
        reasons.push(`无法上传：“${file.name}” 的文件类型不受支持。请改为 ${accept ?? '支持的文件类型'}。`)
        return false
      }
      return true
    })

    setRejection(reasons.length ? Array.from(new Set(reasons)).join(' ') : null)
    if (!overCount && accepted.length) onFilesSelected?.(accepted)
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (disabled) return
    ingest(Array.from(event.dataTransfer.files ?? []))
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div
        onDragEnter={() => {
          if (disabled) return
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragging(false)
        }}
        onDrop={onDrop}
        aria-disabled={disabled || undefined}
        className={cn(
          'flex flex-col items-center gap-2 rounded-control border-2 border-dashed px-4 py-6 text-center',
          'transition-colors',
          dragging ? 'border-primary bg-tonal-hover' : 'border-border-control bg-tonal',
          disabled && 'is-disabled',
        )}
      >
        <input
          id={inputId}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          aria-describedby={shownHint ? hintId : undefined}
          onChange={(event) => {
            ingest(Array.from(event.target.files ?? []))
            // Clear it, so picking the same file again still fires a change.
            event.target.value = ''
          }}
          className="peer sr-only"
        />
        {/* The ring lives on the label because the focused input is off-screen;
            same tokens as the global ring, transferred via `peer-focus-visible`. */}
        <label
          htmlFor={inputId}
          className={cn(
            'flex cursor-pointer flex-col items-center gap-2 rounded-control peer-disabled:cursor-not-allowed',
            focusRingPeer,
          )}
        >
          <Upload weight="duotone" aria-hidden="true" className={`${iconSize.xl} text-muted-foreground`} />
          <span className="text-sm font-medium text-foreground">{label}</span>
        </label>
        {shownHint ? (
          <p id={hintId} className="text-xs text-muted-foreground">
            {shownHint}
          </p>
        ) : null}
        {rejection ? (
          <p role="alert" className="flex items-start gap-1 text-xs text-danger">
            <CircleAlert weight="fill" aria-hidden="true" className={`mt-0.5 ${iconSize.xs} shrink-0`} />
            <span>{rejection}</span>
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="flex items-start gap-1 text-xs text-danger">
          <CircleAlert weight="fill" aria-hidden="true" className={`mt-0.5 ${iconSize.xs} shrink-0`} />
          <span>{error}</span>
        </p>
      ) : null}

      {files.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {files.map((file) => {
            const uploading = file.status === 'uploading'
            const failed = file.status === 'error' || Boolean(file.error)
            return (
              <li
                key={file.id}
                className={cn(
                  'flex flex-wrap items-center gap-3 rounded-control border bg-surface px-3 py-2',
                  failed ? 'border-danger' : 'border-border',
                )}
              >
                <FileText weight="bold" aria-hidden="true" className={`${iconSize.md} shrink-0 text-muted-foreground`} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm text-foreground">{file.name}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{formatFileSize(file.size)}</span>
                  {uploading || typeof file.progress === 'number' ? (
                    <Progress value={file.progress ?? null} label={file.name} showLabelRow={false} className="max-w-form" />
                  ) : null}
                  {file.error ? <span className="text-xs text-danger">{file.error}</span> : null}
                  {file.status === 'done' ? <span className="text-xs text-success">上传完成</span> : null}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {failed && onRetry ? (
                    <Button variant="secondary" size="sm" onClick={() => onRetry(file.id)} icon={<RefreshCw weight="bold" />}>
                      重试
                    </Button>
                  ) : null}
                  {onRemove ? (
                    <IconButton
                      variant="danger-ghost"
                      size="sm"
                      aria-label={`删除 ${file.name}`}
                      onClick={() => onRemove(file.id)}
                      icon={<Trash2 weight="bold" />}
                    />
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
