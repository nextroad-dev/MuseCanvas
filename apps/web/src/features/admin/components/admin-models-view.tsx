'use client'

import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ArrowClockwiseIcon,
  CpuIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  StarIcon,
  TrashIcon,
} from '@phosphor-icons/react'

import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FieldGroup,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  TableBody,
  TableCell,
  TableHeadCell,
  TableHeader,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import type { BadgeTone, SegmentedControlItem } from '@/shared/components/ui'
import {
  useAdminMediaModelDefaults,
  useAdminModelPresets,
  useAdminModels,
  useAdminPlugins,
  useAdminProviderCredentials,
  useCreateAdminModel,
  useDeleteAdminModel,
  useUpdateAdminMediaModelDefaults,
  useUpdateAdminModel,
} from '@/shared/hooks/useAdmin'
import { isApiError } from '@/shared/services/client-api'
import type {
  AdminModelDto,
  AdminModelInput,
  ModelKind,
  ModelPresetDto,
  ReasoningEffort,
} from '@/shared/types'
import { MediaModelErrorCode } from '@/shared/types'

type KindFilter = 'all' | ModelKind
type CreatePathMode = 'preset' | 'plugin'

const KIND_FILTER_ITEMS: SegmentedControlItem<KindFilter>[] = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图像' },
  { value: 'video', label: '视频' },
  { value: 'language', label: '语言' },
]

const CREATE_MODE_ITEMS: SegmentedControlItem<CreatePathMode>[] = [
  { value: 'preset', label: '从预设创建' },
  { value: 'plugin', label: '自定义插件模型' },
]

const MEDIA_KIND_ITEMS: SegmentedControlItem<'image' | 'video'>[] = [
  { value: 'image', label: '图像模型' },
  { value: 'video', label: '视频模型' },
]

const REASONING_EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'none', label: '无 (none)' },
  { value: 'low', label: '低 (low)' },
  { value: 'medium', label: '中 (medium)' },
  { value: 'high', label: '高 (high)' },
  { value: 'xhigh', label: '极高 (xhigh)' },
]

function modelKindLabel(kind: ModelKind): string {
  switch (kind) {
    case 'image':
      return '图像'
    case 'video':
      return '视频'
    case 'language':
      return '语言'
  }
}

function modelKindTone(kind: ModelKind): BadgeTone {
  switch (kind) {
    case 'image':
      return 'info'
    case 'video':
      return 'accent'
    case 'language':
      return 'neutral'
  }
}

function formatModelError(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === MediaModelErrorCode.DEFAULT_MODEL_IN_USE) {
      return '该模型当前是默认生成模型，请先将其他已启用模型设为默认后再停用或删除（409 DEFAULT_MODEL_IN_USE）。'
    }
    if (error.code === MediaModelErrorCode.DEFAULT_MODEL_INVALID) {
      return '无法将该模型设为默认：目标模型必须存在、已启用且类型匹配（DEFAULT_MODEL_INVALID）。'
    }
    return `${error.message} (${error.code})`
  }
  return error instanceof Error ? error.message : '请求失败，请稍后重试。'
}

export function AdminModelsView() {
  const { toast } = useToast()

  const modelsQuery = useAdminModels()
  const presetsQuery = useAdminModelPresets()
  const credentialsQuery = useAdminProviderCredentials()
  const pluginsQuery = useAdminPlugins()
  const defaultsQuery = useAdminMediaModelDefaults()

  const createMutation = useCreateAdminModel()
  const updateMutation = useUpdateAdminModel()
  const deleteMutation = useDeleteAdminModel()
  const updateDefaultsMutation = useUpdateAdminMediaModelDefaults()

  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')

  // 创建 / 编辑弹窗状态
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<AdminModelDto | null>(null)
  const [createMode, setCreateMode] = useState<CreatePathMode>('preset')
  const [formError, setFormError] = useState<string | null>(null)

  // 表单字段
  const [presetId, setPresetId] = useState('')
  const [pluginKey, setPluginKey] = useState('')
  const [pluginId, setPluginId] = useState('')
  const [pluginVersion, setPluginVersion] = useState('')
  const [modelKind, setModelKind] = useState<'image' | 'video'>('image')
  const [providerId, setProviderId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [vendorModelId, setVendorModelId] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [providerCredentialId, setProviderCredentialId] = useState('')
  const [concurrencyLimit, setConcurrencyLimit] = useState('5')
  const [sortOrder, setSortOrder] = useState('0')
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | ''>('')
  const [watermark, setWatermark] = useState(false)
  const [enabled, setEnabled] = useState(true)

  // 删除确认弹窗状态
  const [deleteTarget, setDeleteTarget] = useState<AdminModelDto | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data])
  const presets = useMemo(() => presetsQuery.data ?? [], [presetsQuery.data])
  const credentials = useMemo(() => credentialsQuery.data ?? [], [credentialsQuery.data])
  const plugins = useMemo(() => pluginsQuery.data ?? [], [pluginsQuery.data])
  const defaults = defaultsQuery.data

  const activeMediaPlugins = useMemo(
    () => plugins.filter((p) => p.kind === 'media' && p.status === 'active'),
    [plugins],
  )

  const selectedPreset = useMemo<ModelPresetDto | undefined>(
    () => presets.find((p) => p.id === presetId),
    [presets, presetId],
  )

  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return models.filter((model) => {
      if (kindFilter !== 'all' && model.modelKind !== kindFilter) return false
      if (!q) return true
      return (
        model.displayName.toLowerCase().includes(q) ||
        model.vendorModelId.toLowerCase().includes(q) ||
        (model.providerId ?? '').toLowerCase().includes(q) ||
        (model.pluginId ?? '').toLowerCase().includes(q)
      )
    })
  }, [models, kindFilter, searchQuery])

  const defaultImageModel = useMemo(
    () => models.find((m) => m.id === defaults?.imageModelId || (m.modelKind === 'image' && m.isDefault)),
    [models, defaults?.imageModelId],
  )
  const defaultVideoModel = useMemo(
    () => models.find((m) => m.id === defaults?.videoModelId || (m.modelKind === 'video' && m.isDefault)),
    [models, defaults?.videoModelId],
  )

  function handleSelectPreset(nextPresetId: string) {
    setPresetId(nextPresetId)
    const found = presets.find((p) => p.id === nextPresetId)
    if (found) {
      setConcurrencyLimit(String(found.concurrencyLimit || 5))
      setReasoningEffort(found.reasoningEffort ?? '')
    }
  }

  function handleSelectPlugin(nextKey: string) {
    setPluginKey(nextKey)
    const found = activeMediaPlugins.find((p) => `${p.pluginId}@${p.pluginVersion}` === nextKey)
    if (found) {
      setPluginId(found.pluginId)
      setPluginVersion(found.pluginVersion)
      if (found.modalities.length === 1) {
        setModelKind(found.modalities[0])
      }
    }
  }

  function openCreateDialog() {
    setEditingModel(null)
    setCreateMode('preset')
    setFormError(null)

    const firstPreset = presets[0]
    setPresetId(firstPreset?.id ?? '')
    setConcurrencyLimit(String(firstPreset?.concurrencyLimit ?? 5))
    setSortOrder('0')
    setReasoningEffort(firstPreset?.reasoningEffort ?? '')
    setProviderCredentialId('')
    setWatermark(false)
    setEnabled(true)

    const firstPlugin = activeMediaPlugins[0]
    setPluginKey(firstPlugin ? `${firstPlugin.pluginId}@${firstPlugin.pluginVersion}` : '')
    setPluginId(firstPlugin?.pluginId ?? '')
    setPluginVersion(firstPlugin?.pluginVersion ?? '')
    setModelKind(firstPlugin?.modalities[0] ?? 'image')
    setProviderId('')
    setDisplayName('')
    setVendorModelId('')
    setBaseUrl('')

    setDialogOpen(true)
  }

  function openEditDialog(model: AdminModelDto) {
    setEditingModel(model)
    setFormError(null)
    setPresetId(model.presetId ?? '')
    setPluginId(model.pluginId ?? '')
    setPluginVersion(model.pluginVersion ?? '')
    setPluginKey(model.pluginId && model.pluginVersion ? `${model.pluginId}@${model.pluginVersion}` : '')
    setModelKind(model.modelKind === 'video' ? 'video' : 'image')
    setProviderId(model.providerId ?? '')
    setDisplayName(model.displayName)
    setVendorModelId(model.vendorModelId)
    setBaseUrl(model.baseUrl)
    setProviderCredentialId(model.providerCredentialId ?? '')
    setConcurrencyLimit(String(model.concurrencyLimit))
    setSortOrder(String(model.sortOrder))
    setReasoningEffort((model.reasoningEffort as ReasoningEffort | undefined) ?? '')
    setWatermark(Boolean(model.watermark))
    setEnabled(Boolean(model.enabled))
    setDialogOpen(true)
  }

  async function handleSetDefault(model: AdminModelDto) {
    if (model.modelKind !== 'image' && model.modelKind !== 'video') return
    try {
      const payload =
        model.modelKind === 'image'
          ? { imageModelId: model.id }
          : { videoModelId: model.id }
      await updateDefaultsMutation.mutateAsync(payload)
      toast.success('默认模型已更新', `已将「${model.displayName}」设为默认${modelKindLabel(model.modelKind)}模型。`)
    } catch (error) {
      toast.error('设置默认模型失败', formatModelError(error))
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)

    const parsedConcurrency = Number.parseInt(concurrencyLimit, 10)
    if (!Number.isFinite(parsedConcurrency) || parsedConcurrency < 1 || parsedConcurrency > 50) {
      setFormError('并发上限必须为 1 到 50 之间的整数。')
      return
    }
    const parsedSortOrder = Number.parseInt(sortOrder, 10)
    if (!Number.isFinite(parsedSortOrder)) {
      setFormError('排序权重必须为有效整数。')
      return
    }

    try {
      if (editingModel) {
        const isPresetBacked = Boolean(editingModel.presetId)
        let input: AdminModelInput
        if (isPresetBacked) {
          if (editingModel.modelKind === 'language' && !providerCredentialId) {
            setFormError('语言模型必须绑定供应商凭据。')
            return
          }
          input = {
            providerCredentialId: providerCredentialId || null,
            concurrencyLimit: parsedConcurrency,
            sortOrder: parsedSortOrder,
            enabled,
            watermark,
            ...(editingModel.modelKind === 'language' && reasoningEffort
              ? { reasoningEffort }
              : {}),
          }
        } else {
          if (!displayName.trim() || !vendorModelId.trim() || !baseUrl.trim()) {
            setFormError('请完整填写显示名称、厂商模型 ID 与接口地址。')
            return
          }
          input = {
            ...(pluginId.trim() ? { pluginId: pluginId.trim() } : {}),
            ...(pluginVersion.trim() ? { pluginVersion: pluginVersion.trim() } : {}),
            ...(providerId.trim() ? { providerId: providerId.trim() } : {}),
            providerCredentialId: providerCredentialId || null,
            displayName: displayName.trim(),
            vendorModelId: vendorModelId.trim(),
            baseUrl: baseUrl.trim(),
            concurrencyLimit: parsedConcurrency,
            sortOrder: parsedSortOrder,
            watermark,
            enabled,
            ...(editingModel.modelKind === 'language' && reasoningEffort
              ? { reasoningEffort }
              : {}),
          }
        }
        await updateMutation.mutateAsync({ id: editingModel.id, input })
        toast.success('模型配置已更新', `「${editingModel.displayName}」修改已保存。`)
        setDialogOpen(false)
        return
      }

      // 新增模型：严格区分 Preset 路径与 Plugin 路径
      if (createMode === 'preset') {
        if (!presetId || !selectedPreset) {
          setFormError('请选择一个内置或插件提供的模型预设。')
          return
        }
        if (selectedPreset.modelKind === 'language' && !providerCredentialId) {
          setFormError('语言模型预设必须绑定一个供应商凭据。')
          return
        }
        // Preset 模式：仅发送允许的预设字段，绝不发送 displayName / vendorModelId / baseUrl 等手工字段
        const presetPayload: AdminModelInput = {
          presetId: selectedPreset.id,
          ...(providerCredentialId ? { providerCredentialId } : {}),
          concurrencyLimit: parsedConcurrency,
          sortOrder: parsedSortOrder,
          enabled,
          watermark,
          ...(selectedPreset.modelKind === 'language' && reasoningEffort
            ? { reasoningEffort }
            : {}),
        }
        const created = await createMutation.mutateAsync(presetPayload)
        toast.success('模型已创建', `已从预设添加「${created.displayName}」。`)
        setDialogOpen(false)
      } else {
        if (!pluginId.trim() || !pluginVersion.trim()) {
          setFormError('请选择已启用的媒体模型插件，或填写插件 ID 与版本。')
          return
        }
        if (!providerId.trim() || !displayName.trim() || !vendorModelId.trim() || !baseUrl.trim()) {
          setFormError('请完整填写供应商标识、显示名称、厂商模型 ID 与接口地址。')
          return
        }
        const pluginPayload: AdminModelInput = {
          pluginId: pluginId.trim(),
          pluginVersion: pluginVersion.trim(),
          modelKind,
          providerId: providerId.trim(),
          displayName: displayName.trim(),
          vendorModelId: vendorModelId.trim(),
          baseUrl: baseUrl.trim(),
          ...(providerCredentialId ? { providerCredentialId } : {}),
          concurrencyLimit: parsedConcurrency,
          sortOrder: parsedSortOrder,
          watermark,
          enabled,
        }
        const created = await createMutation.mutateAsync(pluginPayload)
        toast.success('自定义插件模型已创建', `已添加「${created.displayName}」。`)
        setDialogOpen(false)
      }
    } catch (error) {
      const message = formatModelError(error)
      setFormError(message)
      toast.error(editingModel ? '更新模型失败' : '创建模型失败', message)
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return
    setDeleteError(null)
    try {
      await deleteMutation.mutateAsync(deleteTarget.id)
      toast.success('模型已删除', `「${deleteTarget.displayName}」已移除。`)
      setDeleteTarget(null)
    } catch (error) {
      const message = formatModelError(error)
      setDeleteError(message)
      toast.error('删除模型失败', message)
    }
  }

  const isPresetEditing = Boolean(editingModel?.presetId)
  const isSubmitting = createMutation.isPending || updateMutation.isPending

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="模型配置"
        description="管理图像、视频与语言模型接入、并发上限、凭据关联及默认生成模型。"
        actions={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                void modelsQuery.refetch()
                void defaultsQuery.refetch()
              }}
              loading={modelsQuery.isFetching}
              leadingIcon={<ArrowClockwiseIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              刷新
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={openCreateDialog}
              leadingIcon={<PlusIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              新增模型
            </Button>
          </>
        }
      />

      {modelsQuery.isError ? (
        <Alert
          tone="danger"
          title="模型列表加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void modelsQuery.refetch()}>
              重试
            </Button>
          }
        >
          {formatModelError(modelsQuery.error)}
        </Alert>
      ) : null}

      <Card density="none" className="flex-row flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent"
          >
            <CpuIcon weight="duotone" className={iconSize.sm} />
          </span>
          <div className="flex flex-col">
            <span className="text-ui font-medium text-foreground">默认媒体生成模型</span>
            <span className="text-xs text-muted-foreground">
              创作台新建会话时默认选用的图像与视频模型
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">默认图像模型：</span>
            {defaultImageModel ? (
              <Badge tone="accent" dot>
                {defaultImageModel.displayName}
              </Badge>
            ) : (
              <Badge tone="warning">未设置</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">默认视频模型：</span>
            {defaultVideoModel ? (
              <Badge tone="accent" dot>
                {defaultVideoModel.displayName}
              </Badge>
            ) : (
              <Badge tone="warning">未设置</Badge>
            )}
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label="按模型类型筛选"
          items={KIND_FILTER_ITEMS}
          value={kindFilter}
          onChange={setKindFilter}
          size="sm"
        />
        <div className="relative w-full sm:w-72">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground ${iconSize.sm}`}
          />
          <Input
            size="sm"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索模型名称、厂商 ID 或供应商…"
            aria-label="搜索模型"
            className="pl-9"
          />
        </div>
      </div>

      <DataTable caption="模型配置列表" columns={7} className="[&>table]:min-w-[920px]">
        <TableHeader>
          <TableHeadCell>模型名称</TableHeadCell>
          <TableHeadCell>类型</TableHeadCell>
          <TableHeadCell>供应商 / 插件</TableHeadCell>
          <TableHeadCell>绑定凭据</TableHeadCell>
          <TableHeadCell>并发 / 排序</TableHeadCell>
          <TableHeadCell>状态</TableHeadCell>
          <TableHeadCell align="right">操作</TableHeadCell>
        </TableHeader>
        <TableBody busy={modelsQuery.isFetching}>
          {modelsQuery.isPending ? (
            Array.from({ length: 5 }, (_, index) => (
              <TableSkeletonRow
                key={index}
                cells={[
                  <Skeleton key="name" className="h-5 w-44" />,
                  <Skeleton key="kind" className="h-5 w-16" />,
                  <Skeleton key="provider" className="h-4 w-36" />,
                  <Skeleton key="cred" className="h-4 w-28" />,
                  <Skeleton key="limits" className="h-4 w-20" />,
                  <Skeleton key="status" className="h-5 w-16" />,
                  <Skeleton key="actions" className="ml-auto h-8 w-32" />,
                ]}
              />
            ))
          ) : filteredModels.length === 0 ? (
            <TableStateRow>
              <EmptyState
                density="compact"
                icon={CpuIcon}
                title={models.length === 0 ? '尚未配置任何模型' : '没有匹配的模型'}
                description={
                  models.length === 0
                    ? '可从内置预设一键创建图像、视频或语言模型，也可通过已安装插件自定义接入。'
                    : '请尝试切换模型类型筛选或清空搜索关键词。'
                }
                action={
                  models.length === 0 ? (
                    <Button variant="primary" size="sm" onClick={openCreateDialog}>
                      新增模型
                    </Button>
                  ) : undefined
                }
              />
            </TableStateRow>
          ) : (
            filteredModels.map((model) => {
              const isDefaultModel =
                Boolean(model.isDefault) ||
                (model.modelKind === 'image' && defaults?.imageModelId === model.id) ||
                (model.modelKind === 'video' && defaults?.videoModelId === model.id)
              const canSetDefault =
                model.enabled &&
                (model.modelKind === 'image' || model.modelKind === 'video') &&
                !isDefaultModel

              return (
                <TableRow key={model.id} hover>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-foreground">{model.displayName}</span>
                        {isDefaultModel ? <Badge tone="accent">默认</Badge> : null}
                        {model.deprecated ? (
                          <Badge tone="warning" title={model.deprecationNote}>
                            已弃用
                          </Badge>
                        ) : null}
                        {model.presetId ? (
                          <Badge tone="neutral" variant="outline">
                            预设
                          </Badge>
                        ) : null}
                      </div>
                      <span className="font-mono text-caption text-muted-foreground">
                        {model.vendorModelId}
                      </span>
                    </div>
                  </TableCell>

                  <TableCell>
                    <Badge tone={modelKindTone(model.modelKind)}>{modelKindLabel(model.modelKind)}</Badge>
                  </TableCell>

                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm text-foreground">{model.providerId || model.adapter || '—'}</span>
                      {model.pluginId ? (
                        <span className="font-mono text-caption text-muted-foreground">
                          {model.pluginId}@{model.pluginVersion}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>

                  <TableCell>
                    {model.providerCredentialName ? (
                      <Badge tone="info" variant="soft">
                        {model.providerCredentialName}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">未绑定</span>
                    )}
                  </TableCell>

                  <TableCell mono tabular>
                    <span title="并发上限">{model.concurrencyLimit} 并发</span>
                    <span className="mx-1.5 text-muted-foreground">/</span>
                    <span className="text-muted-foreground" title="排序权重">
                      #{model.sortOrder}
                    </span>
                  </TableCell>

                  <TableCell>
                    <Badge tone={model.enabled ? 'success' : 'neutral'} dot>
                      {model.enabled ? '已启用' : '已停用'}
                    </Badge>
                  </TableCell>

                  <TableCell align="right">
                    <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                      {canSetDefault ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={updateDefaultsMutation.isPending}
                          onClick={() => void handleSetDefault(model)}
                          leadingIcon={<StarIcon weight="bold" aria-hidden="true" className={iconSize.xs} />}
                        >
                          设为默认
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openEditDialog(model)}
                        leadingIcon={<PencilSimpleIcon weight="bold" aria-hidden="true" className={iconSize.xs} />}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:bg-danger-soft hover:text-danger"
                        onClick={() => {
                          setDeleteError(null)
                          setDeleteTarget(model)
                        }}
                        leadingIcon={<TrashIcon weight="bold" aria-hidden="true" className={iconSize.xs} />}
                      >
                        删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </DataTable>

      {/* 新增 / 编辑模型弹窗 */}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        size="wide"
        title={editingModel ? `编辑模型：${editingModel.displayName}` : '新增模型'}
        description={
          editingModel
            ? isPresetEditing
              ? '当前模型由预设创建，可调整绑定凭据、并发上限、排序权重与启用状态。'
              : '修改自定义插件模型的连接参数、凭据绑定与并发策略。'
            : '支持从内置/插件预设快速创建，或基于已激活的媒体插件自定义配置模型。'
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)} disabled={isSubmitting}>
              取消
            </Button>
            <Button type="submit" form="admin-model-form" variant="primary" loading={isSubmitting}>
              {editingModel ? '保存修改' : '确认创建'}
            </Button>
          </>
        }
      >
        <form id="admin-model-form" onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5">
          {formError ? (
            <Alert tone="danger" role="alert" title="无法保存模型配置">
              {formError}
            </Alert>
          ) : null}

          {!editingModel ? (
            <SegmentedControl
              label="模型创建方式"
              items={CREATE_MODE_ITEMS}
              value={createMode}
              onChange={(mode) => {
                setCreateMode(mode)
                setFormError(null)
              }}
              fullWidth
            />
          ) : null}

          <FieldGroup>
            {/* 路径 1：从预设创建（或编辑预设模型） */}
            {(!editingModel && createMode === 'preset') || (editingModel && isPresetEditing) ? (
              <>
                {!editingModel ? (
                  <Field
                    label="模型预设"
                    required
                    hint="预设已内置厂商模型 ID、默认接口地址与参数能力描述。"
                  >
                    <Select
                      value={presetId}
                      onChange={(event) => handleSelectPreset(event.target.value)}
                      required
                    >
                      <option value="" disabled>
                        请选择模型预设…
                      </option>
                      {presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          [{modelKindLabel(preset.modelKind)}] {preset.displayName} ({preset.vendorModelId})
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}

                {(selectedPreset || editingModel) ? (
                  <div className="grid gap-3 rounded-card border border-border bg-canvas p-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs text-muted-foreground">预设标识 / 类型</span>
                      <span className="font-mono text-ui text-foreground">
                        {editingModel?.presetId ?? selectedPreset?.id} ·{' '}
                        {modelKindLabel((editingModel?.modelKind ?? selectedPreset?.modelKind) || 'image')}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs text-muted-foreground">厂商模型 ID</span>
                      <span className="font-mono text-ui text-foreground">
                        {editingModel?.vendorModelId ?? selectedPreset?.vendorModelId}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5 sm:col-span-2">
                      <span className="text-xs text-muted-foreground">默认接口地址</span>
                      <span className="break-all font-mono text-caption text-muted-foreground">
                        {editingModel?.baseUrl ?? selectedPreset?.baseUrl}
                      </span>
                    </div>
                  </div>
                ) : null}

                <Field
                  label="绑定供应商凭据"
                  required={(editingModel?.modelKind ?? selectedPreset?.modelKind) === 'language'}
                  hint={
                    (editingModel?.modelKind ?? selectedPreset?.modelKind) === 'language'
                      ? '语言模型必须绑定已配置的供应商凭据。'
                      : '关联用于调用该模型的供应商密钥凭据。'
                  }
                >
                  <Select
                    value={providerCredentialId}
                    onChange={(event) => setProviderCredentialId(event.target.value)}
                  >
                    <option value="">不绑定凭据</option>
                    {credentials.map((cred) => (
                      <option key={cred.id} value={cred.id}>
                        {cred.displayName} ({cred.providerId || cred.schemaId})
                      </option>
                    ))}
                  </Select>
                </Field>

                {(editingModel?.modelKind ?? selectedPreset?.modelKind) === 'language' ? (
                  <Field
                    label="推理深度 (Reasoning Effort)"
                    hint="可选，覆盖语言模型预设的默认推理强度。"
                  >
                    <Select
                      value={reasoningEffort}
                      onChange={(event) =>
                        setReasoningEffort(event.target.value as ReasoningEffort | '')
                      }
                    >
                      <option value="">使用预设默认值</option>
                      {REASONING_EFFORT_OPTIONS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
              </>
            ) : (
              /* 路径 2：自定义插件模型（或编辑非预设模型） */
              <>
                {!editingModel ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="选择已激活媒体插件"
                      required
                      hint="仅已启用的媒体类插件可用于自定义模型。"
                    >
                      <Select
                        value={pluginKey}
                        onChange={(event) => handleSelectPlugin(event.target.value)}
                      >
                        <option value="">手动输入插件 ID 与版本…</option>
                        {activeMediaPlugins.map((plugin) => {
                          const key = `${plugin.pluginId}@${plugin.pluginVersion}`
                          return (
                            <option key={plugin.id} value={key}>
                              {plugin.displayName} ({key})
                            </option>
                          )
                        })}
                      </Select>
                    </Field>

                    <Field label="模型媒体类型" required>
                      <SegmentedControl
                        label="模型媒体类型"
                        items={MEDIA_KIND_ITEMS}
                        value={modelKind}
                        onChange={setModelKind}
                        fullWidth
                      />
                    </Field>
                  </div>
                ) : null}

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="插件 ID (pluginId)" required>
                    <Input
                      value={pluginId}
                      onChange={(event) => setPluginId(event.target.value)}
                      placeholder="例如 openai-images"
                      required
                    />
                  </Field>
                  <Field label="插件版本 (pluginVersion)" required>
                    <Input
                      value={pluginVersion}
                      onChange={(event) => setPluginVersion(event.target.value)}
                      placeholder="例如 1.0.0"
                      required
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="模型显示名称" required>
                    <Input
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="例如 Flux 1.1 Pro Ultra"
                      required
                    />
                  </Field>
                  <Field label="厂商模型 ID (vendorModelId)" required>
                    <Input
                      value={vendorModelId}
                      onChange={(event) => setVendorModelId(event.target.value)}
                      placeholder="例如 flux-pro-1.1-ultra"
                      required
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="供应商标识 (providerId)" required>
                    <Input
                      value={providerId}
                      onChange={(event) => setProviderId(event.target.value)}
                      placeholder="例如 openai / bfl / dashscope"
                      required
                    />
                  </Field>
                  <Field label="绑定供应商凭据">
                    <Select
                      value={providerCredentialId}
                      onChange={(event) => setProviderCredentialId(event.target.value)}
                    >
                      <option value="">不绑定凭据</option>
                      {credentials.map((cred) => (
                        <option key={cred.id} value={cred.id}>
                          {cred.displayName} ({cred.providerId || cred.schemaId})
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>

                <Field label="接口地址 (baseUrl)" required hint="必须为完整的 HTTPS 端点地址。">
                  <Input
                    type="url"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://api.example.com/v1"
                    required
                  />
                </Field>
              </>
            )}

            {/* 公共字段：并发上限、排序权重、水印与启用开关 */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="并发上限 (1 ~ 50)" required hint="Worker 同时向该模型发起的最大并发任务数。">
                <Input
                  type="number"
                  min={1}
                  max={50}
                  step={1}
                  value={concurrencyLimit}
                  onChange={(event) => setConcurrencyLimit(event.target.value)}
                  required
                />
              </Field>
              <Field label="排序权重 (sortOrder)" required hint="数值越小在模型选择器中越靠前。">
                <Input
                  type="number"
                  step={1}
                  value={sortOrder}
                  onChange={(event) => setSortOrder(event.target.value)}
                  required
                />
              </Field>
            </div>

            <div className="grid gap-3 rounded-card border border-border bg-canvas p-4 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">启用该模型</span>
                  <span className="text-xs text-muted-foreground">停用后前台创作台将隐藏该模型</span>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  aria-label="启用该模型"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">携带平台水印</span>
                  <span className="text-xs text-muted-foreground">向支持水印参数的供应商请求添加水印</span>
                </div>
                <Switch
                  checked={watermark}
                  onCheckedChange={setWatermark}
                  aria-label="携带平台水印"
                />
              </div>
            </div>
          </FieldGroup>
        </form>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="确认删除模型"
        description={
          deleteTarget
            ? `即将删除模型「${deleteTarget.displayName}」（${deleteTarget.vendorModelId}）。已生成的历史任务与资产不受影响。`
            : undefined
        }
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteMutation.isPending}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={deleteMutation.isPending}
              onClick={() => void handleConfirmDelete()}
            >
              确认删除
            </Button>
          </>
        }
      >
        {deleteError ? (
          <Alert tone="danger" role="alert" title="无法删除该模型">
            {deleteError}
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground">
            注意：如果该模型当前被设为默认图像或视频模型，后端会拒绝删除（409 DEFAULT_MODEL_IN_USE），请先指定其他默认模型。
          </p>
        )}
      </Dialog>
    </div>
  )
}
