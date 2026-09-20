'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import { useModelsQuery } from '@/shared/hooks/useModels'
import { useJobsQuery, useCreateJob, useCancelJob, useRetryJob } from '@/shared/hooks/useJobs'
import {
  buildGenerationInputs,
  buildVideoParameters,
  inputPlanViolations,
  resolveImageInputPlan,
} from '@/shared/lib/generation-params'
import { clearReferenceImages, reconcileStagedRoles } from '@/shared/lib/reference-upload'
import { MediaFrame } from '@/shared/components/media-frame'
import { JobStatusBadge } from '@/shared/components/job-status-badge'
import { isJobActive } from '@/shared/lib/job-status'
import { isVideoOutput, modelMediaKind, outputUrl } from '@/shared/types'
import type {
  CreateGenerationRequest,
  GenerateModeTab,
  GenerationJob,
  MediaKind,
} from '@/shared/types'
import { GenerateModeTabs } from './generate-mode-tabs'
import { VideoParameterControls } from './video-parameter-controls'
import { ReferenceImagesTrigger } from './reference-images-trigger'
import { ActiveJobsBoard } from './active-jobs-board'
import {
  ChevronRight,
  Clock,
  Download,
  Film,
  Image,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Sparkles,
  Video,
  XCircle,
} from 'lucide-react'

const SELECT_CLASS =
  'rounded-[var(--radius-control)] border border-border bg-surface-subtle px-2.5 py-1.5 text-xs font-medium text-foreground outline-none hover:bg-surface-subtle-strong'

/** `?tab=` accepts only the two kinds; anything else (typo, stale bookmark) is image. */
function readTabParam(value: string | null): GenerateModeTab {
  return value === 'video' ? 'video' : 'image'
}

/** The DTO has no `modelKind` on a job row, so the kind comes from `mediaKind`
 *  first and from the emitted outputs as a fallback. */
function jobMediaKind(job: GenerationJob): MediaKind {
  if (job.mediaKind === 'video') return 'video'
  if (job.mediaKind === 'image') return 'image'
  return (job.outputs ?? []).some((output) => isVideoOutput(output)) ? 'video' : 'image'
}

export function GenerateConsole() {
  const prompt = useGenerateUiStore((s) => s.prompt)
  const activeTab = useGenerateUiStore((s) => s.activeTab)
  const selectedModelIdByKind = useGenerateUiStore((s) => s.selectedModelIdByKind)
  const count = useGenerateUiStore((s) => s.count)
  const size = useGenerateUiStore((s) => s.size)
  const quality = useGenerateUiStore((s) => s.quality)
  const videoParams = useGenerateUiStore((s) => s.videoParams)
  const selectedJobId = useGenerateUiStore((s) => s.selectedJobId)
  const stagedOrder = useGenerateUiStore((s) =>
    s.stagedImages.map((image) => image.localId).join('|'),
  )
  const setPrompt = useGenerateUiStore((s) => s.setPrompt)
  const setActiveTab = useGenerateUiStore((s) => s.setActiveTab)
  const setSelectedModelId = useGenerateUiStore((s) => s.setSelectedModelId)
  const setCount = useGenerateUiStore((s) => s.setCount)
  const setSize = useGenerateUiStore((s) => s.setSize)
  const setVideoParam = useGenerateUiStore((s) => s.setVideoParam)
  const setSelectedJobId = useGenerateUiStore((s) => s.setSelectedJobId)
  // Derived primitives, so upload progress ticks never re-render this console.
  const isReferenceUploadBusy = useGenerateUiStore((s) =>
    s.stagedImages.some((image) => image.status === 'pending' || image.status === 'uploading' || image.status === 'processing'),
  )

  const router = useRouter()
  const searchParams = useSearchParams()

  const { data: models, isLoading: modelsLoading } = useModelsQuery()
  const {
    data: jobs = [],
    isLoading: jobsLoading,
    isError: jobsError,
    refetch: refetchJobs,
  } = useJobsQuery(30)

  const createJobMutation = useCreateJob()
  const cancelJobMutation = useCancelJob()
  const retryJobMutation = useRetryJob()

  const railOpen = useGenerateUiStore((s) => s.railOpen)
  const activeBoardOpen = useGenerateUiStore((s) => s.activeBoardOpen)
  const historyOpen = useGenerateUiStore((s) => s.historyOpen)
  const setRailOpen = useGenerateUiStore((s) => s.setRailOpen)
  const setActiveBoardOpen = useGenerateUiStore((s) => s.setActiveBoardOpen)
  const setHistoryOpen = useGenerateUiStore((s) => s.setHistoryOpen)

  const [errorMessage, setErrorMessage] = useState('')
  // `null` until the first URL read, then the last tab we pushed. It keeps the
  // mount effect from pushing over the incoming `?tab=` and keeps a re-run
  // (caused by `searchParams` identity) from pushing the same URL again.
  const mirroredTabRef = useRef<GenerateModeTab | null>(null)

  // GET /api/models returns image AND video models: each tab may only drive its
  // own kind, otherwise a video model gets auto-selected into the image flow.
  const imageModels = useMemo(
    () => (models ?? []).filter((model) => modelMediaKind(model) !== 'video'),
    [models],
  )
  const videoModels = useMemo(
    () => (models ?? []).filter((model) => modelMediaKind(model) === 'video'),
    [models],
  )
  const isVideoTab = activeTab === 'video'
  const tabModels = isVideoTab ? videoModels : imageModels
  const videoModelMissing = !modelsLoading && isVideoTab && videoModels.length === 0

  const storedModelId = selectedModelIdByKind[activeTab]
  // Same id and still offered -> keep it; otherwise fall back to the first model
  // of *this* kind. Never across kinds.
  const activeModelId = tabModels.some((model) => model.id === storedModelId)
    ? storedModelId
    : tabModels[0]?.id ?? ''
  const currentModel = tabModels.find((model) => model.id === activeModelId)
  const inputPlan = useMemo(() => resolveImageInputPlan(currentModel), [currentModel])
  // One noun for the staged-image surface: frame slots stop calling them references.
  const inputNoun = inputPlan.slots.some(
    (slot) => slot.role === 'first_frame' || slot.role === 'last_frame',
  )
    ? '输入画面'
    : '参考图'

  useEffect(() => {
    if (mirroredTabRef.current === null) {
      mirroredTabRef.current = activeTab
      const fromUrl = readTabParam(searchParams.get('tab'))
      if (fromUrl !== activeTab) setActiveTab(fromUrl)
      return
    }
    if (mirroredTabRef.current === activeTab) return
    mirroredTabRef.current = activeTab
    router.push(`/generate?tab=${activeTab}`, { scroll: false })
  }, [activeTab, router, searchParams, setActiveTab])

  // Persist the resolved fallback so an admin rename/removal cannot silently
  // jump the selection mid-session. Writing it is what ends the loop: the next
  // run sees `storedModelId === activeModelId` and returns.
  useEffect(() => {
    if (!activeModelId) return
    if (storedModelId === activeModelId) return
    setSelectedModelId(activeTab, activeModelId)
  }, [activeTab, activeModelId, storedModelId, setSelectedModelId])

  // Frame roles are positional, so every staging change (add / remove / reorder /
  // model or tab switch) re-derives them. `stagedOrder` is a joined string and the
  // reconciliation itself is a no-op once the roles match, so this cannot cycle.
  useEffect(() => {
    if (!stagedOrder) return
    void reconcileStagedRoles(currentModel)
  }, [stagedOrder, currentModel])

  // Find currently selected or running job
  const selectedJob = jobs.find((j) => j.id === selectedJobId) || jobs[0] || null
  const selectedJobActive = selectedJob ? isJobActive(selectedJob) : false
  const stageOutputs = selectedJob?.outputs ?? []
  const stageIsVideo = selectedJob ? jobMediaKind(selectedJob) === 'video' : false
  const showVideoEmptyState = videoModelMissing && !stageIsVideo

  const boardProps = {
    jobs,
    isLoading: jobsLoading,
    isError: jobsError,
    onReload: () => void refetchJobs(),
    selectedJobId,
    onSelectJob: setSelectedJobId,
    onCancel: (jobId: string) => cancelJobMutation.mutate(jobId),
    onRetry: (jobId: string) => retryJobMutation.mutate(jobId),
    pendingCancelId: cancelJobMutation.isPending ? (cancelJobMutation.variables ?? null) : null,
    pendingRetryId: retryJobMutation.isPending ? (retryJobMutation.variables ?? null) : null,
  }

  async function handleGenerate(e?: React.FormEvent) {
    if (e) e.preventDefault()
    const video = activeTab === 'video'
    if (!prompt.trim()) {
      setErrorMessage(video ? '请输入视频生成提示词' : '请输入生图提示词')
      return
    }
    if (!activeModelId) {
      setErrorMessage(video ? '请选择视频生成模型' : '请选择生成模型')
      return
    }
    if (video && videoModels.length === 0) {
      setErrorMessage('尚未配置可用的视频模型，请先在模型管理中启用 Seedance 或 Veo 预设')
      return
    }

    // Read the snapshot imperatively so the gate can never be evaluated from a
    // stale render of an upload that finished between render and click.
    const stagedImages = useGenerateUiStore.getState().stagedImages
    if (stagedImages.some((image) => image.status !== 'ready' && image.status !== 'error')) {
      setErrorMessage(`${inputNoun}正在上传，请等待完成后再生成`)
      return
    }
    if (stagedImages.some((image) => image.status === 'error')) {
      setErrorMessage(`存在上传失败的${inputNoun}，请重试或先移除`)
      return
    }
    const inputs = buildGenerationInputs(stagedImages)
    if (stagedImages.length > 0 && inputs.length === 0) {
      setErrorMessage(`没有可用的${inputNoun}，请重新上传`)
      return
    }
    if (video) {
      // A lone 尾帧 (or an overflow past the frame capacity) is not representable
      // in either provider request, so it must never leave the browser.
      const violations = inputPlanViolations(stagedImages, inputPlan)
      if (violations.length > 0) {
        setErrorMessage(violations[0])
        return
      }
    }
    setErrorMessage('')

    try {
      const payload: CreateGenerationRequest = video
        ? {
            modelId: activeModelId,
            prompt: prompt.trim(),
            parameters: buildVideoParameters(currentModel, videoParams),
            ...(inputs.length > 0 ? { inputs } : {}),
          }
        : {
            modelId: activeModelId,
            prompt: prompt.trim(),
            parameters: {
              count,
              size,
              quality,
            },
            ...(inputs.length > 0 ? { inputs } : {}),
          }
      const job = await createJobMutation.mutateAsync(payload)
      setSelectedJobId(job.id)
      // The uploads are now attached to the job; only release local object URLs.
      await clearReferenceImages({ deleteRemote: false })
    } catch (err: any) {
      setErrorMessage(err.message || '创建生成任务失败')
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleGenerate()
    }
  }

  return (
    <div className="flex h-full w-full flex-1 flex-col overflow-hidden">
      <GenerateModeTabs
        tabs={[
          { id: 'image', label: '图像', icon: Image, disabled: !modelsLoading && imageModels.length === 0 },
          { id: 'video', label: '视频', icon: Video, disabled: !modelsLoading && videoModels.length === 0 },
        ]}
        value={activeTab}
        onChange={setActiveTab}
      />

      <div
        role="tabpanel"
        id={`gen-panel-${activeTab}`}
        aria-labelledby={`gen-tab-${activeTab}`}
        className="relative flex min-h-0 w-full flex-1 overflow-hidden"
      >
        {/* Left: Interactive Generation Studio */}
        <div className="flex flex-1 flex-col overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div
            className={`mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 ${
              selectedJob ? '' : 'justify-center'
            }`}
          >
            {/* Prompt & Input Box */}
            <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-sm transition-colors focus-within:border-accent">
              <textarea
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  isVideoTab
                    ? '描述你想生成的视频内容，例如：镜头缓慢推进晨雾中的森林，晨光穿透树叶，电影感运镜...'
                    : '描述你想生成的画面内容，例如：赛博朋克风格未来雨夜街道，霓虹灯倒影，8k高细节...'
                }
                className="w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />

              {/* Controls Bar */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Model Selector */}
                  <select
                    value={activeModelId}
                    onChange={(e) => setSelectedModelId(activeTab, e.target.value)}
                    className={SELECT_CLASS}
                  >
                    {modelsLoading && <option>加载模型中...</option>}
                    {tabModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                    {!modelsLoading && isVideoTab && tabModels.length === 0 && (
                      <option value="">尚未配置视频模型</option>
                    )}
                  </select>

                  {isVideoTab ? (
                    <VideoParameterControls
                      model={currentModel}
                      values={videoParams}
                      onChange={setVideoParam}
                    />
                  ) : (
                    <>
                      {/* Aspect Ratio / Size */}
                      <select
                        value={size}
                        onChange={(e) => setSize(e.target.value)}
                        className={SELECT_CLASS}
                      >
                        <option value="1024x1024">1:1 方形 (1024x1024)</option>
                        <option value="1280x720">16:9 横屏 (1280x720)</option>
                        <option value="720x1280">9:16 竖屏 (720x1280)</option>
                        <option value="1024x768">4:3 横版 (1024x768)</option>
                        <option value="768x1024">3:4 竖版 (768x1024)</option>
                      </select>

                      {/* Image Count */}
                      <div className="flex rounded-[var(--radius-control)] border border-border bg-surface-subtle p-0.5">
                        {[1, 2, 4].map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => setCount(c)}
                            className={`rounded-[calc(var(--radius-control)-2px)] px-2 py-1 text-xs font-medium transition-colors ${
                              count === c
                                ? 'bg-surface text-foreground shadow-xs'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {c} 张
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  {/* Reference Images */}
                  <ReferenceImagesTrigger
                    model={currentModel}
                    plan={inputPlan}
                    disabled={createJobMutation.isPending}
                  />
                </div>

                {/* Generate Button */}
                <div className="flex items-center gap-3">
                  {isReferenceUploadBusy && (
                    <span className="text-xs font-medium text-muted-foreground">{inputNoun}上传中…</span>
                  )}

                  <button
                    type="button"
                    onClick={() => handleGenerate()}
                    disabled={createJobMutation.isPending || selectedJobActive || isReferenceUploadBusy}
                    className="flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] bg-primary px-5 text-sm font-medium text-canvas transition-colors duration-[var(--motion-fast)] hover:bg-primary-hover disabled:opacity-50"
                  >
                    {createJobMutation.isPending || selectedJobActive ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>处理中...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        <span>立即生成</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {errorMessage && (
              <div className="rounded-[var(--radius-control)] border border-danger-soft bg-danger-soft/20 p-3 text-xs text-danger">
                {errorMessage}
              </div>
            )}

            {/* The rail is `hidden md:flex`, so below `md` this is the only way to
                see or cancel a running task. */}
            <div className="md:hidden">
              <ActiveJobsBoard {...boardProps} variant="inline" hideWhenEmpty />
            </div>

            {showVideoEmptyState ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-[var(--radius-card)] border border-border bg-surface-subtle/40 p-6 text-center">
                <Film aria-hidden="true" className="h-8 w-8 text-muted-foreground" />
                <p className="mt-3 text-sm font-semibold text-foreground">尚未配置视频模型</p>
                <p className="mt-1 max-w-md text-xs text-muted-foreground">
                  请由管理员在「模型管理」中启用 Seedance 或 Veo 视频预设，并为对应供应商配置凭据；
                  启用后刷新本页即可开始视频生成。
                </p>
                <p className="mt-2 text-xs text-muted-foreground">当前图像生成不受影响</p>
              </div>
            ) : selectedJob ? (
              /* Main Stage Display Area */
              <div className="flex flex-1 flex-col items-center justify-center rounded-[var(--radius-card)] border border-border bg-surface-subtle/40 p-6">
                <div className="flex w-full flex-col gap-4">
                  {/* Header of selected job */}
                  <div className="flex items-center justify-between border-b border-border/80 pb-3">
                    <div className="flex items-center gap-2">
                      <JobStatusBadge status={selectedJob.status} busy={selectedJobActive} />
                      <span className="text-xs text-muted-foreground">{selectedJob.modelName}</span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {new Date(selectedJob.createdAt).toLocaleTimeString()}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {selectedJobActive && (
                        <button
                          type="button"
                          onClick={() => cancelJobMutation.mutate(selectedJob.id)}
                          disabled={cancelJobMutation.isPending || selectedJob.cancelRequested}
                          className="flex min-h-8 items-center gap-1 rounded-[var(--radius-control)] border border-border px-2.5 py-1 text-xs text-danger hover:bg-danger-soft/20 disabled:text-muted-foreground disabled:hover:bg-transparent"
                        >
                          <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                          {selectedJob.cancelRequested ? '取消中' : '取消任务'}
                        </button>
                      )}

                      {selectedJob.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => retryJobMutation.mutate(selectedJob.id)}
                          disabled={retryJobMutation.isPending}
                          className="flex items-center gap-1 rounded-[var(--radius-control)] border border-border px-2.5 py-1 text-xs text-foreground hover:bg-surface"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          重试
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Job Prompt */}
                  <p className="text-xs text-foreground/80">{selectedJob.prompt}</p>

                  {/* Job Content / Outputs */}
                  {selectedJob.status === 'succeeded' && stageOutputs.length > 0 ? (
                    <div
                      className={`grid gap-4 ${
                        stageOutputs.length === 1
                          ? 'grid-cols-1 max-w-lg mx-auto'
                          : stageOutputs.length === 2
                            ? 'grid-cols-2'
                            : 'grid-cols-2 sm:grid-cols-2 md:grid-cols-4'
                      }`}
                    >
                      {stageOutputs.map((output) => {
                        const src = outputUrl(output)
                        const isVideo = isVideoOutput(output)
                        return (
                          <div
                            key={output.id}
                            className="group relative overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface"
                          >
                            <MediaFrame
                              src={src}
                              kind={isVideo ? 'video' : 'image'}
                              alt={selectedJob.prompt}
                              layout="stage"
                              durationSeconds={isVideo ? output.metadata.durationSeconds : undefined}
                              aspectRatio={output.metadata.aspectRatio}
                              width={output.metadata.width}
                              height={output.metadata.height}
                              hasAudio={isVideo ? output.metadata.hasAudio : undefined}
                              showControls={isVideo}
                            />
                            {/* A <video controls> owns its own control bar, so the
                                hover download overlay is only for still images. */}
                            {!isVideo && (
                              <div className="absolute inset-0 flex items-end justify-end bg-overlay/40 p-2 opacity-0 transition-opacity group-hover:opacity-100">
                                <a
                                  href={src}
                                  target="_blank"
                                  rel="noreferrer"
                                  download
                                  className="rounded-[var(--radius-control)] bg-surface/90 p-1.5 text-foreground shadow-sm hover:bg-surface"
                                  title="下载原图"
                                >
                                  <Download className="h-3.5 w-3.5" />
                                </a>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : selectedJobActive ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <Loader2 className="h-8 w-8 animate-spin text-accent" />
                      <p className="mt-3 text-sm font-medium text-foreground">
                        {stageIsVideo ? 'AI 正在渲染视频...' : 'AI 正在绘制画面...'}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">任务正在后端集群队列调度中</p>
                    </div>
                  ) : selectedJob.status === 'failed' ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center text-danger">
                      <p className="font-semibold text-sm">生成未完成</p>
                      <p className="mt-1 max-w-md text-xs">
                        {selectedJob.errorMessage ?? selectedJob.errorCode ?? '未知生成错误'}
                      </p>
                    </div>
                  ) : (
                    <div className="py-12 text-center text-xs text-muted-foreground">暂无可用生成画面</div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Right: in-progress board stacked above the history list */}
        <aside
          aria-label="任务面板"
          inert={!railOpen}
          className={`border-l border-border bg-surface transition-[width] duration-[var(--motion-slow)] ease-[var(--ease-standard)] ${
            railOpen ? 'w-72 shrink-0' : 'w-0 shrink-0 overflow-hidden border-l-0'
          } hidden md:flex md:flex-col`}
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span className="text-xs font-medium text-foreground">任务面板</span>
            </div>
            <button
              type="button"
              onClick={() => setRailOpen(false)}
              aria-label="收起任务面板"
              className="flex min-h-8 min-w-8 items-center justify-center rounded-[var(--radius-control)] p-1 text-muted-foreground hover:bg-surface-subtle hover:text-foreground"
            >
              <PanelRightClose className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <ActiveJobsBoard {...boardProps} open={activeBoardOpen} onToggle={setActiveBoardOpen} />

          <div className="mt-2 shrink-0 border-t border-border" />
          <h2 id="gen-history-heading" className="shrink-0 px-2 pt-2 text-sm">
            <button
              type="button"
              aria-expanded={historyOpen}
              aria-controls="gen-history-list"
              onClick={() => setHistoryOpen(!historyOpen)}
              className="flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-1.5 text-left text-sm font-medium text-foreground hover:bg-surface-subtle"
            >
              <ChevronRight
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-[var(--motion-fast)] ease-[var(--ease-standard)] ${
                  historyOpen ? 'rotate-90' : ''
                }`}
                aria-hidden="true"
              />
              <span>历史</span>
              {jobs.length > 0 && (
                <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
                  {jobs.length}
                </span>
              )}
            </button>
          </h2>

          <div
            id="gen-history-list"
            aria-labelledby="gen-history-heading"
            className={
              historyOpen ? 'min-h-0 flex-1 space-y-2 overflow-y-auto p-3' : 'hidden'
            }
          >
            {jobsLoading ? (
              <div className="py-12 text-center text-xs text-muted-foreground">
                <Loader2 className="mx-auto h-4 w-4 animate-spin" aria-hidden="true" />
                <span className="sr-only">加载历史记录中…</span>
              </div>
            ) : jobs.length > 0 ? (
              jobs.map((j) => {
                const isSelected = j.id === (selectedJob?.id || '')
                const firstOutput = (j.outputs ?? [])[0]
                return (
                  <button
                    key={j.id}
                    type="button"
                    onClick={() => setSelectedJobId(j.id)}
                    aria-current={isSelected ? 'true' : undefined}
                    className={`flex w-full min-w-0 gap-3 rounded-[var(--radius-control)] border p-2.5 text-left transition-colors duration-[var(--motion-fast)] ${
                      isSelected
                        ? 'border-accent bg-surface-subtle'
                        : 'border-border/60 bg-surface hover:border-border hover:bg-surface-subtle/50'
                    }`}
                  >
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-subtle">
                      {firstOutput ? (
                        <MediaFrame
                          src={outputUrl(firstOutput)}
                          kind={isVideoOutput(firstOutput) ? 'video' : 'image'}
                          alt=""
                          layout="thumb"
                          durationSeconds={
                            isVideoOutput(firstOutput) ? firstOutput.metadata.durationSeconds : undefined
                          }
                          hasAudio={isVideoOutput(firstOutput) ? firstOutput.metadata.hasAudio : undefined}
                        />
                      ) : null}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
                      <p className="truncate text-xs font-medium text-foreground">{j.prompt}</p>
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                          {j.modelName}
                        </span>
                        <JobStatusBadge status={j.status} />
                      </div>
                    </div>
                  </button>
                )
              })
            ) : (
              <div className="py-12 text-center text-xs text-muted-foreground">暂无生成记录</div>
            )}
          </div>
        </aside>

        {/* Floating button to reopen the rail once collapsed */}
        {!railOpen && (
          <button
            type="button"
            onClick={() => setRailOpen(true)}
            aria-label="展开任务面板"
            className="absolute right-4 top-20 hidden md:flex min-h-8 items-center gap-1 rounded-[var(--radius-control)] border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground hover:bg-surface-subtle"
          >
            <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
            任务
          </button>
        )}
      </div>
    </div>
  )
}
