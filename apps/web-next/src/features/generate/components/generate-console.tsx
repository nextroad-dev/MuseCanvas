'use client'

import { useState } from 'react'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import { useModelsQuery } from '@/shared/hooks/useModels'
import { useJobsQuery, useCreateJob, useCancelJob, useRetryJob } from '@/shared/hooks/useJobs'
import { useAccountCredits } from '@/shared/hooks/useAccount'
import type { GenerationJob } from '@/shared/types'
import {
  Brush,
  Clock,
  Coins,
  Download,
  Loader2,
  Maximize2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react'

export function GenerateConsole() {
  const {
    prompt,
    selectedModelId,
    count,
    size,
    quality,
    selectedJobId,
    setPrompt,
    setSelectedModelId,
    setCount,
    setSize,
    setSelectedJobId,
  } = useGenerateUiStore()

  const { data: models = [], isLoading: modelsLoading } = useModelsQuery()
  const { data: jobs = [], isLoading: jobsLoading } = useJobsQuery(30)
  const { data: credits } = useAccountCredits()

  const createJobMutation = useCreateJob()
  const cancelJobMutation = useCancelJob()
  const retryJobMutation = useRetryJob()

  const [historyOpen, setHistoryOpen] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')

  // Set default model if none selected
  const activeModelId = selectedModelId || (models.length > 0 ? models[0].id : '')
  const currentModel = models.find((m) => m.id === activeModelId)

  // Find currently selected or running job
  const selectedJob = jobs.find((j) => j.id === selectedJobId) || jobs[0] || null
  const isJobActive = selectedJob && ['queued', 'running', 'retry_wait'].includes(selectedJob.status)

  // Calculate estimated credit cost
  const creditPerImage = currentModel?.creditsPerImage ?? 1
  const totalCreditCost = creditPerImage * count

  async function handleGenerate(e?: React.FormEvent) {
    if (e) e.preventDefault()
    if (!prompt.trim()) {
      setErrorMessage('请输入生图提示词')
      return
    }
    if (!activeModelId) {
      setErrorMessage('请选择生成模型')
      return
    }
    setErrorMessage('')

    try {
      const job = await createJobMutation.mutateAsync({
        modelId: activeModelId,
        prompt: prompt.trim(),
        parameters: {
          count,
          size,
          quality,
        },
      })
      setSelectedJobId(job.id)
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
    <div className="flex h-full w-full flex-1 overflow-hidden">
      {/* Left: Interactive Generation Studio */}
      <div className="flex flex-1 flex-col overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6">
          {/* Prompt & Input Box */}
          <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-sm transition-all focus-within:border-accent">
            <textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="描述你想生成的画面内容，例如：赛博朋克风格未来雨夜街道，霓虹灯倒影，8k高细节..."
              className="w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />

            {/* Controls Bar */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
              <div className="flex flex-wrap items-center gap-2">
                {/* Model Selector */}
                <select
                  value={activeModelId}
                  onChange={(e) => setSelectedModelId(e.target.value)}
                  className="rounded-[var(--radius-control)] border border-border bg-surface-subtle px-2.5 py-1.5 text-xs font-medium text-foreground outline-none hover:bg-surface-subtle-strong"
                >
                  {modelsLoading && <option>加载模型中...</option>}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName} ({m.creditsPerImage}积分/张)
                    </option>
                  ))}
                </select>

                {/* Aspect Ratio / Size */}
                <select
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  className="rounded-[var(--radius-control)] border border-border bg-surface-subtle px-2.5 py-1.5 text-xs font-medium text-foreground outline-none hover:bg-surface-subtle-strong"
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
              </div>

              {/* Generate Button & Cost */}
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Coins className="h-3.5 w-3.5 text-credit" />
                  消耗 <span className="text-foreground">{totalCreditCost}</span> 积分
                </span>

                <button
                  type="button"
                  onClick={() => handleGenerate()}
                  disabled={createJobMutation.isPending || isJobActive}
                  className="flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] bg-accent px-5 text-sm font-medium text-accent-contrast shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {createJobMutation.isPending || isJobActive ? (
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

          {/* Main Stage Display Area */}
          <div className="flex flex-1 flex-col items-center justify-center rounded-[var(--radius-card)] border border-border bg-surface-subtle/40 p-6">
            {selectedJob ? (
              <div className="flex w-full flex-col gap-4">
                {/* Header of selected job */}
                <div className="flex items-center justify-between border-b border-border/80 pb-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${
                        selectedJob.status === 'succeeded'
                          ? 'bg-success-soft text-success'
                          : selectedJob.status === 'failed'
                            ? 'bg-danger-soft text-danger'
                            : selectedJob.status === 'running'
                              ? 'bg-accent-soft text-accent'
                              : 'bg-surface-subtle text-muted-foreground'
                      }`}
                    >
                      {selectedJob.status}
                    </span>
                    <span className="text-xs text-muted-foreground">{selectedJob.modelName}</span>
                    <span className="text-xs text-muted-foreground">·</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {new Date(selectedJob.createdAt).toLocaleTimeString()}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {isJobActive && (
                      <button
                        type="button"
                        onClick={() => cancelJobMutation.mutate(selectedJob.id)}
                        disabled={cancelJobMutation.isPending}
                        className="flex items-center gap-1 rounded-[var(--radius-control)] border border-border px-2.5 py-1 text-xs text-danger hover:bg-danger-soft/20"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        取消任务
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

                {/* Job Content / Assets */}
                {selectedJob.status === 'succeeded' && selectedJob.assets && selectedJob.assets.length > 0 ? (
                  <div
                    className={`grid gap-4 ${
                      selectedJob.assets.length === 1
                        ? 'grid-cols-1 max-w-lg mx-auto'
                        : selectedJob.assets.length === 2
                          ? 'grid-cols-2'
                          : 'grid-cols-2 sm:grid-cols-2 md:grid-cols-4'
                    }`}
                  >
                    {selectedJob.assets.map((asset) => (
                      <div
                        key={asset.id}
                        className="group relative overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface"
                      >
                        <img
                          src={asset.url}
                          alt={selectedJob.prompt}
                          className="h-auto w-full object-cover transition-transform duration-300 group-hover:scale-105"
                          loading="lazy"
                        />
                        <div className="absolute inset-0 flex items-end justify-end bg-black/40 p-2 opacity-0 transition-opacity group-hover:opacity-100">
                          <a
                            href={asset.url}
                            target="_blank"
                            rel="noreferrer"
                            download
                            className="rounded bg-surface/90 p-1.5 text-foreground hover:bg-surface shadow"
                            title="下载原图"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : isJobActive ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <Loader2 className="h-8 w-8 animate-spin text-accent" />
                    <p className="mt-3 text-sm font-medium text-foreground">AI 正在绘制画面...</p>
                    <p className="mt-1 text-xs text-muted-foreground">任务正在后端集群队列调度中</p>
                  </div>
                ) : selectedJob.status === 'failed' ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center text-danger">
                    <p className="font-semibold text-sm">生成未完成</p>
                    <p className="mt-1 text-xs max-w-md">{selectedJob.errorMessage || '未知生成错误'}</p>
                  </div>
                ) : (
                  <div className="py-12 text-center text-xs text-muted-foreground">暂无可用生成画面</div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Brush className="h-10 w-10 text-muted-foreground/50" />
                <p className="mt-3 text-sm font-medium text-foreground">准备就绪，开始创作</p>
                <p className="mt-1 text-xs text-muted-foreground">在上方输入创意提示词，点击「立即生成」</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right: History Gallery Panel */}
      <div
        className={`border-l border-border bg-surface transition-all duration-200 ${
          historyOpen ? 'w-72 shrink-0' : 'w-0 overflow-hidden border-l-0'
        } hidden md:flex md:flex-col`}
      >
        <div className="flex h-14 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-semibold text-foreground">历史记录</span>
          </div>
          <button
            type="button"
            onClick={() => setHistoryOpen(false)}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            title="收起历史面板"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {jobsLoading ? (
            <div className="py-12 text-center text-xs text-muted-foreground">
              <Loader2 className="mx-auto h-4 w-4 animate-spin" />
            </div>
          ) : jobs.length > 0 ? (
            jobs.map((j) => {
              const isSelected = j.id === (selectedJob?.id || '')
              const firstThumb = j.assets?.[0]?.url
              return (
                <div
                  key={j.id}
                  onClick={() => setSelectedJobId(j.id)}
                  className={`flex cursor-pointer gap-3 rounded-[var(--radius-control)] border p-2.5 transition-all ${
                    isSelected
                      ? 'border-accent bg-surface-subtle shadow-xs'
                      : 'border-border/60 bg-surface hover:border-border hover:bg-surface-subtle/50'
                  }`}
                >
                  <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-surface-subtle flex items-center justify-center">
                    {firstThumb ? (
                      <img src={firstThumb} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-[10px] text-muted-foreground uppercase">
                        {j.status.slice(0, 3)}
                      </span>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col justify-center">
                    <p className="truncate text-xs font-medium text-foreground">{j.prompt}</p>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>{j.modelName}</span>
                      <span
                        className={
                          j.status === 'succeeded'
                            ? 'text-success'
                            : j.status === 'failed'
                              ? 'text-danger'
                              : 'text-accent'
                        }
                      >
                        {j.status}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })
          ) : (
            <div className="py-12 text-center text-xs text-muted-foreground">暂无生成记录</div>
          )}
        </div>
      </div>

      {/* Floating button to reopen history panel if closed */}
      {!historyOpen && (
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="absolute right-4 top-20 hidden md:flex items-center gap-1 rounded-[var(--radius-control)] border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground shadow hover:bg-surface-subtle"
          title="展开历史面板"
        >
          <PanelRightOpen className="h-3.5 w-3.5" />
          历史
        </button>
      )}
    </div>
  )
}
