'use client'

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ImageIcon, SparkleIcon, VideoCameraIcon, PaperclipIcon, RobotIcon } from '@phosphor-icons/react'
import { Alert, Badge, Button, Field, Input, Select, Skeleton, Textarea } from '@/shared/components/ui'
import { useModels } from '@/shared/hooks/useModels'
import { useJobs, useSeedCreatedJob } from '@/shared/hooks/useJobs'
import { queryKeys } from '@/shared/hooks/query-keys'
import { clientApi } from '@/shared/services/client-api'
import { resolveActiveModel } from '@/shared/lib/model-capabilities'
import { buildMediaParameters, canonicalNameOf, descriptorLabel, descriptorOptions, effectiveValue, marshalDescriptorValue, mediaControlDescriptors, parameterIssues, reconcileModelParameters, resolveDescriptor } from '@/shared/lib/media-parameters'
import { newIdempotencyKey, toGenerationRequest } from '@/shared/lib/generation-params'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import type { GenerationJobDto, ParameterDescriptor, ParameterState, PublicModelDto } from '@/shared/types'
import type { WorkspaceMode } from '@/shared/lib/workspace-mode'
import { useComposerStore } from '../stores/composer-store'
import { imageModelBlockReason, promptIssue, PROMPT_LIMIT } from '../lib/generate-form'
import { GenerationTask } from './generation-task'
import { consumeReuseQuery, reuseKindBlockReason } from '../lib/generate-reuse'

const EXAMPLES = [
  { label: '静物摄影', prompt: '一只手工陶瓷花瓶，搭配一枝橄榄，温暖的自然侧光，奶油色背景，细腻颗粒感，极简静物摄影。' },
  { label: '建筑空间', prompt: '山间一座安静的现代木屋，落地窗映出森林，清晨薄雾，柔和自然光，建筑摄影，克制而温暖。' },
  { label: '灵感插画', prompt: '一座漂浮在云端的小花园，弯曲的小径与温室，低饱和色彩，细腻的纸张肌理，充满想象力的编辑插画。' },
]

const subscribeHydration = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false

function ParameterControl({ model, descriptor, values, onChange }: { model: PublicModelDto; descriptor: ParameterDescriptor; values: ParameterState; onChange: (name: string, value: string | number | boolean) => void }) {
  const name = canonicalNameOf(descriptor)
  const value = values[name] ?? values[descriptor.name] ?? effectiveValue(model, descriptor, values)
  const options = descriptorOptions(descriptor).filter((option) => name !== 'count' || typeof option.value !== 'number' || option.value <= model.maxCount)
  return <Field label={descriptorLabel(descriptor, model)}>
    {descriptor.type === 'number' || descriptor.type === 'integer' ? <Input type="number" min={descriptor.min} max={name === 'count' ? Math.min(descriptor.max ?? model.maxCount, model.maxCount) : descriptor.max} step={descriptor.step ?? (descriptor.type === 'integer' ? 1 : 'any')} value={value === undefined ? '' : String(value)} onChange={(event) => onChange(name, event.target.value === '' ? '' : Number(event.target.value))} /> : <Select value={value === undefined ? '' : String(value)} onChange={(event) => onChange(name, marshalDescriptorValue(descriptor, event.target.value))}>
      {value === undefined && <option value="">使用模型默认值</option>}
      {value !== undefined && !options.some((option) => String(option.value) === String(value)) && <option value={String(value)}>{String(value)} · 当前值</option>}
      {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
    </Select>}
  </Field>
}

export function GenerateView({ mode }: { mode: WorkspaceMode }) {
  // The persistent shell can fill the jobs cache before this page hydrates.
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot)
  const reuseQuery = useSearchParams().toString()
  const modelsQuery = useModels()
  const jobsQuery = useJobs()
  const queryClient = useQueryClient()
  const seedJob = useSeedCreatedJob()
  const selectedId = useGenerateUiStore((state) => state.selectedModelIdByKind.image)
  const params = useGenerateUiStore((state) => state.paramsByKind.image)
  const setSelectedModel = useGenerateUiStore((state) => state.setSelectedModel)
  const setParam = useGenerateUiStore((state) => state.setParam)
  const replaceParams = useGenerateUiStore((state) => state.replaceParams)
  const prompt = useComposerStore((state) => state.prompt)
  const setPrompt = useComposerStore((state) => state.setPrompt)
  const requestedKind = useComposerStore((state) => state.requestedKind)
  const lastReuseQuery = useComposerStore((state) => state.lastReuseQuery)
  const consumeQuery = useComposerStore((state) => state.consumeQuery)
  const setRequestedKind = useComposerStore((state) => state.setRequestedKind)
  // Gate the new URL immediately, including the render before its effect commits.
  const reuseBlockReason = reuseKindBlockReason(consumeReuseQuery({ prompt, requestedKind, lastReuseQuery }, reuseQuery).requestedKind)
  const [validation, setValidation] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const submitting = useRef(false)
  const requestIdentity = useRef<{ signature: string; key: string } | null>(null)
  const modelOptions = (modelsQuery.data ?? []).filter((model) => model.modelKind === 'image' && model.enabled && !model.deprecated)
  const model = resolveActiveModel(modelOptions, 'image', selectedId)
  const blockReason = imageModelBlockReason(model)
  const effectiveParams = buildMediaParameters(model, params)
  const issues = parameterIssues(model, params)
  const countDescriptor = resolveDescriptor(model, 'count')
  const controls = [...mediaControlDescriptors(model, effectiveParams), ...(countDescriptor ? [countDescriptor] : [])]
  const jobs = hydrated ? jobsQuery.data?.items ?? [] : []
  const jobsLoading = !hydrated || jobsQuery.isLoading
  const jobsError = hydrated && jobsQuery.isError

  // The draft survives navigation, but a reuse URL is consumed only for this
  // mount. Returning from the library with the same asset is a fresh intent.
  useEffect(() => () => consumeQuery(''), [consumeQuery])

  useEffect(() => {
    consumeQuery(reuseQuery)
    setValidation(null)
  }, [reuseQuery, consumeQuery])

  const create = useMutation({
    mutationFn: clientApi.generations.create,
    onSuccess: (job) => {
      seedJob(job)
      setNotice('任务已提交。你可以继续编辑提示词，结果会自动更新。')
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.root })
      if (job.outputs.length) void queryClient.invalidateQueries({ queryKey: queryKeys.library.root })
      requestIdentity.current = null
    },
  })

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || create.isPending) return
    const count = countDescriptor ? effectiveParams[countDescriptor.name] : undefined
    const countProblem = typeof count === 'number' && count > (model?.maxCount ?? 1) ? `当前模型最多一次生成 ${model?.maxCount} 张图片。` : null
    const problem = reuseBlockReason || promptIssue(prompt) || blockReason || issues[0]?.message || countProblem || null
    setValidation(problem)
    if (problem || !model) { promptRef.current?.focus(); return }
    const signature = JSON.stringify({ prompt: prompt.trim(), model: model.id, parameters: effectiveParams })
    if (requestIdentity.current?.signature !== signature) requestIdentity.current = { signature, key: newIdempotencyKey() }
    submitting.current = true
    setNotice('')
    try {
      await create.mutateAsync(toGenerationRequest({ modelId: model.id, prompt, parameters: effectiveParams, idempotencyKey: requestIdentity.current!.key }))
    } catch { /* Mutation retains error and draft; retry preserves idempotency key. */ }
    finally { submitting.current = false }
  }

  function reuse(job: GenerationJobDto) {
    setPrompt(job.inputPrompt || job.prompt)
    setRequestedKind(job.mediaKind)
    const match = modelOptions.find((candidate) => candidate.id === job.modelId)
    if (match) {
      setSelectedModel('image', match.id)
      replaceParams('image', reconcileModelParameters(match, job.parameters as ParameterState | undefined))
    }
    setValidation(null)
    setNotice('已将提示词填入创作区；请确认参数后生成。')
    promptRef.current?.focus()
    promptRef.current?.scrollIntoView({ behavior: 'auto', block: 'center' })
  }

  return <div className="min-w-0 space-y-8">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-2"><p className="text-overline text-muted-foreground">CREATE / 图像创作</p><h1 className="text-title text-foreground">让灵感，有迹可循。</h1><p className="text-sm text-muted-foreground">从一句描述开始，慢慢靠近你想象中的画面。</p></div>
      <Badge tone={mode === 'mock' ? 'warning' : 'neutral'}>{mode === 'mock' ? 'MOCK · 本地示例' : '已连接真实服务'}</Badge>
    </div>
    {mode === 'mock' && <Alert tone="warning" title="当前为独立演示模式">生成操作只模拟任务并展示本地示例图片，不会调用供应商、不产生真实作品，也不会上传文件。示例数据保存在当前浏览器，不会与真实服务同步；多个标签页之间不会实时同步。</Alert>}
    <div className="grid min-w-0 items-start gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
      <section aria-labelledby="composer-heading" className="min-w-0 space-y-5 rounded-panel bg-surface p-5 shadow-soft sm:p-6">
        <div className="flex items-center gap-2"><ImageIcon className="size-5 text-accent-strong" aria-hidden="true" /><h2 id="composer-heading" className="text-module text-foreground">创作一张图片</h2></div>
        <form onSubmit={submit} className="space-y-5" noValidate>
          {reuseBlockReason && <Alert tone="warning" title={requestedKind === 'video' ? '视频创作尚未支持' : '请确认创作类型'} action={<Button size="sm" variant="secondary" onClick={() => { setRequestedKind('image'); setValidation(null) }}>改为图片创作</Button>}>{reuseBlockReason}</Alert>}
          <Field label="画面描述" required hint="写下主体、环境、光线与风格。描述越具体，方向越清晰。" error={validation && promptIssue(prompt) ? validation : undefined}>
            <Textarea ref={promptRef} rows={7} maxLength={PROMPT_LIMIT} value={prompt} placeholder="例如：一束午后阳光落在木桌上，陶瓷杯、翻开的书，温暖安静的胶片摄影……" onChange={(event) => { setPrompt(event.target.value); setValidation(null); if (!create.isPending) create.reset() }} className="min-h-44 resize-y" />
          </Field>
          <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">试试这些灵感</span>{EXAMPLES.map((example) => <Button key={example.label} variant="secondary" size="sm" onClick={() => { setPrompt(example.prompt); setValidation(null); promptRef.current?.focus() }}>{example.label}</Button>)}</div>
          {modelsQuery.isLoading ? <div aria-busy="true" aria-label="加载模型"><Skeleton className="h-12 w-full" /></div> : modelsQuery.isError ? <Alert tone="danger" title="无法加载模型" action={<Button size="sm" variant="secondary" onClick={() => void modelsQuery.refetch()}>重新加载</Button>}>请检查连接后重试，草稿不会丢失。</Alert> : <>
            <Field label="图像模型"><Select value={model?.id ?? ''} disabled={!modelOptions.length || create.isPending} onChange={(event) => { const next = modelOptions.find((candidate) => candidate.id === event.target.value); setSelectedModel('image', event.target.value); replaceParams('image', reconcileModelParameters(next, params)); setValidation(null) }}>
              {!modelOptions.length && <option value="">暂无可用模型</option>}{modelOptions.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}{candidate.isDefault ? ' · 默认' : ''}</option>)}
            </Select></Field>
            {model && <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">{controls.map((descriptor) => <ParameterControl key={`${model.id}-${descriptor.name}`} model={model} descriptor={descriptor} values={params} onChange={(name, value) => { setParam('image', name, value); setValidation(null) }} />)}</div>}
            {!countDescriptor && model && <p className="text-xs text-muted-foreground">数量与未开放的参数使用模型默认值。</p>}
            {blockReason && <Alert tone="warning">{blockReason}</Alert>}
          </>}
          {validation && !promptIssue(prompt) && <Alert tone="danger">{validation}</Alert>}
          {create.isError && <Alert tone="danger" title="提交未成功">{create.error instanceof Error ? create.error.message : '请稍后重试。'} 草稿已保留；你可以重新提交。</Alert>}
          <Button type="submit" fullWidth size="lg" loading={create.isPending} disabled={modelsQuery.isLoading || modelsQuery.isError || Boolean(blockReason) || Boolean(reuseBlockReason)} icon={<SparkleIcon aria-hidden="true" className="size-5" />}>{mode === 'mock' ? '生成示例图片' : '开始生成'}</Button>
          <p role="status" className="break-words text-xs text-muted-foreground">{notice || (mode === 'mock' ? '示例结果与提示词无关，仅用于体验工作流。' : '提交后在右侧查看任务状态；成功作品会同步到图库。')}</p>
        </form>
        <div className="space-y-3 border-t border-border pt-5"><p id="unsupported-note" className="text-xs text-muted-foreground">当前仅支持文生图。以下能力尚未接入此工作台。</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled aria-describedby="unsupported-note" icon={<VideoCameraIcon aria-hidden="true" className="size-4" />}>视频</Button><Button size="sm" variant="ghost" disabled aria-describedby="unsupported-note" icon={<PaperclipIcon aria-hidden="true" className="size-4" />}>上传参考图</Button><Button size="sm" variant="ghost" disabled aria-describedby="unsupported-note" icon={<RobotIcon aria-hidden="true" className="size-4" />}>Agent</Button></div></div>
      </section>
      <section aria-labelledby="results-heading" className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="results-heading" className="text-module text-foreground">最近创作</h2><p className="mt-1 text-xs text-muted-foreground">任务与作品 · 进行中的任务会自动更新</p></div><Button size="sm" variant="ghost" loading={refreshing} onClick={async () => { setRefreshing(true); try { await jobsQuery.refetch() } finally { setRefreshing(false) } }}>刷新列表</Button></div>
        {jobsLoading && <div className="space-y-4" aria-busy="true" aria-label="加载创作记录"><Skeleton className="h-64 w-full rounded-panel" /><Skeleton className="h-32 w-full rounded-panel" /></div>}
        {jobsError && <Alert tone="danger" title="创作记录加载失败" action={<Button size="sm" variant="secondary" onClick={() => void jobsQuery.refetch()}>重试</Button>}>请检查网络连接。当前提示词与参数不会丢失。</Alert>}
        {!jobsLoading && !jobsError && jobs.length === 0 && <div className="flex min-h-80 flex-col items-center justify-center rounded-panel bg-tonal p-8 text-center"><ImageIcon aria-hidden="true" className="mb-5 size-10 text-muted-foreground" /><h3 className="text-module text-foreground">留一块空白，给新灵感。</h3><p className="mt-3 max-w-sm text-sm text-muted-foreground">输入画面描述，再点击生成。你的第一张作品将在这里出现。</p><Button variant="secondary" className="mt-5" onClick={() => promptRef.current?.focus()}>开始描述画面</Button></div>}
        {jobs.map((job) => <GenerationTask key={job.id} job={job} onReuse={reuse} />)}
        {jobsQuery.data?.hasMore && <p className="text-center text-xs text-muted-foreground">这里只显示最近的任务；更多已完成作品可在图库查看。</p>}
      </section>
    </div>
  </div>
}
