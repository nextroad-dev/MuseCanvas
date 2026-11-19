'use client'

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import {
  AGENT_MESSAGE_MAX_ATTACHMENTS,
  clampEditSelection,
  editSelectionIsUsable,
  MIN_EDIT_SELECTION_PX,
  type EditSelection,
} from '@musecanvas/contracts'
import {
  ApertureIcon,
  CameraIcon,
  CubeIcon,
  FileIcon,
  FilmStripIcon,
  PaintBrushIcon,
  PaletteIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  StopCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { Alert, Button, Dialog, DropdownMenu, iconSize, Progress } from '@/shared/components/ui'
import type { AgentConsoleController } from '@/shared/hooks/useAgentConsole'
import { useFlipList } from '@/shared/hooks/useFlipList'
import { agentApi, isApiError } from '@/shared/services/client-api'
import { WORKSPACE_MODE } from '@/shared/lib/workspace-mode'
import {
  countAgentMessageAttachmentReferences,
  toAgentMessageAttachments,
  validateAgentMessageAttachmentCount,
} from '../lib/attachment-references'
import {
  deleteReferenceUpload,
  readImageDimensions,
  UPLOAD_LIMITS,
  uploadReferenceFile,
  validateImageDimensions,
  validateReferenceSelection,
} from '@/shared/lib/reference-upload'
import { cn } from '@/shared/lib/cn'
import { formatBytes } from '@/shared/lib/format'
import {
  AGENT_MESSAGE_MAX_BYTES,
  isMessageOverLimit,
  utf8ByteLength,
} from '../lib/agent-status'
import type { ReferenceImageAttachment } from '../stores/agent-console-store'

const ASPECT_RATIO_OPTIONS = [
  ['auto', '自适应画幅'],
  ['1:1', '1:1 方图'],
  ['3:4', '3:4 竖图'],
  ['4:3', '4:3 横图'],
  ['16:9', '16:9 宽屏'],
  ['9:16', '9:16 竖屏'],
] as const

const STYLE_PRESET_OPTIONS = [
  ['none', '默认风格'],
  ['自然写实摄影', '写实摄影'],
  ['电影级光影质感', '电影光影'],
  ['东方水墨写意', '东方水墨'],
  ['温润胶片颗粒', '自然胶片'],
  ['精致微缩立体建筑', '3D 微缩'],
] as const

function AspectRatioIcon({ ratio }: { ratio: string }) {
  let shape: React.ReactNode
  switch (ratio) {
    case '1:1':
      shape = <rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1.5" />
      break
    case '3:4':
      shape = <rect x="4" y="2.75" width="8" height="10.5" rx="1.5" />
      break
    case '4:3':
      shape = <rect x="2.75" y="4" width="10.5" height="8" rx="1.5" />
      break
    case '16:9':
      shape = <rect x="1.75" y="4.5" width="12.5" height="7" rx="1.5" />
      break
    case '9:16':
      shape = <rect x="4.5" y="1.75" width="7" height="12.5" rx="1.5" />
      break
    case 'auto':
    default:
      shape = (
        <path
          d="M2.5 5.5V3.5a1 1 0 0 1 1-1h2M10.5 2.5h2a1 1 0 0 1 1 1v2M13.5 10.5v2a1 1 0 0 1-1 1h-2M5.5 13.5h-2a1 1 0 0 1-1-1v-2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )
      break
  }

  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={cn(iconSize.sm, 'shrink-0')}
      aria-hidden="true"
    >
      {shape}
    </svg>
  )
}

function StylePresetIcon({ preset }: { preset: string }) {
  const iconClassName = cn(iconSize.sm, 'shrink-0')
  switch (preset) {
    case '自然写实摄影':
      return <CameraIcon className={iconClassName} aria-hidden="true" />
    case '电影级光影质感':
      return <FilmStripIcon className={iconClassName} aria-hidden="true" />
    case '东方水墨写意':
      return <PaintBrushIcon className={iconClassName} aria-hidden="true" />
    case '温润胶片颗粒':
      return <ApertureIcon className={iconClassName} aria-hidden="true" />
    case '精致微缩立体建筑':
      return <CubeIcon className={iconClassName} aria-hidden="true" />
    case 'none':
    default:
      return <PaletteIcon className={iconClassName} aria-hidden="true" />
  }
}

const COMPOSER_TOOL_ICON_BUTTON_CLASS =
  'motion-press inline-flex size-9 shrink-0 items-center justify-center rounded-pill border p-0 disabled:cursor-not-allowed disabled:opacity-50'

export interface AgentComposerProps {
  console: AgentConsoleController
  draftPrompt: string
  onChangeDraft: (value: string) => void
  draftAttachments?: ReferenceImageAttachment[]
  onAddAttachment?: (attachment: ReferenceImageAttachment) => boolean
  onRemoveAttachment?: (id: string) => void
  onClearAttachments?: () => void
  onRecordMessageAttachments?: (
    sessionId: string,
    content: string,
    attachments: ReferenceImageAttachment[],
  ) => void
  reuseKind?: string | null
  /** 局部修改使用的图像模型；null 时禁用选区准备。 */
  editModelId?: string | null
  onCreateSession: () => void
  creatingSession?: boolean
}

const COMPOSER_MIN_HEIGHT_PX = 44
const COMPOSER_MAX_HEIGHT_PX = 192

interface ComposerUploadJob {
  key: string
  name: string
  progress: number | null
}

function uploadFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`
}

function attachmentUploadIds(attachment: ReferenceImageAttachment): string[] {
  return Array.from(new Set([
    attachment.uploadId,
    attachment.preparation?.maskUploadId,
    attachment.preparation?.sourceKind === 'upload' ? attachment.preparation.sourceId : undefined,
  ].filter((id): id is string => Boolean(id))))
}

function attachmentDraftSignature(attachments: readonly ReferenceImageAttachment[]): string {
  return JSON.stringify(attachments.map((attachment) => [
    attachment.id,
    attachment.source,
    attachment.uploadId,
    attachment.assetId,
    attachment.checksum,
    attachment.mimeType,
    attachment.width,
    attachment.height,
    attachment.preparation?.maskUploadId,
    attachment.preparation?.maskChecksum,
    attachment.preparation?.sourceKind,
    attachment.preparation?.sourceId,
    attachment.preparation?.sourceChecksum,
    attachment.preparation?.expiresAt,
  ]))
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`无法读取图片文件：${file.name}`))
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!dataUrl) {
        reject(new Error(`读取图片为空：${file.name}`))
        return
      }
      resolve(dataUrl)
    }
    reader.readAsDataURL(file)
  })
}

/**
 * 底部悬浮交互输入器：支持发起消息、进行中轮次 Steer 追加引导、停止轮次、
 * 本地图片上传 / 拖拽 / 剪贴板粘贴参考图、图库/产物参考图预览与灯箱查看。
 */
export function AgentComposer({
  console: agentConsole,
  draftPrompt,
  onChangeDraft,
  draftAttachments = [],
  onAddAttachment,
  onRemoveAttachment,
  onClearAttachments,
  onRecordMessageAttachments,
  editModelId = null,
  onCreateSession,
  creatingSession = false,
}: AgentComposerProps) {
  const {
    sessionId,
    activeTurn,
    turnActive,
    serviceStatus,
    sendMessage,
    steerTurn,
    cancelTurn,
    mutations,
  } = agentConsole

  const [submitError, setSubmitError] = useState<string | null>(null)
  const [uploadJobs, setUploadJobs] = useState<ComposerUploadJob[]>([])
  const [selectionDraft, setSelectionDraft] = useState<EditSelection | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [selectionBusy, setSelectionBusy] = useState(false)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [previewAttachment, setPreviewAttachment] = useState<ReferenceImageAttachment | null>(null)
  const [aspectRatio, setAspectRatio] = useState<string>('auto')
  const [stylePreset, setStylePreset] = useState<string>('none')
  const submittingRef = useRef(false)
  const selectionBusyRef = useRef(false)
  const draftPromptRef = useRef(draftPrompt)
  const aspectRatioRef = useRef(aspectRatio)
  const stylePresetRef = useRef(stylePreset)
  const draftAttachmentsRef = useRef(draftAttachments)
  const knownFileKeysRef = useRef(new Set<string>())
  const pendingFileKeysRef = useRef(new Set<string>())
  const attachmentFileKeysRef = useRef(new Map<string, string>())
  const ingestionGenerationRef = useRef(0)
  const ingestionQueueRef = useRef<Promise<void>>(Promise.resolve())
  const acceptedUploadIdsRef = useRef(new Set<string>())
  const attachmentsRef = useRef<HTMLDivElement | null>(null)
  const attachmentsOrderKey = draftAttachments.map((att) => att.id).join(',')
  useFlipList(attachmentsRef, attachmentsOrderKey)
  const pendingSubmissionUploadCountsRef = useRef(new Map<string, number>())
  const clientMessageIdRef = useRef<string | null>(null)
  const submissionKeyRef = useRef<string | null>(null)
  const preparationAttemptRef = useRef<{ key: string; idempotencyKey: string } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const previewBoxRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const trimmed = draftPrompt.trim()
  const hasAttachments = draftAttachments.length > 0
  const baseText =
    trimmed.length > 0
      ? trimmed
      : `请参考所附加的 ${draftAttachments.length} 张参考图（${draftAttachments.map((a) => a.name).join('、')}）进行创作与构图延展`
  const modifiers: string[] = []
  if (aspectRatio !== 'auto' && !baseText.includes(aspectRatio)) {
    modifiers.push(`${aspectRatio} 画幅`)
  }
  if (stylePreset !== 'none' && !baseText.includes(stylePreset)) {
    modifiers.push(stylePreset)
  }
  const effectiveContent =
    modifiers.length > 0 ? `${baseText}（${modifiers.join(' · ')}）` : baseText
  const byteCount = utf8ByteLength(effectiveContent)
  const overLimit = isMessageOverLimit(effectiveContent, AGENT_MESSAGE_MAX_BYTES)
  const showByteCount = overLimit || byteCount > 24_000
  const attachmentReferenceCount = countAgentMessageAttachmentReferences(draftAttachments)
  const isUploadPending = uploadJobs.length > 0
  const isDisabledService = serviceStatus === 'disabled_404'
  const isCancelling = Boolean(turnActive && activeTurn?.cancelRequestedAt)
  const isSending = mutations.sendMessage.isPending || mutations.steerTurn.isPending
  const isCancellingMutation = mutations.cancelTurn.isPending

  const canSubmit =
    Boolean(sessionId) &&
    (trimmed.length > 0 || hasAttachments) &&
    !overLimit &&
    !isDisabledService &&
    !isCancelling &&
    !isSending &&
    !isUploadPending &&
    !selectionBusy

  const displaySelection = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0),
      }
    : null

  useEffect(() => {
    draftPromptRef.current = draftPrompt
  }, [draftPrompt])

  useEffect(() => {
    aspectRatioRef.current = aspectRatio
    stylePresetRef.current = stylePreset
  }, [aspectRatio, stylePreset])

  useEffect(() => {
    draftAttachmentsRef.current = draftAttachments
    const attachmentIds = new Set(draftAttachments.map((attachment) => attachment.id))
    for (const [attachmentId, fileKey] of attachmentFileKeysRef.current) {
      if (!attachmentIds.has(attachmentId)) {
        attachmentFileKeysRef.current.delete(attachmentId)
        if (!pendingFileKeysRef.current.has(fileKey)) knownFileKeysRef.current.delete(fileKey)
      }
    }
  }, [draftAttachments])

  // 随输入内容自动伸缩高度（44px ~ 192px），避免 resize-y 拖曳角破坏悬浮卡片轮廓。
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const nextHeight = Math.min(
      Math.max(el.scrollHeight, COMPOSER_MIN_HEIGHT_PX),
      COMPOSER_MAX_HEIGHT_PX,
    )
    el.style.height = `${nextHeight}px`
  }, [draftPrompt])

  function updateUploadJob(key: string, progress: number | null) {
    setUploadJobs((current) => current.map((job) => job.key === key ? { ...job, progress } : job))
  }

  function finishUploadJob(file: File, keep: boolean) {
    const key = uploadFileKey(file)
    pendingFileKeysRef.current.delete(key)
    if (!keep) knownFileKeysRef.current.delete(key)
    setUploadJobs((current) => current.filter((job) => job.key !== key))
  }

  function addAttachment(attachment: ReferenceImageAttachment, fileKey?: string): boolean {
    if (!onAddAttachment) return false
    const added = onAddAttachment(attachment)
    if (!added) return false
    const current = draftAttachmentsRef.current
    const existingIndex = current.findIndex(
      (item) => item.id === attachment.id || item.url === attachment.url,
    )
    draftAttachmentsRef.current = existingIndex >= 0
      ? current.map((item, index) => index === existingIndex ? attachment : item)
      : [...current, attachment]
    if (fileKey) attachmentFileKeysRef.current.set(attachment.id, fileKey)
    return true
  }

  function forgetAttachmentFile(attachment: ReferenceImageAttachment) {
    const fileKey = attachmentFileKeysRef.current.get(attachment.id)
    if (!fileKey) return
    attachmentFileKeysRef.current.delete(attachment.id)
    if (!pendingFileKeysRef.current.has(fileKey)) knownFileKeysRef.current.delete(fileKey)
  }

  async function cleanupRemoteUploads(uploadIds: string[]): Promise<string | null> {
    if (WORKSPACE_MODE === 'mock') return null
    const ids = Array.from(new Set(uploadIds)).filter(
      (id) => !acceptedUploadIdsRef.current.has(id) && !pendingSubmissionUploadCountsRef.current.has(id),
    )
    if (ids.length === 0) return null
    const results = await Promise.allSettled(ids.map((id) => deleteReferenceUpload(id)))
    return results.some((result) => result.status === 'rejected')
      ? '部分远端上传清理失败，请稍后重试；本地草稿状态保持不变。'
      : null
  }

  function reportCleanup(uploadIds: string[]) {
    void cleanupRemoteUploads(uploadIds).then((error) => {
      if (error) setSubmitError(error)
    })
  }

  function changeDraft(value: string) {
    draftPromptRef.current = value
    onChangeDraft(value)
  }

  function changeAspectRatio(value: string) {
    aspectRatioRef.current = value
    setAspectRatio(value)
  }

  function changeStylePreset(value: string) {
    stylePresetRef.current = value
    setStylePreset(value)
  }

  function removeAttachment(attachment: ReferenceImageAttachment) {
    onRemoveAttachment?.(attachment.id)
    draftAttachmentsRef.current = draftAttachmentsRef.current.filter((item) => item.id !== attachment.id)
    forgetAttachmentFile(attachment)
    reportCleanup(attachmentUploadIds(attachment))
  }

  function clearDraftAttachments() {
    const current = draftAttachmentsRef.current
    ingestionGenerationRef.current += 1
    onClearAttachments?.()
    draftAttachmentsRef.current = []
    for (const attachment of current) forgetAttachmentFile(attachment)
    reportCleanup(current.flatMap(attachmentUploadIds))
  }

  async function processImageFiles(files: File[], generation: number) {
    if (generation !== ingestionGenerationRef.current) {
      for (const file of files) finishUploadJob(file, false)
      return
    }
    const current = draftAttachmentsRef.current
    const selection = validateReferenceSelection(files, {
      selectedCount: countAgentMessageAttachmentReferences(current),
      totalBytes: current.reduce((total, attachment) => total + (attachment.sizeBytes ?? 0), 0),
      maxInputs: AGENT_MESSAGE_MAX_ATTACHMENTS,
    })
    if (selection.errors.length > 0) setSubmitError(selection.errors.join('；'))
    const accepted = new Set(selection.accepted)
    for (const file of files) {
      if (!accepted.has(file)) finishUploadJob(file, false)
    }
    for (const file of selection.accepted) {
      const key = uploadFileKey(file)
      if (generation !== ingestionGenerationRef.current) {
        finishUploadJob(file, false)
        continue
      }
      let keep = false
      let added = false
      let rejected = false
      let completedUploadId: string | null = null
      try {
        const [dataUrl, dimensions] = await Promise.all([
          readFileAsDataUrl(file),
          readImageDimensions(file),
        ])
        if (generation !== ingestionGenerationRef.current) continue
        const validationError = validateImageDimensions(dimensions.width, dimensions.height)
        const dimensionsError = dimensions.error || validationError
        if (dimensionsError) throw new Error(`图片「${file.name}」：${dimensionsError}`)
        const name = file.name.replace(/\.[^.]+$/, '') || '本地上传图片'
        if (WORKSPACE_MODE === 'mock') {
          added = addAttachment({
            id: `upload-${file.name}-${file.size}-${file.lastModified}`,
            url: dataUrl,
            name,
            mimeType: file.type,
            width: dimensions.width,
            height: dimensions.height,
            sizeBytes: file.size,
            source: 'upload',
          }, key)
        } else {
          updateUploadJob(key, 0)
          const upload = await uploadReferenceFile(file, {
            onProgress: (progress) => updateUploadJob(key, progress),
          })
          completedUploadId = upload.id
          if (generation !== ingestionGenerationRef.current) {
            const cleanupError = await cleanupRemoteUploads([upload.id])
            if (cleanupError) setSubmitError(cleanupError)
            continue
          }
          added = addAttachment({
            id: `upload-${upload.id}`,
            uploadId: upload.id,
            checksum: upload.checksum,
            url: dataUrl,
            name,
            mimeType: upload.mimeType,
            width: upload.width,
            height: upload.height,
            sizeBytes: upload.sizeBytes,
            source: 'upload',
          }, key)
        }
        if (!added) {
          rejected = true
          throw new Error(`附件引用最多 ${AGENT_MESSAGE_MAX_ATTACHMENTS} 个，局部修改会占用 2 个，请先减少参考图。`)
        }
        keep = true
      } catch (error) {
        let message = error instanceof Error ? error.message : '读取或上传参考图失败，请重试。'
        if (completedUploadId && !added) {
          const cleanupError = await cleanupRemoteUploads([completedUploadId])
          if (cleanupError) message = `${message} ${cleanupError}`
        }
        setSubmitError(message)
      } finally {
        finishUploadJob(file, keep)
      }
      if (rejected) break
    }
    for (const file of selection.accepted) {
      if (pendingFileKeysRef.current.has(uploadFileKey(file))) finishUploadJob(file, false)
    }
  }

  function ingestImageFiles(files: File[]) {
    if (!onAddAttachment || files.length === 0) return
    const uniqueFiles: File[] = []
    for (const file of files) {
      const key = uploadFileKey(file)
      if (knownFileKeysRef.current.has(key)) continue
      knownFileKeysRef.current.add(key)
      pendingFileKeysRef.current.add(key)
      uniqueFiles.push(file)
    }
    if (uniqueFiles.length === 0) {
      setSubmitError('所选图片已添加或正在处理，请勿重复添加。')
      return
    }
    setSubmitError(null)
    setUploadJobs((current) => [
      ...current,
      ...uniqueFiles.map((file) => ({ key: uploadFileKey(file), name: file.name, progress: null })),
    ])
    const generation = ingestionGenerationRef.current
    ingestionQueueRef.current = ingestionQueueRef.current
      .then(() => processImageFiles(uniqueFiles, generation))
      .catch((error) => {
        for (const file of uniqueFiles) {
          if (pendingFileKeysRef.current.has(uploadFileKey(file))) finishUploadJob(file, false)
        }
        setSubmitError(error instanceof Error ? error.message : '读取或上传参考图失败，请重试。')
      })
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files ? Array.from(event.target.files) : []
    event.target.value = ''
    void ingestImageFiles(files)
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items ? Array.from(event.clipboardData.items) : []
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      event.preventDefault()
      void ingestImageFiles(files)
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (isDisabledService || !onAddAttachment) return
    if (event.dataTransfer?.types?.includes('Files')) {
      event.preventDefault()
      setIsDraggingOver(true)
    }
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setIsDraggingOver(false)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    setIsDraggingOver(false)
    if (isDisabledService || !onAddAttachment) return
    const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : []
    if (files.length > 0) {
      event.preventDefault()
      void ingestImageFiles(files)
    }
  }

  function boxRect(): DOMRect | null {
    return previewBoxRef.current?.getBoundingClientRect() ?? null
  }

  /** 指针位置 → 图片显示坐标（与渲染盒同一个坐标系）。 */
  function pointerPoint(event: { clientX: number; clientY: number }, rect: DOMRect) {
    return {
      x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
    }
  }

  /** 显示坐标按预览缩放比还原为源图像素坐标，交给契约里的边界校验。 */
  function selectionFromDrag(attachment: ReferenceImageAttachment, rect: DOMRect) {
    if (!drag || !attachment.width || !attachment.height || rect.width <= 0 || rect.height <= 0) return null
    const x = Math.min(drag.x0, drag.x1)
    const y = Math.min(drag.y0, drag.y1)
    const width = Math.abs(drag.x1 - drag.x0)
    const height = Math.abs(drag.y1 - drag.y0)
    return clampEditSelection(
      {
        x: (x / rect.width) * attachment.width,
        y: (y / rect.height) * attachment.height,
        width: (width / rect.width) * attachment.width,
        height: (height / rect.height) * attachment.height,
      },
      attachment.width,
      attachment.height,
    )
  }

  function handleSelectionStart(event: PointerEvent<HTMLDivElement>) {
    const rect = boxRect()
    if (!rect) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointerPoint(event, rect)
    setDrag({ x0: point.x, y0: point.y, x1: point.x, y1: point.y })
    setSelectionDraft(null)
    setSelectionError(null)
  }

  function handleSelectionMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag) return
    const rect = boxRect()
    if (!rect) return
    const point = pointerPoint(event, rect)
    setDrag(current => (current ? { ...current, x1: point.x, y1: point.y } : current))
  }

  function handleSelectionEnd() {
    const attachment = previewAttachment
    const rect = boxRect()
    if (!attachment || !rect) return
    const selection = selectionFromDrag(attachment, rect)
    if (!selection) {
      setSelectionError(`选区无效：请拖拽出至少 ${MIN_EDIT_SELECTION_PX}×${MIN_EDIT_SELECTION_PX} 像素的区域。`)
      return
    }
    setSelectionDraft(selection)
    setSelectionError(null)
  }

  async function prepareSelection(attachment: ReferenceImageAttachment) {
    if (WORKSPACE_MODE === 'mock') {
      setSelectionError('预览模式未连接后端，暂不支持生成服务端局部修改蒙版，但你可以体验框选交互。')
      return
    }
    if (!editModelId) {
      setSelectionError('尚未配置可用的图像模型，无法准备局部修改。')
      return
    }
    if (!selectionDraft || !editSelectionIsUsable(selectionDraft) || !attachment.assetId) {
      setSelectionError(attachment.assetId ? '请先在图上框选要修改的区域。' : '局部修改只支持已保存到图库的图片。')
      return
    }
    if (selectionBusyRef.current) return
    if (countAgentMessageAttachmentReferences(draftAttachmentsRef.current) + (attachment.preparation ? 0 : 1) > AGENT_MESSAGE_MAX_ATTACHMENTS) {
      setSelectionError(`局部修改会占用 2 个附件引用，消息最多 ${AGENT_MESSAGE_MAX_ATTACHMENTS} 个，请先减少参考图。`)
      return
    }
    selectionBusyRef.current = true
    setSelectionBusy(true)
    setSelectionError(null)
    const preparationKey = JSON.stringify({
      sessionId,
      turnId: turnActive && activeTurn && !isCancelling ? activeTurn.id : null,
      editModelId,
      assetId: attachment.assetId,
      selection: selectionDraft,
    })
    if (preparationAttemptRef.current?.key !== preparationKey) {
      preparationAttemptRef.current = { key: preparationKey, idempotencyKey: crypto.randomUUID() }
    }
    try {
      const prepared = await agentApi.prepareImageEdit({
        ...(sessionId ? { sessionId } : {}),
        ...(sessionId && turnActive && activeTurn && !isCancelling ? { turnId: activeTurn.id } : {}),
        modelId: editModelId,
        assetId: attachment.assetId,
        selection: selectionDraft,
        idempotencyKey: preparationAttemptRef.current.idempotencyKey,
      })
      preparationAttemptRef.current = null
      // 准备身份属于这张源图：原地更新同一条附件（upsert by id），
      // 而不是再添一张会造成「源图两份」的附件。
      const nextAttachment: ReferenceImageAttachment = {
        ...attachment,
        preparation: {
          maskUploadId: prepared.maskUploadId,
          maskChecksum: prepared.maskChecksum,
          sourceKind: prepared.source.kind,
          sourceId: prepared.source.id,
          sourceChecksum: prepared.sourceChecksum,
          expiresAt: prepared.expiresAt,
          selection: prepared.selection ?? selectionDraft,
        },
      }
      const current = draftAttachmentsRef.current
      if (!current.some((item) => item.id === attachment.id)) {
        const cleanupError = await cleanupRemoteUploads([prepared.maskUploadId])
        setSelectionError(cleanupError ?? '参考图已移除，无法保存局部修改准备。')
        return
      }
      try {
        validateAgentMessageAttachmentCount(current.map((item) => item.id === attachment.id ? nextAttachment : item))
      } catch (error) {
        const cleanupError = await cleanupRemoteUploads([prepared.maskUploadId])
        setSelectionError(cleanupError ?? (error instanceof Error ? error.message : '附件引用超出上限。'))
        return
      }
      const added = addAttachment(nextAttachment)
      if (!added) {
        const cleanupError = await cleanupRemoteUploads([prepared.maskUploadId])
        setSelectionError(cleanupError ?? '参考图已满，无法保存局部修改准备。')
        return
      }
      if (attachment.preparation && attachment.preparation.maskUploadId !== prepared.maskUploadId) {
        reportCleanup([attachment.preparation.maskUploadId])
      }
      setSelectionDraft(null)
      setDrag(null)
      setSelectionMode(false)
      setPreviewAttachment(null)
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : '局部修改准备失败，请稍后重试。')
    } finally {
      selectionBusyRef.current = false
      setSelectionBusy(false)
    }
  }

  async function executeSubmit() {
    if (submittingRef.current || !sessionId) return
    if (pendingFileKeysRef.current.size > 0 || selectionBusyRef.current) {
      setSubmitError('请等待参考图处理或上传完成后再发送。')
      return
    }
    if (!canSubmit) return
    submittingRef.current = true
    setSubmitError(null)
    const currentAttachments = [...draftAttachmentsRef.current]
    const submittedPrompt = draftPrompt
    const submittedAspectRatio = aspectRatio
    const submittedStylePreset = stylePreset
    const submittedAttachmentsSignature = attachmentDraftSignature(currentAttachments)
    let attemptedUploadIds: string[] = []
    try {
      if (isMessageOverLimit(effectiveContent, AGENT_MESSAGE_MAX_BYTES)) {
        throw new Error(`消息内容超出 ${AGENT_MESSAGE_MAX_BYTES} UTF-8 字节上限，请缩短指令或调整画幅、风格设置。`)
      }
      validateAgentMessageAttachmentCount(currentAttachments)
      // Mock 预览没有服务端行可验证，附件只作文本之外的本地展示，不编造 id。
      const messageAttachments = WORKSPACE_MODE === 'mock' ? [] : toAgentMessageAttachments(currentAttachments)
      const submissionKey = JSON.stringify({
        sessionId,
        content: effectiveContent,
        attachments: WORKSPACE_MODE === 'mock' ? submittedAttachmentsSignature : messageAttachments,
      })
      if (!clientMessageIdRef.current || submissionKeyRef.current !== submissionKey) {
        clientMessageIdRef.current = crypto.randomUUID()
        submissionKeyRef.current = submissionKey
      }
      const clientMessageId = clientMessageIdRef.current
      if (currentAttachments.length > 0) onRecordMessageAttachments?.(sessionId, effectiveContent, currentAttachments)
      const payloadAttachments = messageAttachments.length > 0 ? messageAttachments : undefined
      attemptedUploadIds = Array.from(new Set(
        messageAttachments
          .filter((attachment) => attachment.kind === 'upload')
          .map((attachment) => attachment.id),
      ))
      for (const id of attemptedUploadIds) {
        const count = pendingSubmissionUploadCountsRef.current.get(id) ?? 0
        pendingSubmissionUploadCountsRef.current.set(id, count + 1)
      }
      if (turnActive && activeTurn) {
        await steerTurn({ turnId: activeTurn.id, content: effectiveContent, clientMessageId, attachments: payloadAttachments })
      } else {
        await sendMessage({ sessionId, content: effectiveContent, clientMessageId, attachments: payloadAttachments })
      }
      for (const id of attemptedUploadIds) {
        pendingSubmissionUploadCountsRef.current.delete(id)
        acceptedUploadIdsRef.current.add(id)
      }
      clientMessageIdRef.current = null
      submissionKeyRef.current = null
      // 仅在后端/模拟引擎明确受理后才清空草稿与参考图；失败时保留用户输入。
      if (
        draftPromptRef.current === submittedPrompt &&
        aspectRatioRef.current === submittedAspectRatio &&
        stylePresetRef.current === submittedStylePreset &&
        attachmentDraftSignature(draftAttachmentsRef.current) === submittedAttachmentsSignature
      ) {
        changeDraft('')
        onClearAttachments?.()
        draftAttachmentsRef.current = []
        for (const attachment of currentAttachments) forgetAttachmentFile(attachment)
      }
    } catch (error) {
      if (isApiError(error) && error.status >= 400 && error.status < 500 && error.status !== 408) {
        for (const id of attemptedUploadIds) {
          const count = pendingSubmissionUploadCountsRef.current.get(id) ?? 0
          if (count > 1) pendingSubmissionUploadCountsRef.current.set(id, count - 1)
          else pendingSubmissionUploadCountsRef.current.delete(id)
        }
      }
      setSubmitError(
        error instanceof Error ? error.message : '指令发送失败，草稿已保留，请重试。',
      )
    } finally {
      submittingRef.current = false
    }
  }

  async function handleCancelTurn() {
    if (!activeTurn || isCancelling || isCancellingMutation) return
    setSubmitError(null)
    try {
      await cancelTurn(activeTurn.id)
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : '取消轮次失败，请刷新状态后重试。',
      )
    }
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void executeSubmit()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.key !== 'Enter') return
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    void executeSubmit()
  }

  return (
    <div className="relative shrink-0 bg-gradient-to-t from-canvas via-canvas/95 to-transparent px-4 pb-4 pt-2 sm:px-6 sm:pb-6 lg:px-10">
      <form
        onSubmit={handleFormSubmit}
        className="mx-auto flex w-full max-w-3xl flex-col gap-2 lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl"
        noValidate
      >
        {submitError ? (
          <Alert tone="danger" role="alert" className="motion-fade-in" onDismiss={() => setSubmitError(null)}>
            {submitError}
          </Alert>
        ) : null}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg"
          multiple
          aria-label="选择本地参考图片"
          onChange={handleFileInputChange}
          className="sr-only"
        />

        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            'flex flex-col gap-2.5 rounded-panel border bg-surface px-4 pb-3 pt-3.5 shadow-floating',
            isDraggingOver
              ? 'border-accent bg-accent-soft/20 ring-2 ring-accent/30'
              : overLimit
                ? 'border-danger'
                : turnActive
                  ? 'border-accent/35'
                  : 'border-border',
          )}
        >
          {isDraggingOver ? (
            <div className="motion-pop flex items-center justify-center rounded-control bg-accent-soft/45 py-2 text-ui font-medium text-accent">
              <span>释放鼠标以添加 PNG/JPEG 参考图（最多 {AGENT_MESSAGE_MAX_ATTACHMENTS} 个附件引用）</span>
            </div>
          ) : null}

          {hasAttachments ? (
            <div
              role="region"
              aria-label="已附加参考图"
              className="space-y-2 border-b border-border/50 pb-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-caption font-medium text-muted-foreground">
                  参考图 · 附件引用 ({attachmentReferenceCount}/{AGENT_MESSAGE_MAX_ATTACHMENTS})
                </span>
                {draftAttachments.length > 1 && onClearAttachments ? (
                  <button
                    type="button"
                    aria-label="清空全部参考图"
                    disabled={isSending}
                    onClick={clearDraftAttachments}
                    className="rounded-control px-1.5 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    清空参考图
                  </button>
                ) : null}
              </div>

              <div ref={attachmentsRef} className="flex flex-wrap items-center gap-2">
                {draftAttachments.map((att) => (
                  <div key={att.id} data-flip-key={att.id}>
                    <div
                      className="motion-pop group relative flex max-w-56 items-center gap-2 rounded-control bg-tonal/70 p-1.5 pr-7 transition-colors hover:bg-tonal"
                    >
                    <button
                      type="button"
                      aria-label={`预览参考图：${att.name}`}
                      onClick={() => setPreviewAttachment(att)}
                      className="relative size-11 shrink-0 overflow-hidden rounded-control border border-border/60 bg-canvas"
                    >
                      <img
                        src={att.url}
                        alt={att.name}
                        className="h-full w-full object-cover"
                      />
                    </button>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-caption font-medium text-foreground">
                        {att.name}
                      </p>
                      <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
                        <span>
                          {att.source === 'library'
                            ? '图库复用'
                            : att.source === 'artifact'
                              ? '产物复用'
                              : '本地上传'}
                        </span>
                        {att.prompt && !draftPrompt.trim() ? (
                          <button
                            type="button"
                            onClick={() => changeDraft(att.prompt!)}
                            className="inline-flex items-center text-accent hover:underline"
                          >
                            <span>用原提示词</span>
                          </button>
                        ) : null}
                      </div>
                      {att.preparation ? (
                        <span className="mt-1 block text-caption text-muted-foreground">
                          局部修改准备有效期至 {new Date(att.preparation.expiresAt).toLocaleString()}
                        </span>
                      ) : att.source === 'library' && att.assetId ? (
                        <button
                          type="button"
                          disabled={WORKSPACE_MODE !== 'mock' && !editModelId}
                          title={
                            WORKSPACE_MODE !== 'mock' && !editModelId
                              ? '尚未配置可用的图像模型'
                              : '在图上框选区域并准备局部修改'
                          }
                          onClick={() => {
                            setPreviewAttachment(att)
                            setSelectionMode(true)
                            setSelectionDraft(null)
                            setDrag(null)
                            setSelectionError(null)
                          }}
                          className="mt-1 inline-flex items-center text-caption text-accent hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
                        >
                          局部修改…
                        </button>
                      ) : null}
                    </div>

                    {onRemoveAttachment ? (
                      <button
                        type="button"
                        aria-label={`移除参考图 ${att.name}`}
                        title={`移除参考图 ${att.name}`}
                        disabled={isSending}
                        onClick={() => removeAttachment(att)}
                        className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-pill text-ui leading-none text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <XIcon className={iconSize.xs} aria-hidden="true" />
                      </button>
                    ) : null}
                    </div>
                  </div>
                ))}

                {attachmentReferenceCount < AGENT_MESSAGE_MAX_ATTACHMENTS && onAddAttachment ? (
                  <button
                    type="button"
                    aria-label="继续添加参考图"
                    title="继续添加参考图"
                    disabled={isSending}
                    onClick={() => fileInputRef.current?.click()}
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-control border border-dashed border-border/80 bg-transparent text-caption text-muted-foreground transition-colors hover:border-accent hover:text-accent"
                  >
                    <PlusIcon className={iconSize.sm} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {uploadJobs.length > 0 ? (
            <div aria-live="polite" className="space-y-2 rounded-control bg-tonal/50 p-2.5">
              {uploadJobs.map((job) => (
                <Progress
                  key={job.key}
                  value={job.progress}
                  label={`${job.name} · ${job.progress === null ? '读取与校验中' : job.progress >= 100 ? '服务端确认中' : '上传中'}`}
                  valueLabel={job.progress !== null && job.progress >= 100 ? '确认中' : undefined}
                  size="sm"
                />
              ))}
            </div>
          ) : null}

          <p className="text-caption text-muted-foreground">
            仅支持 PNG/JPEG · 单张 ≤ {formatBytes(UPLOAD_LIMITS.maxImageBytes)} · 合计 ≤ {formatBytes(UPLOAD_LIMITS.maxTotalBytes)} · 尺寸 {UPLOAD_LIMITS.minDimension}–{UPLOAD_LIMITS.maxDimension} 像素 · 宽高比 ≤ {UPLOAD_LIMITS.maxAspectRatio}:1
          </p>

          {selectionError ? <Alert tone="danger" className="text-caption">{selectionError}</Alert> : null}

          <textarea
            ref={textareaRef}
            rows={1}
            value={draftPrompt}
            disabled={isDisabledService}
            aria-invalid={overLimit || undefined}
            aria-label="输入 Agent 指令"
            placeholder={
              hasAttachments
                ? '描述如何基于参考图进行创作、调整构图或光影（可直接发送）…'
                : '输入创作需求或执行目标，支持上传或粘贴参考图…'
            }
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onChange={(event) => {
              changeDraft(event.target.value)
              if (submitError) setSubmitError(null)
            }}
            className="min-h-11 max-h-48 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-compact leading-relaxed text-foreground placeholder:text-decorative-muted transition-[height] duration-(--motion-fast) focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
          />

          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {onAddAttachment ? (
                <button
                  type="button"
                  aria-label="上传参考图"
                  title={`上传 PNG/JPEG 参考图，单张不超过 ${formatBytes(UPLOAD_LIMITS.maxImageBytes)}`}
                  disabled={
                    isDisabledService || isSending || attachmentReferenceCount >= AGENT_MESSAGE_MAX_ATTACHMENTS
                  }
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    COMPOSER_TOOL_ICON_BUTTON_CLASS,
                    hasAttachments
                      ? 'border-accent/35 bg-accent-soft text-accent'
                      : 'border-border/70 bg-canvas/70 text-muted-foreground hover:border-border hover:bg-tonal/70 hover:text-foreground',
                  )}
                >
                  <FileIcon className={cn(iconSize.sm, 'shrink-0')} aria-hidden="true" />
                </button>
              ) : null}

              <div
                className={cn(
                  'inline-flex items-center',
                  aspectRatio !== 'auto' &&
                    'h-9 rounded-pill border border-accent/35 bg-accent-soft text-accent',
                )}
              >
                <DropdownMenu
                  side="top"
                  align="start"
                  size="sm"
                  triggerMode="click"
                  menuLabel="选择创作画幅比例"
                  className={aspectRatio !== 'auto' ? 'h-full' : undefined}
                  menuClassName="w-44"
                  trigger={
                    <button
                      type="button"
                      aria-label="选择创作画幅比例"
                      title={`创作画幅：${ASPECT_RATIO_OPTIONS.find(([val]) => val === aspectRatio)?.[1] ?? '自适应画幅'}`}
                      disabled={isDisabledService}
                      className={
                        aspectRatio !== 'auto'
                          ? 'inline-flex h-full items-center gap-1.5 rounded-l-pill pl-3 pr-1.5 text-caption font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50'
                          : cn(
                              COMPOSER_TOOL_ICON_BUTTON_CLASS,
                              'border-border/70 bg-canvas/70 text-muted-foreground hover:border-border hover:bg-tonal/70 hover:text-foreground',
                            )
                      }
                    >
                      <AspectRatioIcon ratio={aspectRatio} />
                      {aspectRatio !== 'auto' ? <span className="motion-pop">{aspectRatio}</span> : null}
                    </button>
                  }
                  items={ASPECT_RATIO_OPTIONS.map(([val, label]) => ({
                    id: val,
                    label,
                    icon: <AspectRatioIcon ratio={val} />,
                    selected: aspectRatio === val,
                    onSelect: () => changeAspectRatio(val),
                  }))}
                />
                {aspectRatio !== 'auto' ? (
                  <button
                    type="button"
                    aria-label="重置画幅比例"
                    title="重置为自适应画幅"
                    disabled={isDisabledService}
                    onClick={() => changeAspectRatio('auto')}
                    className="motion-pop inline-flex h-full items-center justify-center rounded-r-pill pr-2.5 pl-1 text-accent/80 transition-colors hover:bg-accent/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <XIcon className={iconSize.xs} aria-hidden="true" />
                  </button>
                ) : null}
              </div>

              <div
                className={cn(
                  'inline-flex items-center',
                  stylePreset !== 'none' &&
                    'h-9 rounded-pill border border-accent/35 bg-accent-soft text-accent',
                )}
              >
                <DropdownMenu
                  side="top"
                  align="start"
                  size="sm"
                  triggerMode="click"
                  menuLabel="选择视觉风格预设"
                  className={stylePreset !== 'none' ? 'h-full' : undefined}
                  menuClassName="w-44"
                  trigger={
                    <button
                      type="button"
                      aria-label="选择视觉风格预设"
                      title={`视觉风格：${STYLE_PRESET_OPTIONS.find(([val]) => val === stylePreset)?.[1] ?? '默认风格'}`}
                      disabled={isDisabledService}
                      className={
                        stylePreset !== 'none'
                          ? 'inline-flex h-full items-center gap-1.5 rounded-l-pill pl-3 pr-1.5 text-caption font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50'
                          : cn(
                              COMPOSER_TOOL_ICON_BUTTON_CLASS,
                              'border-border/70 bg-canvas/70 text-muted-foreground hover:border-border hover:bg-tonal/70 hover:text-foreground',
                            )
                      }
                    >
                      <StylePresetIcon preset={stylePreset} />
                      {stylePreset !== 'none' ? (
                        <span className="motion-pop">
                          {STYLE_PRESET_OPTIONS.find(([val]) => val === stylePreset)?.[1] ??
                            stylePreset}
                        </span>
                      ) : null}
                    </button>
                  }
                  items={STYLE_PRESET_OPTIONS.map(([val, label]) => ({
                    id: val,
                    label,
                    icon: <StylePresetIcon preset={val} />,
                    selected: stylePreset === val,
                    onSelect: () => changeStylePreset(val),
                  }))}
                />
                {stylePreset !== 'none' ? (
                  <button
                    type="button"
                    aria-label="重置视觉风格"
                    title="重置为默认风格"
                    disabled={isDisabledService}
                    onClick={() => changeStylePreset('none')}
                    className="motion-pop inline-flex h-full items-center justify-center rounded-r-pill pr-2.5 pl-1 text-accent/80 transition-colors hover:bg-accent/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <XIcon className={iconSize.xs} aria-hidden="true" />
                  </button>
                ) : null}
              </div>

              {overLimit ? (
                <span className="motion-fade-in text-caption text-danger">
                  已超出 32,000 字节上限
                </span>
              ) : null}
              {showByteCount ? (
                <span
                  className={cn(
                    'motion-fade-in font-mono text-caption',
                    overLimit ? 'font-medium text-danger' : 'text-muted-foreground',
                  )}
                >
                  {byteCount} / {AGENT_MESSAGE_MAX_BYTES} B
                </span>
              ) : !sessionId && !isDisabledService ? (
                <span className="motion-fade-in text-caption text-muted-foreground">
                  未选中会话
                </span>
              ) : turnActive ? (
                <span className="motion-fade-in text-caption text-muted-foreground">
                  {isCancelling ? '正在请求停止…' : '运行中 · 可发送引导或停止'}
                </span>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="hidden text-caption text-decorative-muted sm:inline">
                Enter 发送 · Shift+Enter 换行
              </span>
              {!sessionId && !isDisabledService ? (
                <Button
                  size="icon"
                  variant="secondary"
                  className="size-9 shrink-0 rounded-pill"
                  aria-label="新建对话"
                  title="新建对话"
                  icon={<PlusIcon className={iconSize.sm} aria-hidden="true" />}
                  loading={creatingSession}
                  disabled={creatingSession}
                  onClick={onCreateSession}
                />
              ) : null}

              {turnActive && activeTurn && !canSubmit ? (
                <Button
                  type="button"
                  size="icon"
                  variant="danger-ghost"
                  className="size-9 shrink-0 rounded-pill"
                  aria-label={isCancelling ? '停止中' : '停止'}
                  title={isCancelling ? '停止中' : '停止'}
                  icon={<StopCircleIcon weight="fill" className={iconSize.sm} aria-hidden="true" />}
                  disabled={isCancelling || isCancellingMutation}
                  loading={isCancellingMutation}
                  onClick={() => void handleCancelTurn()}
                />
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  variant="primary"
                  className="size-9 shrink-0 rounded-pill"
                  aria-label={turnActive && activeTurn ? '追加引导' : '发送'}
                  title={turnActive && activeTurn ? '追加引导' : '发送'}
                  icon={<PaperPlaneTiltIcon weight="fill" className={iconSize.sm} aria-hidden="true" />}
                  disabled={!canSubmit}
                  loading={isSending}
                />
              )}
            </div>
          </div>
        </div>
      </form>

      <Dialog
        open={Boolean(previewAttachment)}
        onClose={() => {
          setPreviewAttachment(null)
          setSelectionMode(false)
          setDrag(null)
          setSelectionDraft(null)
        }}
        title={previewAttachment?.name || '预览参考图'}
        description={
          previewAttachment
            ? `${
                previewAttachment.source === 'library'
                  ? '来自作品图库复用'
                  : previewAttachment.source === 'artifact'
                    ? '来自会话产物复用'
                    : '来自本地上传'
              }${
                previewAttachment.width && previewAttachment.height
                  ? ` · ${previewAttachment.width} × ${previewAttachment.height}`
                  : ''
              }${
                previewAttachment.sizeBytes
                  ? ` · ${formatBytes(previewAttachment.sizeBytes)}`
                  : ''
              }${
                selectionMode ? ' · 拖拽框选要修改的区域' : ''
              }`
            : undefined
        }
        size="wide"
        footer={
          previewAttachment ? (
            <>
              {!selectionMode && previewAttachment.source === 'library' && previewAttachment.assetId ? (
                <Button
                  variant="secondary"
                  disabled={WORKSPACE_MODE !== 'mock' && !editModelId}
                  onClick={() => {
                    setSelectionMode(true)
                    setSelectionDraft(null)
                    setDrag(null)
                    setSelectionError(null)
                  }}
                >
                  框选局部修改
                </Button>
              ) : null}
              {selectionMode && previewAttachment.assetId ? (
                <Button
                  variant="primary"
                  loading={selectionBusy}
                  disabled={!selectionDraft}
                  onClick={() => void prepareSelection(previewAttachment)}
                >
                  准备好蒙版并附到消息
                </Button>
              ) : null}
              {onRemoveAttachment ? (
                <Button
                  variant="danger-ghost"
                  disabled={isSending}
                  onClick={() => {
                    removeAttachment(previewAttachment)
                    setPreviewAttachment(null)
                  }}
                >
                  移除此参考图
                </Button>
              ) : null}
              <Button
                variant="secondary"
                onClick={() => {
                  setPreviewAttachment(null)
                  setSelectionMode(false)
                }}
              >
                关闭
              </Button>
            </>
          ) : undefined
        }
      >
        {previewAttachment ? (
          <div className="flex flex-col gap-2">
            <div className="flex justify-center overflow-hidden">
              <div
                ref={previewBoxRef}
                className={cn('relative inline-block max-w-full', selectionMode && 'cursor-crosshair touch-none select-none')}
                onPointerDown={selectionMode ? handleSelectionStart : undefined}
                onPointerMove={selectionMode ? handleSelectionMove : undefined}
                onPointerUp={selectionMode ? handleSelectionEnd : undefined}
                onPointerCancel={selectionMode ? handleSelectionEnd : undefined}
              >
                <img
                  src={previewAttachment.url}
                  alt={previewAttachment.name}
                  draggable={false}
                  className="max-h-[65dvh] w-auto max-w-full rounded-control object-contain"
                />
                {selectionMode && displaySelection ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute border border-accent bg-accent/25"
                    style={{
                      left: displaySelection.x,
                      top: displaySelection.y,
                      width: displaySelection.width,
                      height: displaySelection.height,
                    }}
                  />
                ) : null}
              </div>
            </div>
            {selectionMode ? (
              <p className="text-caption text-muted-foreground">
                {selectionDraft
                  ? `已选区域 ${Math.round(selectionDraft.width)} × ${Math.round(selectionDraft.height)} 像素`
                  : `在图上拖拽出要重新生成的矩形区域（最小 ${MIN_EDIT_SELECTION_PX}×${MIN_EDIT_SELECTION_PX} 像素）。准备后蒙版由服务端生成并绑定这张源图，有效期与上传一致。`}
              </p>
            ) : null}
            {selectionError ? <Alert tone="danger" className="text-caption">{selectionError}</Alert> : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
