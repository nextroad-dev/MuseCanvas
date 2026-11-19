'use client'

import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentArtifactAnchor, AgentArtifactDTO, AgentArtifactThreadDTO } from '@musecanvas/contracts'
import { Alert, Button } from '@/shared/components/ui'
import type { AgentConsoleController } from '@/shared/hooks/useAgentConsole'
import { queryKeys } from '@/shared/hooks/query-keys'
import { agentApi, libraryApi } from '@/shared/services/client-api'
import { isSafeDisplayUrl } from '../lib/agent-status'
import { artifactAnchorLabel, artifactMessageError, imagePointAnchor, selectedTextAnchor, videoTimeAnchor } from '../lib/artifact-anchors'

export interface ArtifactOpenRequest {
  artifactId?: AgentArtifactDTO['id']
  sourceItemId?: string
  nonce: number
}
interface MessageDraft { body: string; requestId: string }
export interface ArtifactDraft extends MessageDraft {
  anchor: AgentArtifactAnchor
  replies: Record<string, MessageDraft>
}
export type ArtifactDraftCache = Map<string, ArtifactDraft>

const fieldClass = 'w-full rounded-control border border-border bg-surface p-2 text-ui text-foreground disabled:opacity-60'
const newMessage = (): MessageDraft => ({ body: '', requestId: globalThis.crypto.randomUUID() })
const emptyDraft = (): ArtifactDraft => ({ ...newMessage(), anchor: { kind: 'whole' }, replies: {} })
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。'
const unique = <T extends { id: string }>(items: T[]): T[] => [...new Map(items.map((item) => [item.id, item])).values()]

export function ArtifactPane({ console: agentConsole, request, drafts, onJumpToMessage }: {
  console: AgentConsoleController
  request?: ArtifactOpenRequest
  drafts: ArtifactDraftCache
  onJumpToMessage: (sourceItemId: string) => void
}) {
  const { actorId, sessionId, mode, serviceStatus, turnActive } = agentConsole
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<AgentArtifactDTO['id'] | null>(null)
  const [locatingSource, setLocatingSource] = useState<string | null>(null)
  const [sourceMissing, setSourceMissing] = useState(false)
  const enabled = Boolean(actorId && sessionId && serviceStatus !== 'disabled_404')
  const listKey = queryKeys.agent.artifacts(actorId, sessionId ?? '')
  const artifactsQuery = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => mode === 'mock'
      ? Promise.resolve({ items: [] as AgentArtifactDTO[], nextCursor: null })
      : agentApi.listArtifacts(sessionId!, { limit: 30, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
    retry: false,
    refetchInterval: turnActive && mode === 'live' ? 5000 : false,
  })
  const artifacts = unique(artifactsQuery.data?.pages.flatMap((page) => page.items) ?? [])
  const effectiveId = selectedId ?? artifacts[0]?.id ?? null

  // Snapshot resyncs can replace items without delivering their original SSE events.
  const lastItemId = agentConsole.items.at(-1)?.id
  const snapshotUpdatedAt = agentConsole.snapshotQuery.dataUpdatedAt
  useEffect(() => {
    if (enabled && mode === 'live') void queryClient.invalidateQueries({ queryKey: queryKeys.agent.artifacts(actorId, sessionId ?? '') })
  }, [actorId, sessionId, enabled, mode, lastItemId, snapshotUpdatedAt, turnActive, queryClient])

  const firstId = artifacts[0]?.id
  useEffect(() => {
    if (firstId) setSelectedId((current) => current ?? firstId)
  }, [firstId])

  const availability = artifacts.find((artifact) => artifact.id === effectiveId && artifact.kind !== 'text')
  const available = availability && availability.kind !== 'text' ? availability.available : undefined
  useEffect(() => {
    if (effectiveId && mode === 'live') void queryClient.invalidateQueries({ queryKey: queryKeys.agent.artifact(actorId, sessionId ?? '', effectiveId) })
  }, [actorId, sessionId, effectiveId, available, mode, queryClient])

  useEffect(() => {
    if (!request) return
    setSourceMissing(false)
    setLocatingSource(request.sourceItemId ?? null)
    if (request.artifactId) setSelectedId(request.artifactId)
  }, [request])

  useEffect(() => {
    if (!locatingSource || artifactsQuery.isPending || artifactsQuery.isError) return
    const match = artifacts.find((artifact) => artifact.sourceItemId === locatingSource)
    if (match) {
      setSelectedId(match.id)
      setLocatingSource(null)
    } else if (artifactsQuery.isFetching) {
      return
    } else if (artifactsQuery.hasNextPage) {
      void artifactsQuery.fetchNextPage()
    } else {
      setSourceMissing(true)
      setLocatingSource(null)
    }
  }, [locatingSource, artifacts, artifactsQuery])

  if (!sessionId) return <p className="text-caption text-muted-foreground">选择会话后查看 Artifact。</p>
  if (mode === 'mock') return <p className="text-caption text-muted-foreground">本地演示暂无持久化 Artifact，不会访问真实会话或评论接口。</p>
  if (!enabled) return <p className="text-caption text-muted-foreground">Artifact 服务暂不可用。</p>

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ui font-medium">Artifact · {artifacts.length}{artifactsQuery.hasNextPage ? '+' : ''}</h3>
        <Button size="sm" variant="ghost" disabled={artifactsQuery.isFetching} onClick={() => void artifactsQuery.refetch()}>刷新产物</Button>
      </div>
      <p className="text-caption text-muted-foreground">助手正文与生成的图片、视频。评论仅供自己查看，不会发送给 Agent。</p>
      {artifactsQuery.isPending ? <p role="status">正在加载产物…</p> : null}
      {artifactsQuery.isError ? <Alert tone="danger" role="alert">{errorText(artifactsQuery.error)}<Button size="sm" variant="ghost" onClick={() => void artifactsQuery.refetch()}>重试产物</Button></Alert> : null}
      {!artifactsQuery.isPending && !artifactsQuery.isError && artifacts.length === 0 ? <p className="text-caption text-muted-foreground">本会话暂无持久化产物，助手回复与生成结果就绪后会显示在这里。</p> : null}
      {artifacts.length > 0 ? (
        <label className="block space-y-1 text-caption">
          <span>选择 Artifact</span>
          <select className={fieldClass} value={effectiveId ?? ''} onChange={(event) => {
            setSelectedId(event.target.value as AgentArtifactDTO['id'])
            setLocatingSource(null)
            setSourceMissing(false)
          }}>
            {selectedId && !artifacts.some((artifact) => artifact.id === selectedId) ? <option value={selectedId}>从消息打开的 Artifact</option> : null}
            {artifacts.map((artifact, index) => <option key={artifact.id} value={artifact.id}>{index + 1}. {artifact.kind === 'text' ? artifact.content.slice(0, 50).replace(/\s+/g, ' ') : artifact.kind === 'image' ? '生成图片' : '生成视频'}</option>)}
          </select>
        </label>
      ) : null}
      {artifactsQuery.hasNextPage ? <Button size="sm" variant="secondary" loading={artifactsQuery.isFetchingNextPage} onClick={() => void artifactsQuery.fetchNextPage()}>加载更多产物</Button> : null}
      {locatingSource ? <p role="status">正在定位这条消息的产物…</p> : null}
      {sourceMissing ? <p role="status" className="text-caption text-muted-foreground">这条工具记录暂无可展示的图片或视频。</p> : null}
      {effectiveId ? <ArtifactDetail key={effectiveId} actorId={actorId} sessionId={sessionId} artifactId={effectiveId} drafts={drafts} onJumpToMessage={onJumpToMessage} /> : null}
    </div>
  )
}

function ArtifactDetail({ actorId, sessionId, artifactId, drafts, onJumpToMessage }: {
  actorId: string
  sessionId: string
  artifactId: AgentArtifactDTO['id']
  drafts: ArtifactDraftCache
  onJumpToMessage: (sourceItemId: string) => void
}) {
  const query = useQuery({
    queryKey: queryKeys.agent.artifact(actorId, sessionId, artifactId),
    queryFn: () => agentApi.getArtifact(sessionId, artifactId),
    retry: false,
    staleTime: 0,
  })
  if (query.isPending) return <p role="status">正在打开 Artifact…</p>
  if (query.isError) return <Alert tone="danger" role="alert">无法打开产物：{errorText(query.error)}<Button size="sm" variant="ghost" onClick={() => void query.refetch()}>重试打开</Button></Alert>
  if (query.data.sessionId !== sessionId || query.data.id !== artifactId) return <Alert tone="danger">产物不属于当前会话。</Alert>
  return <ArtifactContent artifact={query.data} actorId={actorId} drafts={drafts} onJumpToMessage={onJumpToMessage} />
}

function ArtifactContent({ artifact, actorId, drafts, onJumpToMessage }: {
  artifact: AgentArtifactDTO
  actorId: string
  drafts: ArtifactDraftCache
  onJumpToMessage: (sourceItemId: string) => void
}) {
  const { id, sessionId } = artifact
  const cacheKey = `${actorId}:${sessionId}:${id}`
  const [draft, setDraft] = useState<ArtifactDraft>(() => drafts.get(cacheKey) ?? emptyDraft())
  const draftRef = useRef(draft)
  const textRef = useRef<HTMLParagraphElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const commentRef = useRef<HTMLTextAreaElement>(null)
  const [highlight, setHighlight] = useState<AgentArtifactAnchor | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [mediaFailed, setMediaFailed] = useState(false)
  const [recentThreads, setRecentThreads] = useState<AgentArtifactThreadDTO[]>([])
  const [videoTime, setVideoTime] = useState(0)
  const queryClient = useQueryClient()
  function saveDraft(next: ArtifactDraft) {
    draftRef.current = next
    drafts.set(cacheKey, next)
    setDraft(next)
  }
  const threadsKey = queryKeys.agent.artifactThreads(actorId, sessionId, id)
  const threadsQuery = useInfiniteQuery({
    queryKey: threadsKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => agentApi.listArtifactThreads(sessionId, id, { limit: 30, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  })
  const threads = unique([...(threadsQuery.data?.pages.flatMap((page) => page.items) ?? []), ...recentThreads])
  const assetId = artifact.kind === 'text' ? null : artifact.assetId
  const mediaAvailable = artifact.kind !== 'text' && artifact.available
  const assetQuery = useQuery({
    queryKey: queryKeys.agent.artifactAsset(actorId, sessionId, assetId ?? ''),
    queryFn: () => libraryApi.detail(assetId!),
    enabled: mediaAvailable,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })
  const asset = assetQuery.data?.id === assetId ? assetQuery.data : undefined
  const candidateUrl = artifact.kind === 'image' ? asset?.imageUrl || asset?.url : asset?.url
  const mediaUrl = isSafeDisplayUrl(candidateUrl) ? candidateUrl : null
  const poster = isSafeDisplayUrl(asset?.posterUrl) ? asset?.posterUrl : undefined
  useEffect(() => setMediaFailed(false), [mediaUrl])

  type CommentAction =
    | { kind: 'create'; draft: ArtifactDraft }
    | { kind: 'reply'; threadId: string; draft: MessageDraft }
    | { kind: 'resolve'; threadId: string; resolved: boolean }
  const mutation = useMutation({
    mutationFn: (action: CommentAction) => {
      if (action.kind === 'create') return agentApi.createArtifactThread(sessionId, id, { version: 1, clientRequestId: action.draft.requestId, body: action.draft.body, anchor: action.draft.anchor })
      if (action.kind === 'reply') return agentApi.replyArtifactThread(sessionId, id, action.threadId, { clientRequestId: action.draft.requestId, body: action.draft.body })
      return agentApi.resolveArtifactThread(sessionId, id, action.threadId, { resolved: action.resolved })
    },
    onSuccess: (thread, action) => {
      if (thread.artifactId !== id) return
      setRecentThreads((previous) => unique([...previous, thread]))
      const current = draftRef.current
      if (action.kind === 'create' && current.requestId === action.draft.requestId) saveDraft({ ...current, ...newMessage(), anchor: { kind: 'whole' } })
      if (action.kind === 'reply' && current.replies[action.threadId]?.requestId === action.draft.requestId) saveDraft({ ...current, replies: { ...current.replies, [action.threadId]: newMessage() } })
      void queryClient.invalidateQueries({ queryKey: threadsKey })
    },
  })

  function chooseAnchor(anchor: AgentArtifactAnchor, focus = false) {
    saveDraft({ ...draftRef.current, anchor, requestId: globalThis.crypto.randomUUID() })
    setHighlight(anchor)
    setValidationError(null)
    if (focus) commentRef.current?.focus()
  }
  function captureSelection() {
    if (artifact.kind !== 'text' || !textRef.current) return
    const anchor = selectedTextAnchor(textRef.current, window.getSelection(), artifact.content)
    if (anchor) chooseAnchor(anchor)
  }
  function showAnchor(anchor: AgentArtifactAnchor) {
    setHighlight(anchor)
    if (anchor.kind === 'text' && artifact.kind === 'text' && textRef.current) {
      // Select an exact substring of the one plain-text node; never search for a repeated quote.
      const node = textRef.current.firstChild
      if (node?.nodeType === 3 && artifact.content.slice(anchor.start, anchor.end) === anchor.quote) {
        const range = document.createRange()
        range.setStart(node, anchor.start)
        range.setEnd(node, anchor.end)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        textRef.current.scrollIntoView({ block: 'nearest' })
      }
    }
    if (anchor.kind === 'video' && videoRef.current) {
      videoRef.current.currentTime = anchor.timeMs / 1000
      videoRef.current.scrollIntoView({ block: 'nearest' })
    }
  }
  const imageMarker = highlight?.kind === 'image_point' || highlight?.kind === 'image_rect' ? highlight : null
  const draftError = artifactMessageError(draft.body)

  return (
    <div className="space-y-3 border-t border-border/70 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-ui font-medium">{artifact.kind === 'text' ? '助手正文' : artifact.kind === 'image' ? '生成图片' : '生成视频'} · v1</h4>
        <Button size="sm" variant="ghost" onClick={() => onJumpToMessage(artifact.sourceItemId)}>跳转来源消息</Button>
      </div>
      {artifact.kind === 'text' ? (
        <>
          <p className="text-caption text-muted-foreground">选择正文中的文字以精确评论；也可评论整个 Artifact。</p>
          <p ref={textRef} tabIndex={0} aria-label="Artifact 正文，可选择文字评论" onMouseUp={captureSelection} onTouchEnd={captureSelection} onKeyUp={captureSelection} className="max-h-96 select-text overflow-y-auto whitespace-pre-wrap break-words rounded-control bg-tonal/40 p-3 text-ui leading-relaxed">{artifact.content}</p>
          <Button size="sm" variant="secondary" onClick={captureSelection}>使用选中文字</Button>
        </>
      ) : !artifact.available ? <p role="status" className="text-caption text-muted-foreground">媒体已删除或不可用，仍可查看与回复评论。</p> : assetQuery.isPending ? <p role="status">正在授权并加载媒体…</p> : assetQuery.isError || !mediaUrl || mediaFailed ? (
        <Alert tone="warning">媒体暂不可用。<Button size="sm" variant="ghost" onClick={() => { setMediaFailed(false); void assetQuery.refetch() }}>重新加载媒体</Button></Alert>
      ) : artifact.kind === 'image' ? (
        <>
          <p className="text-caption text-muted-foreground">点击图片标记评论位置。键盘用户可标记中心或评论整个 Artifact。</p>
          <div className="relative">
            <img src={mediaUrl} alt="生成图片，点击选择评论位置" onError={() => setMediaFailed(true)} onClick={(event) => {
              const image = event.currentTarget
              const point = imagePointAnchor(image.getBoundingClientRect(), image.naturalWidth, image.naturalHeight, event.clientX, event.clientY)
              if (point) chooseAnchor(point)
            }} className="block h-auto max-h-96 w-full cursor-crosshair rounded-control object-contain" />
            {/* The SVG uses the actual image aspect ratio and centered contain layout. */}
            {imageMarker ? <ImageAnchorOverlay src={mediaUrl} anchor={imageMarker} /> : null}
          </div>
          <Button size="sm" variant="secondary" onClick={() => chooseAnchor({ kind: 'image_point', x: 0.5, y: 0.5 }, true)}>标记图片中心</Button>
        </>
      ) : (
        <>
          <video ref={videoRef} src={mediaUrl} poster={poster} controls playsInline preload="metadata" aria-label="Artifact 视频播放器" className="max-h-96 w-full rounded-control" onTimeUpdate={(event) => setVideoTime(event.currentTarget.currentTime)} onError={() => setMediaFailed(true)} />
          <Button size="sm" variant="secondary" disabled={artifact.durationMs === null} onClick={() => {
            const anchor = videoTimeAnchor(videoRef.current?.currentTime ?? videoTime, artifact.durationMs)
            if (anchor) chooseAnchor(anchor, true)
          }}>评论当前时间 · {videoTime.toFixed(2)} 秒</Button>
          {artifact.durationMs === null ? <p className="text-caption text-muted-foreground">该视频无时长信息，可评论整个 Artifact。</p> : null}
        </>
      )}
      {highlight ? <p role="status" className="break-words text-caption text-muted-foreground">当前位置：{artifactAnchorLabel(highlight)}</p> : null}
      <form aria-label="新建私密评论" className="space-y-2" onSubmit={(event) => {
        event.preventDefault()
        if (draftError) { setValidationError(draftError); return }
        setValidationError(null)
        mutation.mutate({ kind: 'create', draft })
      }}>
        <p className="break-words text-caption">评论锚点：{artifactAnchorLabel(draft.anchor)}</p>
        <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => chooseAnchor({ kind: 'whole' }, true)}>评论整个 Artifact</Button>
        <label className="block space-y-1 text-caption"><span>私密评论</span><textarea ref={commentRef} rows={3} maxLength={8000} className={fieldClass} value={draft.body} disabled={mutation.isPending} placeholder="仅自己可见，不发送给 Agent" onChange={(event) => saveDraft({ ...draft, body: event.target.value, requestId: globalThis.crypto.randomUUID() })} /></label>
        {validationError ? <p role="alert" className="text-caption text-danger">{validationError}</p> : null}
        <Button type="submit" size="sm" variant="primary" loading={mutation.isPending} disabled={mutation.isPending || !draft.body.trim()}>添加评论</Button>
      </form>
      {mutation.isError ? <Alert tone="danger" role="alert">评论操作失败：{errorText(mutation.error)}。草稿已保留，可重试。</Alert> : null}
      <div className="flex items-center justify-between gap-2"><h4 className="text-ui font-medium">私密讨论 · {threads.length}{threadsQuery.hasNextPage ? '+' : ''}</h4><Button size="sm" variant="ghost" onClick={() => { setRecentThreads([]); void threadsQuery.refetch() }}>刷新讨论</Button></div>
      {threadsQuery.isPending ? <p role="status">正在加载讨论…</p> : null}
      {threadsQuery.isError ? <Alert tone="danger" role="alert">{errorText(threadsQuery.error)}<Button size="sm" variant="ghost" onClick={() => void threadsQuery.refetch()}>重试讨论</Button></Alert> : null}
      {!threadsQuery.isPending && !threadsQuery.isError && threads.length === 0 ? <p className="text-caption text-muted-foreground">暂无评论。选中文字、图片位置或视频时间后开始讨论。</p> : null}
      <ul className="space-y-3" aria-label="Artifact 私密讨论">
        {threads.map((thread) => {
          const reply = draft.replies[thread.id] ?? { body: '', requestId: '' }
          return <li key={thread.id} className="space-y-2 rounded-control border border-border/70 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <button type="button" className="min-w-0 break-words text-left text-caption text-accent underline" onClick={() => showAnchor(thread.anchor)} aria-label={`定位评论：${artifactAnchorLabel(thread.anchor)}`}>{artifactAnchorLabel(thread.anchor)}</button>
              <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => mutation.mutate({ kind: 'resolve', threadId: thread.id, resolved: !thread.resolved })}>{thread.resolved ? '重新打开' : '标为已解决'}</Button>
            </div>
            <p className="text-caption text-muted-foreground">{thread.resolved ? '已解决' : '讨论中'} · {new Date(thread.createdAt).toLocaleString()}</p>
            <ol className="space-y-2" aria-label="讨论消息">{thread.messages.map((message) => <li key={message.id}><p className="select-text whitespace-pre-wrap break-words text-ui">{message.body}</p><time className="text-caption text-muted-foreground" dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></li>)}</ol>
            {thread.messages.length >= 100 ? <p className="text-caption text-muted-foreground">讨论已达 100 条消息上限，可新建评论。</p> : <form aria-label="回复私密讨论" className="space-y-2" onSubmit={(event) => {
              event.preventDefault()
              const error = artifactMessageError(reply.body)
              if (error) { setValidationError(error); return }
              setValidationError(null)
              mutation.mutate({ kind: 'reply', threadId: thread.id, draft: reply })
            }}>
              <label className="block space-y-1 text-caption"><span>回复这条讨论</span><textarea rows={2} maxLength={8000} className={fieldClass} value={reply.body} disabled={mutation.isPending} onChange={(event) => saveDraft({ ...draft, replies: { ...draft.replies, [thread.id]: { body: event.target.value, requestId: globalThis.crypto.randomUUID() } } })} /></label>
              <Button type="submit" size="sm" variant="secondary" disabled={mutation.isPending || !reply.body.trim()}>发送回复</Button>
            </form>}
          </li>
        })}
      </ul>
      {threadsQuery.hasNextPage ? <Button size="sm" variant="secondary" loading={threadsQuery.isFetchingNextPage} onClick={() => void threadsQuery.fetchNextPage()}>加载更多讨论</Button> : null}
    </div>
  )
}

function ImageAnchorOverlay({ src, anchor }: { src: string; anchor: Extract<AgentArtifactAnchor, { kind: 'image_point' | 'image_rect' }> }) {
  // A transparent duplicate establishes the exact contain-fit content bounds even after resize.
  const [ratio, setRatio] = useState(1)
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
    <img src={src} alt="" onLoad={(event) => setRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)} className="invisible absolute h-full w-full object-contain" />
    <svg viewBox={`0 0 ${ratio} 1`} preserveAspectRatio="xMidYMid meet" className="h-full w-full">
      {anchor.kind === 'image_rect' ? <rect x={anchor.x * ratio} y={anchor.y} width={anchor.width * ratio} height={anchor.height} fill="none" stroke="var(--color-warning)" strokeWidth="3" vectorEffect="non-scaling-stroke" /> : <circle cx={anchor.x * ratio} cy={anchor.y} r="0.025" fill="var(--color-warning)" stroke="var(--color-on-media)" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
    </svg>
  </div>
}
