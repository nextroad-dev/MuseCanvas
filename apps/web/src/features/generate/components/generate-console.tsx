'use client'

import {
  useEffect,
  useMemo,
  useRef,
  useState } from 'react'
import { useRouter,
  useSearchParams } from 'next/navigation'
import { ClockIcon, PlusIcon } from '@phosphor-icons/react'
import { isCanvasUuid } from '@musecanvas/contracts'
import type { CanvasAgentPendingJobDto } from '@musecanvas/contracts'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import type { EditTarget } from '@/shared/stores/generate-ui-store'
import { useModelsQuery } from '@/shared/hooks/useModels'
import { useJobsQuery,
  useCancelJob,
  useRetryJob } from '@/shared/hooks/useJobs'
import {
  buildGenerationInputs,
  inputPlanViolations,
  resolveImageInputPlan,
  } from '@/shared/lib/generation-params'
import {
  buildMediaParameters,
  reconcileModelParameters,
  } from '@/shared/lib/media-parameters'
import { clearReferenceImages,
  reconcileStagedRoles } from '@/shared/lib/reference-upload'
import { GENERATE_ROUTE } from '@/shared/lib/app-routes'
import { Alert, Button, Dialog, PageHeader } from '@/shared/components/ui'
import { ContentFrame } from '@/shared/components/content-frame'
import { isJobActive } from '@/shared/lib/job-status'
import { isVideoOutput, modelMediaKind, outputUrl } from '@/shared/types'
import type { GenerateModeTab, GenerationJob } from '@/shared/types'
import { GenerationTaskPanel } from './generation-task-panel'
import { ConversationSidebar } from './conversation-sidebar'
import { ConversationTimeline } from './conversation-timeline'
import { PendingGenerationCard } from './pending-generation-card'
import { GenerationResultCard } from './generation-result-card'
import { ResultDialog } from './result-dialog'
import type { ResultEditSourceDraft, ResultSubject } from './result-dialog'
import { AgentComposer } from './agent-composer'
import { createComposerDraft,
  composerDraftFromJobConfig } from '../lib/agent-composer'
import type { ComposerDraft } from '../lib/agent-composer'
import { shouldContinuePlanning } from '../lib/agent-continuation'
import { Switch } from '@/shared/components/ui/switch'
import { flattenCanvasPages, useCanvasesQuery, useCanvasDetailQuery, useCreateCanvasMutation } from '@/shared/hooks/useCanvases'
import { useCanvasAgent } from '@/shared/hooks/useCanvasAgent'
import { buildJobConfigReuse } from '../lib/job-config-reuse'

/** `?tab=` accepts only the two kinds; anything else (typo, stale bookmark) is image. */
function readTabParam(value: string | null): GenerateModeTab {
  return value === 'video' ? 'video' : 'image'
}

/** A succeeded generation job as a result-dialog subject, with every output kept
 *  reachable through the dialog's own switcher. */
function jobResultSubject(job: GenerationJob): ResultSubject | null {
  if (job.outputs.length === 0) return null
  const variants = job.outputs.map((output) => {
    const metadata = output.metadata
    return {
      id: output.id,
      assetId: output.assetId ?? null,
      url: outputUrl(output),
      ...(output.downloadUrl ? { downloadUrl: output.downloadUrl } : {}),
      video: isVideoOutput(output),
      ...(typeof metadata.width === 'number' ? { width: metadata.width } : {}),
      ...(typeof metadata.height === 'number' ? { height: metadata.height } : {}),
    }
  })
  const first = job.outputs[0]!
  const aspectRatio = first.metadata.aspectRatio
  return {
    id: `job:${job.id}`,
    alt: job.prompt,
    ...(typeof aspectRatio === 'string' ? { aspectRatio } : {}),
    variants,
    prompt: job.inputPrompt ?? job.prompt,
    modelName: job.modelName,
    size: job.size,
    createdAt: job.createdAt,
  }
}

/** A library asset waiting for a region selection, as its region-edit entry. */
function editTargetResultSubject(target: EditTarget): ResultSubject {
  return {
    id: `asset:${target.assetId}`,
    alt: '局部修改源图',
    variants: [{
      id: target.assetId,
      assetId: target.assetId,
      url: target.url,
      video: false,
      ...(typeof target.width === 'number' ? { width: target.width } : {}),
      ...(typeof target.height === 'number' ? { height: target.height } : {}),
    }],
  }
}

export function GenerateConsole() {
  const activeTab = useGenerateUiStore((s) => s.activeTab)
  const selectedModelIdByKind = useGenerateUiStore((s) => s.selectedModelIdByKind)
  const paramsByKind = useGenerateUiStore((s) => s.paramsByKind)
  const selectedJobId = useGenerateUiStore((s) => s.selectedJobId)
  // A library asset handed over for region editing. It only ever opens the result
  // dialog, whose selection is written into the composer draft — never submitted.
  const editTarget = useGenerateUiStore((s) => s.editTarget)
  const stagedOrder = useGenerateUiStore((s) =>
    s.stagedImages.map((image) => image.localId).join('|'),
  )
  const setActiveTab = useGenerateUiStore((s) => s.setActiveTab)
  const setSelectedModelId = useGenerateUiStore((s) => s.setSelectedModelId)
  const setParam = useGenerateUiStore((s) => s.setParam)
  const replaceParams = useGenerateUiStore((s) => s.replaceParams)
  const setSelectedJobId = useGenerateUiStore((s) => s.setSelectedJobId)
  const setEditTarget = useGenerateUiStore((s) => s.setEditTarget)
  const isPreparingReferences = useGenerateUiStore((s) => s.isPreparingReferences)
  const isReferenceUploadBusy = useGenerateUiStore((s) =>
    s.stagedImages.some((image) => image.status === 'pending' || image.status === 'uploading' || image.status === 'processing'),
  )
  const hasReferenceUploadError = useGenerateUiStore((s) =>
    s.stagedImages.some((image) => image.status === 'error'),
  )

  const router = useRouter()
  const searchParams = useSearchParams()

  const {
    data: models,
    isLoading: modelsLoading,
    isError: modelsQueryFailed,
    error: modelsQueryError,
    refetch: refetchModels,
  } = useModelsQuery()
  const {
    data: jobs = [],
    isLoading: jobsLoading,
    isError: jobsError,
    refetch: refetchJobs,
  } = useJobsQuery(30)

  const cancelJobMutation = useCancelJob()
  const retryJobMutation = useRetryJob()

  // ----- Canvas Agent conversation: the only creation path on this page -----
  const canvasesQuery = useCanvasesQuery()
  const [agentCanvasId, setAgentCanvasId] = useState<string | null>(() => {
    const raw = searchParams.get('canvas')
    return raw && isCanvasUuid(raw) ? raw.toLowerCase() : null
  })
  const canvasDetail = useCanvasDetailQuery(agentCanvasId)
  const createCanvas = useCreateCanvasMutation()
  const agent = useCanvasAgent(agentCanvasId)
  const [agentDraft, setAgentDraft] = useState<ComposerDraft>(() => createComposerDraft())
  const [agentNotice, setAgentNotice] = useState('')
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false)
  const [resultJobId, setResultJobId] = useState<string | null>(null)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [reuseJob, setReuseJob] = useState<GenerationJob | null>(null)
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  // Opt-in continuation: default OFF. Only an explicit click or this toggle sends a
  // job_event; nothing continues a finished job on its own.
  const [continueOnResult, setContinueOnResult] = useState(false)
  const continuedJobIdsRef = useRef<Set<string>>(new Set())
  const agentSendGuardRef = useRef(false)
  const consumedCanvasParamRef = useRef<string | null>(searchParams.get('canvas'))

  useEffect(() => {
    const raw = searchParams.get('canvas')
    if (raw === consumedCanvasParamRef.current || raw === null) return
    consumedCanvasParamRef.current = raw
    if (isCanvasUuid(raw)) setAgentCanvasId(raw.toLowerCase())
  }, [searchParams])

  const agentCanvasRevision = canvasDetail.data?.revision ?? 1
  const agentItems = agent.timeline.items
  const submittedAgentJobIds = useMemo(() => {
    const ids: string[] = []
    for (const item of agentItems) if (item.kind === 'pending' && item.pending.jobId) ids.push(item.pending.jobId)
    return Array.from(new Set(ids))
  }, [agentItems])

  // Actor switch (login/logout): drop the previous actor's composer draft and result
  // dialog so the next actor never sees them. The hook clears timeline/cache itself.
  const agentActorId = agent.actorId
  useEffect(() => {
    setAgentDraft(createComposerDraft())
    setResultJobId(null)
    continuedJobIdsRef.current = new Set()
  }, [agentActorId])

  // Opt-in continuation: only a succeeded result, once per job, and never while a
  // turn is streaming. There is no default and no timer.
  useEffect(() => {
    if (!continueOnResult || agent.streaming || !agent.availability.canGenerate) return
    for (const jobId of submittedAgentJobIds) {
      const job = jobs.find((entry) => entry.id === jobId)
      if (!job) continue
      if (!shouldContinuePlanning({
        optIn: true,
        explicitClick: false,
        jobStatus: job.status,
        alreadyContinued: continuedJobIdsRef.current.has(jobId),
        streaming: agent.streaming,
        agentCanGenerate: agent.availability.canGenerate,
      })) continue
      continuedJobIdsRef.current.add(jobId)
      agent.continuePlanning(jobId, agentCanvasRevision)
      break
    }
  }, [continueOnResult, jobs, submittedAgentJobIds, agent.streaming, agent.availability.canGenerate, agent.continuePlanning, agentCanvasRevision])

  /** A conversation is created only here — on an explicit user action (new
   *  conversation or first message) — never on mount/SSR/preload. */
  async function startAgentConversation(): Promise<string | null> {
    try {
      const created = await createCanvas.mutateAsync({})
      setAgentCanvasId(created.id)
      consumedCanvasParamRef.current = created.id
      router.replace(`${GENERATE_ROUTE}?canvas=${created.id}`, { scroll: false })
      return created.id
    } catch (error) {
      setAgentNotice(error instanceof Error ? error.message : '创建对话失败')
      return null
    }
  }

  async function handleNewConversation() {
    if (createCanvas.isPending) return
    setAgentNotice('')
    const created = await startAgentConversation()
    if (created) setAgentDrawerOpen(false)
  }

  function handleSelectConversation(id: string) {
    setAgentCanvasId(id)
    consumedCanvasParamRef.current = id
    setAgentDrawerOpen(false)
    router.replace(`${GENERATE_ROUTE}?canvas=${id}`, { scroll: false })
  }

  async function handleAgentSend(event?: React.FormEvent) {
    event?.preventDefault()
    // Synchronous guard: without ?canvas= the first message must create the
    // conversation, and two activations in one tick would otherwise create two
    // conversations before the sender's own lock is claimed.
    if (agentSendGuardRef.current) return
    const text = agentDraft.text.trim()
    if (!text || agent.streaming) return
    agentSendGuardRef.current = true
    try {
      setAgentNotice('')
      let targetId = agentCanvasId
      let revision = agentCanvasRevision
      if (!targetId) {
        targetId = await startAgentConversation()
        if (!targetId) return
        revision = 1
      }
      // The request carries the composer's *visible* explicit choices: the resolved
      // model for the current mode, the descriptor-built parameters and the
      // role-positioned inputs. Nothing the user selected is dropped or replaced by
      // an implicit default; the Agent may only refuse, not silently override.
      const staged = useGenerateUiStore.getState().stagedImages
      const structuredInputs = buildGenerationInputs(staged).map((item) => ({
        ...(item.uploadId ? { uploadId: item.uploadId } : {}),
        ...(item.assetId ? { assetId: item.assetId } : {}),
        role: item.role,
        position: item.position,
      }))
      const draft: ComposerDraft = {
        ...agentDraft,
        modelId: activeModelId || agentDraft.modelId,
        inputs: structuredInputs,
        parameters: buildMediaParameters(currentModel, params),
      }
      // The hook claims the submit lock synchronously; a duplicate activation in the
      // same tick is rejected before React re-renders, so the draft is cleared only
      // when the send actually started.
      if (agent.send(draft, revision, targetId)) {
        setAgentDraft((previous) => ({ ...previous, text: '', intent: 'generate', editSource: null, inputs: [] }))
      }
    } finally {
      agentSendGuardRef.current = false
    }
  }

  function handleConfirmPending(pending: CanvasAgentPendingJobDto) {
    agent.confirmPending(pending.id, true)
  }

  function handleRejectPending(pending: CanvasAgentPendingJobDto) {
    agent.confirmPending(pending.id, false)
  }

  /** A stale proposal is refreshed by authoring a new request, never by retrying
   *  or patching the recorded pending. */
  function handleRequestNewProposal(pending: CanvasAgentPendingJobDto) {
    setAgentDraft((previous) => ({
      ...previous,
      text: pending.prompt,
      intent: pending.sourceAssetId || pending.editMetadata ? 'edit' : 'generate',
      editSource: pending.editMetadata
        ? {
            ...(pending.sourceAssetId ? { assetId: pending.sourceAssetId } : {}),
            ...(pending.sourceNodeId ? { nodeId: pending.sourceNodeId } : {}),
            selection: pending.editMetadata.selection,
          }
        : previous.editSource,
    }))
  }

  function handleContinuePlanning(job: GenerationJob) {
    if (!agent.continuePlanning(job.id, agentCanvasRevision)) {
      setAgentNotice('无法继续规划：Agent 正忙或尚未就绪。')
    }
  }

  // GET /api/models returns image AND video models: each mode may only drive its
  // own kind, otherwise a video model gets auto-selected into the image composer.
  const imageModels = useMemo(
    () => (models ?? []).filter((model) => modelMediaKind(model) !== 'video'),
    [models],
  )
  const videoModels = useMemo(
    () => (models ?? []).filter((model) => modelMediaKind(model) === 'video'),
    [models],
  )
  const isVideoTab = activeTab === 'video'
  // Deprecated models sort last. The first entry is what a fresh session falls
  // back to, so a vendor-retired model must never occupy the recommended slot;
  // within each group the admin's own `sort_order` still decides, because this
  // is a presentation rule and not a re-ranking of the catalogue.
  const tabModels = useMemo(() => {
    const list = isVideoTab ? videoModels : imageModels
    return [...list].sort((left, right) => Number(left.deprecated === true) - Number(right.deprecated === true))
  }, [isVideoTab, videoModels, imageModels])

  const storedModelId = selectedModelIdByKind[activeTab]
  // Same id and still offered -> keep it; otherwise fall back to the first model
  // of *this* kind. Never across kinds.
  const activeModelId = tabModels.some((model) => model.id === storedModelId)
    ? storedModelId
    : tabModels[0]?.id ?? ''
  const currentModel = tabModels.find((model) => model.id === activeModelId)
  const params = paramsByKind[activeTab]
  const inputPlan = useMemo(() => resolveImageInputPlan(currentModel), [currentModel])
  // One noun for the staged-image surface: frame slots stop calling them references.
  const inputNoun = inputPlan.slots.some((slot) => slot.role === 'first_frame' || slot.role === 'last_frame')
    ? '输入画面'
    : '参考图'
  // A staged set that the current model cannot accept blocks the send instead of
  // being silently trimmed to the ready subset.
  const referencePlanBlocker = useGenerateUiStore((s) =>
    s.stagedImages.length > 0 ? inputPlanViolations(s.stagedImages, inputPlan)[0] ?? null : null,
  )

  // `?tab=` is a one-shot deep link into the composer's *mode*, not a record of it
  // and never a submit: the header owns switching and writes the store directly.
  // A `tab`-less URL never lands here; once consumed the param is dropped so a
  // bookmark cannot resurrect a mode the user has since changed.
  const consumedTabParamRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const raw = searchParams.get('tab')
    if (raw === null) return
    if (consumedTabParamRef.current === raw) return
    consumedTabParamRef.current = raw
    setActiveTab(readTabParam(raw))
    // Drop only the consumed one-shot; any other param (e.g. ?canvas=) survives so a
    // mode deep link never discards the conversation it points at.
    const rest = new URLSearchParams(searchParams.toString())
    rest.delete('tab')
    const serialized = rest.toString()
    router.replace(serialized ? `${GENERATE_ROUTE}?${serialized}` : GENERATE_ROUTE, { scroll: false })
  }, [router, searchParams, setActiveTab])

  // Persist the resolved fallback so an admin rename/removal cannot silently
  // jump the selection mid-session. Writing it is what ends the loop: the next
  // run sees `storedModelId === activeModelId` and returns.
  useEffect(() => {
    if (!activeModelId) return
    if (storedModelId === activeModelId) return
    setSelectedModelId(activeTab, activeModelId)
  }, [activeTab, activeModelId, storedModelId, setSelectedModelId])

  // Reconcile the parameter picks whenever the selected model changes, so the
  // controls on screen and the Agent context built from them agree.
  useEffect(() => {
    if (!currentModel) return
    const previous = paramsByKind[activeTab]
    const reconciled = reconcileModelParameters(currentModel, previous)
    const entries = Object.entries(reconciled)
    const unchanged = entries.length === Object.keys(previous).length
      && entries.every(([key, value]) => previous[key] === value)
    if (unchanged) return
    replaceParams(activeTab, reconciled)
  }, [currentModel, activeTab, paramsByKind, replaceParams])

  // Frame roles are positional, so every staging change (add / remove / reorder /
  // model or mode switch) re-derives them. `stagedOrder` is a joined string and the
  // reconciliation itself is a no-op once the roles match, so this cannot cycle.
  useEffect(() => {
    if (!stagedOrder) return
    void reconcileStagedRoles(currentModel)
  }, [stagedOrder, currentModel])

  function taskAction(kind: 'cancel' | 'retry', jobId: string) {
    const mutation = kind === 'cancel' ? cancelJobMutation : retryJobMutation
    if (mutation.isPending) return
    setActionErrors((current) => { const next = { ...current }; delete next[jobId]; return next })
    mutation.mutate(jobId, {
      onError: (error) => setActionErrors((current) => ({ ...current, [jobId]: `${kind === 'cancel' ? '取消' : '重试'}失败：${error.message}` })),
    })
  }

  /** Existing tasks are a list, not a fake Agent history: selecting one only opens
   *  its result dialog; it never re-submits anything. */
  function selectJob(jobId: string) {
    setSelectedJobId(jobId)
    const job = jobs.find((entry) => entry.id === jobId)
    if (job?.outputs[0]) setResultJobId(jobId)
  }

  const boardProps = {
    jobs,
    isLoading: jobsLoading,
    isError: jobsError,
    onReload: () => void refetchJobs(),
    selectedJobId: selectedJobId ?? null,
    onSelectJob: selectJob,
    onCancel: (jobId: string) => taskAction('cancel', jobId),
    onRetry: (jobId: string) => taskAction('retry', jobId),
    pendingCancelId: cancelJobMutation.isPending ? (cancelJobMutation.variables ?? null) : null,
    pendingRetryId: retryJobMutation.isPending ? (retryJobMutation.variables ?? null) : null,
  }
  const activeJobCount = jobs.filter(isJobActive).length

  const reuseConfig = useMemo(() => reuseJob ? buildJobConfigReuse(reuseJob, models ?? []) : null, [reuseJob, models])
  const reuseBlocked = isPreparingReferences || isReferenceUploadBusy

  /** Job-config reuse seeds the Agent *draft* (text + explicit model + parameters).
   *  It never creates a job; the Agent proposal/confirmation path still owns the
   *  execution. References are deliberately not restored, so staged inputs are
   *  cleared and the notices say so. */
  function confirmReuse() {
    if (!reuseConfig) return
    const cleanup = clearReferenceImages()
    setAgentDraft((previous) => composerDraftFromJobConfig(reuseConfig, previous))
    if (reuseConfig.model) {
      setActiveTab(reuseConfig.tab)
      setSelectedModelId(reuseConfig.tab, reuseConfig.model.id)
      replaceParams(reuseConfig.tab, reuseConfig.parameters)
    }
    setAgentNotice(reuseConfig.notices.join(' '))
    setReuseJob(null)
    void cleanup.catch((error: unknown) => setAgentNotice(`草稿已载入，但旧输入清理失败：${error instanceof Error ? error.message : '请稍后重试'}`))
  }

  const modelStatus = modelsLoading ? '正在加载模型列表…'
    : modelsQueryFailed ? models ? '模型列表刷新失败，仍可使用已加载模型。' : `模型列表加载失败：${modelsQueryError instanceof Error ? modelsQueryError.message : '请重试'}`
      : !currentModel ? `尚未配置可用的${isVideoTab ? '视频' : '图像'}模型。` : null

  // The composer reports why a new turn cannot start: a failed status read is a
  // different state from "not configured", so it gets its own honest wording. An
  // input that is still uploading or that this model cannot accept also blocks the
  // send, so a visible selection is never silently dropped from the request.
  const composerBlockedReason = agent.status.isError
    ? '无法获取 Agent 状态，暂不能发起新生成；历史、图库与下载仍可使用。'
    : agent.availability.notice
      ? agent.availability.notice
      : isPreparingReferences
        ? `正在校验${inputNoun}，请完成后再发送`
        : isReferenceUploadBusy
          ? `${inputNoun}正在上传，请等待完成后再发送`
          : hasReferenceUploadError
            ? `存在上传失败的${inputNoun}，请重试或删除`
            : referencePlanBlocker

  // One subject at a time: a generation result, or a library asset handed over for
  // region editing. Both are read-only previews plus a selection that only drafts.
  const resultSubject = useMemo<ResultSubject | null>(() => {
    if (resultJobId) {
      const job = jobs.find((entry) => entry.id === resultJobId)
      return job ? jobResultSubject(job) : null
    }
    if (editTarget) return editTargetResultSubject(editTarget)
    return null
  }, [resultJobId, editTarget, jobs])

  function closeResult() {
    setResultJobId(null)
    if (editTarget) setEditTarget(null)
  }

  return (
    <ContentFrame role="region" aria-label="创作台" className="motion-page-enter flex min-h-0 flex-1 flex-col gap-6 py-6 md:py-8">
      <PageHeader
        title="创作工作台"
        description="与 Agent 对话规划创作，确认后执行；既有任务可查看与复用。"
        className="shrink-0"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTasksOpen(true)}
              icon={<ClockIcon weight="bold" aria-hidden="true" />}
            >
              既有任务{activeJobCount > 0 ? ` · ${activeJobCount} 运行中` : ''}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={createCanvas.isPending}
              onClick={() => void handleNewConversation()}
              icon={<PlusIcon weight="bold" aria-hidden="true" />}
            >
              新建对话
            </Button>
          </>
        }
      />
      <section aria-label="Agent 创作对话" className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row lg:gap-0">
        <ConversationSidebar
          items={flattenCanvasPages(canvasesQuery.data?.pages)}
          currentCanvasId={agentCanvasId}
          loading={canvasesQuery.isLoading}
          error={canvasesQuery.error}
          hasMore={Boolean(canvasesQuery.hasNextPage)}
          onLoadMore={() => void canvasesQuery.fetchNextPage()}
          onSelect={handleSelectConversation}
          onCreate={() => void handleNewConversation()}
          creating={createCanvas.isPending}
          open={agentDrawerOpen}
          onClose={() => setAgentDrawerOpen(false)}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 lg:pl-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="text-module text-foreground">Agent 创作</h2>
            <Button variant="secondary" size="sm" className="lg:hidden" onClick={() => setAgentDrawerOpen(true)}>对话列表</Button>
            {agentCanvasId
              ? <span className="min-w-0 truncate text-xs text-muted-foreground">{canvasDetail.data?.title ?? '未命名画布'}</span>
              : <span className="text-xs text-muted-foreground">首次发送消息时会创建对话</span>}
          </div>
          {agent.status.isError ? (
            <Alert tone="warning" title="无法获取 Agent 状态">历史、图库与下载仍可使用；请稍后重试。</Alert>
          ) : agent.availability.notice ? (
            <Alert tone="info" title="Agent 不可用">{agent.availability.notice}</Alert>
          ) : null}
          <ConversationTimeline
            items={agentItems}
            streaming={agent.streaming}
            disconnected={agent.disconnected}
            streamError={agent.streamError}
            className="min-h-[40vh]"
            renderPending={(item) => (
              <PendingGenerationCard
                pending={item.pending}
                now={Date.now()}
                confirmation={agent.confirmations[item.pending.id]}
                onConfirm={handleConfirmPending}
                onReject={handleRejectPending}
                onRequestNewProposal={handleRequestNewProposal}
              />
            )}
          />
          {agent.applyFeedback ? (
            <Alert tone={agent.applyFeedback.applied ? 'success' : 'warning'} role="status">{agent.applyFeedback.message}</Alert>
          ) : null}
          {submittedAgentJobIds.length > 0 ? (
            <div className="flex flex-col gap-3">
              {submittedAgentJobIds.map((jobId) => (
                <GenerationResultCard
                  key={jobId}
                  jobId={jobId}
                  streaming={agent.streaming}
                  onOpenResult={(job) => setResultJobId(job.id)}
                  onContinuePlanning={handleContinuePlanning}
                  onStopAgentTurn={agent.stop}
                  canContinue={agent.availability.canGenerate}
                />
              ))}
            </div>
          ) : null}
          <label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={continueOnResult} onCheckedChange={setContinueOnResult} aria-label="结果完成后继续规划（再次调用语言模型）" />
            结果完成后继续规划（再次调用语言模型）
          </label>
          {agentNotice ? <Alert tone="warning">{agentNotice}</Alert> : null}
          <AgentComposer
            draft={agentDraft}
            onDraftChange={setAgentDraft}
            models={tabModels}
            modelId={activeModelId}
            parameterModel={currentModel}
            values={params}
            onModelChange={(id) => setSelectedModelId(activeTab, id)}
            onParameterChange={(name, value) => setParam(activeTab, name, value)}
            countUnit={activeTab === 'video' ? ' 条' : ' 张'}
            modelsLoading={modelsLoading}
            modelStatus={modelStatus}
            modelsFailed={modelsQueryFailed}
            onReloadModels={() => void refetchModels()}
            inputModel={currentModel}
            inputPlan={inputPlan}
            inputsDisabled={false}
            canGenerate={agent.availability.canGenerate}
            sending={agent.streaming}
            blockedReason={composerBlockedReason}
            onSubmit={() => void handleAgentSend()}
            onStop={agent.stop}
            onRemoveEditSource={() => setAgentDraft((previous) => ({ ...previous, editSource: null, intent: 'generate' }))}
          />
        </div>
      </section>

      {/* 既有任务: the unique list of persisted jobs. Old rows are never dressed up as
          Agent history; they can be viewed or reused into the draft, never re-run. */}
      <GenerationTaskPanel
        {...boardProps}
        open={tasksOpen}
        onClose={() => setTasksOpen(false)}
        busy={false}
        actionErrors={actionErrors}
        onReuseJob={(job) => setReuseJob(job)}
      />

      <Dialog
        open={Boolean(reuseConfig)}
        onClose={() => setReuseJob(null)}
        title="使用这次配置"
        size="wide"
        description="把这笔历史任务的提示词、模型与参数写入 Agent 草稿，并清理暂存输入。不会直接生成，仍需由 Agent 提案并确认。"
        footer={<><Button variant="secondary" onClick={() => setReuseJob(null)}>保留当前草稿</Button><Button variant="primary" disabled={reuseBlocked} onClick={confirmReuse}>{reuseConfig?.model ? '载入到草稿' : '仅使用提示词'}</Button></>}
      >
        {reuseConfig && <div className="flex flex-col gap-3">
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">{reuseConfig.prompt}</p>
          <p className="text-xs text-muted-foreground">{reuseConfig.model ? `模型：${reuseConfig.model.displayName}` : '历史模型不可用：仅替换文字，不更改当前模式、模型或参数。请自行选择模型。'}</p>
          {reuseConfig.notices.map((notice) => <Alert key={notice} tone="warning">{notice}</Alert>)}
          {reuseBlocked && <p role="status" className="text-xs text-muted-foreground">输入图片上传或校验中，请等待完成。</p>}
        </div>}
      </Dialog>

      <ResultDialog
        open={resultSubject !== null}
        onClose={closeResult}
        subject={resultSubject}
        onUseEditSource={(draft: ResultEditSourceDraft) => {
          setAgentDraft((previous) => ({
            ...previous,
            intent: 'edit',
            editSource: { assetId: draft.assetId, selection: draft.selection },
          }))
          closeResult()
        }}
      />
    </ContentFrame>
  )
}
