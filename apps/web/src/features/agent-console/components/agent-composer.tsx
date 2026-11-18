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
} from 'react'
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
import { Alert, Button, Dialog, DropdownMenu, iconSize } from '@/shared/components/ui'
import type { AgentConsoleController } from '@/shared/hooks/useAgentConsole'
import { cn } from '@/shared/lib/cn'
import { formatBytes } from '@/shared/lib/format'
import {
  AGENT_MESSAGE_MAX_BYTES,
  isMessageOverLimit,
  utf8ByteLength,
} from '../lib/agent-status'
import {
  MAX_DRAFT_ATTACHMENTS,
  type ReferenceImageAttachment,
} from '../stores/agent-console-store'

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
  'motion-press inline-flex size-9 shrink-0 items-center justify-center rounded-pill border p-0 transition-colors disabled:cursor-not-allowed disabled:opacity-50'

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
  onCreateSession: () => void
  creatingSession?: boolean
}

const COMPOSER_MIN_HEIGHT_PX = 44
const COMPOSER_MAX_HEIGHT_PX = 192
const MAX_UPLOAD_SIZE_BYTES = 15 * 1024 * 1024

function readFileAsDataUrl(file: File): Promise<{ dataUrl: string; width?: number; height?: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`无法读取图片文件：${file.name}`))
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!dataUrl) {
        reject(new Error(`读取图片为空：${file.name}`))
        return
      }
      if (typeof Image === 'undefined') {
        resolve({ dataUrl })
        return
      }
      const img = new Image()
      img.onload = () => resolve({ dataUrl, width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = () => resolve({ dataUrl })
      img.src = dataUrl
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
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [previewAttachment, setPreviewAttachment] = useState<ReferenceImageAttachment | null>(null)
  const [aspectRatio, setAspectRatio] = useState<string>('auto')
  const [stylePreset, setStylePreset] = useState<string>('none')
  const submittingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const byteCount = utf8ByteLength(draftPrompt)
  const overLimit = isMessageOverLimit(draftPrompt, AGENT_MESSAGE_MAX_BYTES)
  const showByteCount = overLimit || byteCount > 24_000
  const trimmed = draftPrompt.trim()
  const hasAttachments = draftAttachments.length > 0
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
    !isSending

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

  async function ingestImageFiles(files: File[]) {
    if (!onAddAttachment || files.length === 0) return
    setSubmitError(null)
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length === 0) {
      setSubmitError('仅支持上传 PNG、JPG、WebP、GIF 或 SVG 格式的图片文件。')
      return
    }
    for (const file of imageFiles) {
      if (file.size > MAX_UPLOAD_SIZE_BYTES) {
        setSubmitError(`图片「${file.name}」超过 15MB 大小限制，已跳过。`)
        continue
      }
      try {
        const { dataUrl, width, height } = await readFileAsDataUrl(file)
        const added = onAddAttachment({
          id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          url: dataUrl,
          name: file.name.replace(/\.[^.]+$/, '') || '本地上传图片',
          mimeType: file.type,
          width,
          height,
          sizeBytes: file.size,
          source: 'upload',
        })
        if (!added) {
          setSubmitError(`单次最多附加 ${MAX_DRAFT_ATTACHMENTS} 张参考图。`)
          break
        }
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : '读取参考图失败，请重试。')
      }
    }
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
      if (item.kind === 'file' && item.type.startsWith('image/')) {
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
    if (files.some((file) => file.type.startsWith('image/'))) {
      event.preventDefault()
      void ingestImageFiles(files)
    }
  }

  async function executeSubmit() {
    if (!canSubmit || submittingRef.current || !sessionId) return
    submittingRef.current = true
    setSubmitError(null)
    const baseText =
      trimmed.length > 0
        ? draftPrompt.trim()
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
    const currentAttachments = [...draftAttachments]
    try {
      if (currentAttachments.length > 0) {
        onRecordMessageAttachments?.(sessionId, effectiveContent, currentAttachments)
      }
      if (turnActive && activeTurn) {
        await steerTurn({ turnId: activeTurn.id, content: effectiveContent })
      } else {
        await sendMessage({ sessionId, content: effectiveContent })
      }
      // 仅在后端/模拟引擎明确受理后才清空草稿与参考图；失败时保留用户输入。
      onChangeDraft('')
      onClearAttachments?.()
    } catch (error) {
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
    if (event.nativeEvent.isComposing) return
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      void executeSubmit()
    }
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
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
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
            <div className="flex items-center justify-center rounded-card border border-dashed border-accent/60 bg-accent-soft/35 py-2 text-ui font-medium text-accent">
              <span>释放鼠标以添加参考图（最多 {MAX_DRAFT_ATTACHMENTS} 张）</span>
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
                  参考图 ({draftAttachments.length}/{MAX_DRAFT_ATTACHMENTS})
                </span>
                {draftAttachments.length > 1 && onClearAttachments ? (
                  <button
                    type="button"
                    aria-label="清空全部参考图"
                    onClick={onClearAttachments}
                    className="rounded-control px-1.5 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger"
                  >
                    清空参考图
                  </button>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {draftAttachments.map((att) => (
                  <div
                    key={att.id}
                    className="group relative flex max-w-56 items-center gap-2 rounded-card border border-border/80 bg-tonal/50 p-1.5 pr-7 transition-colors hover:border-border hover:bg-tonal"
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
                            onClick={() => onChangeDraft(att.prompt!)}
                            className="inline-flex items-center text-accent hover:underline"
                          >
                            <span>用原提示词</span>
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {onRemoveAttachment ? (
                      <button
                        type="button"
                        aria-label={`移除参考图 ${att.name}`}
                        title={`移除参考图 ${att.name}`}
                        onClick={() => onRemoveAttachment(att.id)}
                        className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-pill text-ui leading-none text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger"
                      >
                        <XIcon className={iconSize.xs} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                ))}

                {draftAttachments.length < MAX_DRAFT_ATTACHMENTS && onAddAttachment ? (
                  <button
                    type="button"
                    aria-label="继续添加参考图"
                    title="继续添加参考图"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-card border border-dashed border-border bg-canvas/50 text-caption text-muted-foreground transition-colors hover:border-accent hover:text-accent"
                  >
                    <PlusIcon className={iconSize.sm} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

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
              onChangeDraft(event.target.value)
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
                  title="上传参考图"
                  disabled={
                    isDisabledService || draftAttachments.length >= MAX_DRAFT_ATTACHMENTS
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

              <DropdownMenu
                side="top"
                align="start"
                size="sm"
                triggerMode="hover"
                menuLabel="选择创作画幅比例"
                menuClassName="w-44"
                trigger={
                  <button
                    type="button"
                    aria-label="选择创作画幅比例"
                    title={`创作画幅：${ASPECT_RATIO_OPTIONS.find(([val]) => val === aspectRatio)?.[1] ?? '自适应画幅'}`}
                    disabled={isDisabledService}
                    className={cn(
                      COMPOSER_TOOL_ICON_BUTTON_CLASS,
                      aspectRatio !== 'auto'
                        ? 'border-accent/35 bg-accent-soft text-accent'
                        : 'border-border/70 bg-canvas/70 text-muted-foreground hover:border-border hover:bg-tonal/70 hover:text-foreground',
                    )}
                  >
                    <AspectRatioIcon ratio={aspectRatio} />
                  </button>
                }
                items={ASPECT_RATIO_OPTIONS.map(([val, label]) => ({
                  id: val,
                  label,
                  icon: <AspectRatioIcon ratio={val} />,
                  selected: aspectRatio === val,
                  onSelect: () => setAspectRatio(val),
                }))}
              />

              <DropdownMenu
                side="top"
                align="start"
                size="sm"
                triggerMode="hover"
                menuLabel="选择视觉风格预设"
                menuClassName="w-44"
                trigger={
                  <button
                    type="button"
                    aria-label="选择视觉风格预设"
                    title={`视觉风格：${STYLE_PRESET_OPTIONS.find(([val]) => val === stylePreset)?.[1] ?? '默认风格'}`}
                    disabled={isDisabledService}
                    className={cn(
                      COMPOSER_TOOL_ICON_BUTTON_CLASS,
                      stylePreset !== 'none'
                        ? 'border-accent/35 bg-accent-soft text-accent'
                        : 'border-border/70 bg-canvas/70 text-muted-foreground hover:border-border hover:bg-tonal/70 hover:text-foreground',
                    )}
                  >
                    <StylePresetIcon preset={stylePreset} />
                  </button>
                }
                items={STYLE_PRESET_OPTIONS.map(([val, label]) => ({
                  id: val,
                  label,
                  icon: <StylePresetIcon preset={val} />,
                  selected: stylePreset === val,
                  onSelect: () => setStylePreset(val),
                }))}
              />

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
        onClose={() => setPreviewAttachment(null)}
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
              }`
            : undefined
        }
        size="wide"
        footer={
          previewAttachment ? (
            <>
              {onRemoveAttachment ? (
                <Button
                  variant="danger-ghost"
                  onClick={() => {
                    onRemoveAttachment(previewAttachment.id)
                    setPreviewAttachment(null)
                  }}
                >
                  移除此参考图
                </Button>
              ) : null}
              <Button variant="secondary" onClick={() => setPreviewAttachment(null)}>
                关闭
              </Button>
            </>
          ) : undefined
        }
      >
        {previewAttachment ? (
          <div className="flex justify-center overflow-hidden rounded-card border border-border bg-tonal p-2">
            <img
              src={previewAttachment.url}
              alt={previewAttachment.name}
              className="max-h-[65dvh] w-auto max-w-full rounded-control object-contain"
            />
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
